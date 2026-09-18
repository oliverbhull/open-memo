"""One-flight supervisor with bounded frames and process-local response identity."""
import json
import os
import select as io_select
import subprocess
import threading
import time
import uuid
from core import CONTRACT

class Client:
    def __init__(self, command, startup_seconds=30):
        self.command = command
        self.startup_seconds = startup_seconds
        self.process = None
        self.buffer = b''
        self.lock = threading.Lock()
        self.ready = None

    def _read(self, deadline):
        while b'\n' not in self.buffer:
            if time.monotonic() >= deadline:
                raise TimeoutError()
            readable, _, _ = io_select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))
            if not readable:
                raise TimeoutError()
            chunk = os.read(self.process.stdout.fileno(), 4096)
            if not chunk:
                raise EOFError()
            self.buffer += chunk
            if len(self.buffer) > CONTRACT['max_frame_bytes']:
                raise ValueError('frame_bounds')
        line, self.buffer = self.buffer.split(b'\n', 1)
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError('response_shape')
        return value

    def start(self):
        with self.lock:
            if self.process is not None:
                return
            try:
                self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, bufsize=0)
                os.set_blocking(self.process.stdin.fileno(), False)
                ready = self._read(time.monotonic() + self.startup_seconds)
                if ready.get('type') != 'ready' or ready.get('protocol') != 1 or ready.get('contract') != CONTRACT['version'] or not isinstance(ready.get('model'), str):
                    raise ValueError('handshake')
                self.ready = ready
            except Exception:
                self._stop()
                raise

    def _stop(self):
        process, self.process = self.process, None
        self.ready, self.buffer = None, b''
        if process is not None:
            process.kill()
            process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()

    def close(self):
        with self.lock:
            self._stop()

    def format(self, text, vocabulary=(), entities=(), timeout=.75):
        fallback = dict(raw=text, candidate=None, selected=text, status='fallback', reason='busy', contract=CONTRACT['version'])
        if not self.lock.acquire(blocking=False):
            return fallback
        try:
            if self.process is None:
                return dict(fallback, reason='not_ready')
            if not isinstance(text, str) or not text.strip() or len(text) > CONTRACT['max_input_characters']:
                return dict(fallback, reason='input_bounds')
            request_id = str(uuid.uuid4())
            deadline = time.monotonic() + timeout
            frame = (json.dumps(dict(protocol=1, id=request_id, text=text, vocabulary=vocabulary,
                                    entities=entities, deadline=deadline)) + '\n').encode()
            if len(frame) > CONTRACT['max_frame_bytes']:
                return dict(fallback, reason='frame_bounds')
            cursor = 0
            while cursor < len(frame):
                _, writable, _ = io_select.select([], [self.process.stdin], [], max(0, deadline - time.monotonic()))
                if not writable or time.monotonic() >= deadline:
                    raise TimeoutError()
                try:
                    cursor += os.write(self.process.stdin.fileno(), frame[cursor:])
                except BlockingIOError:
                    continue
            result = self._read(deadline)
            if result.get('id') != request_id or result.get('protocol') != 1 or result.get('model') != self.ready['model']:
                raise ValueError('response_identity')
            if time.monotonic() > deadline:
                raise TimeoutError()
            if result.get('status') == 'fallback':
                return dict(fallback, candidate=result.get('candidate') if isinstance(result.get('candidate'), str) and len(result['candidate']) <= CONTRACT['max_output_characters'] else None, reason=result.get('reason', 'worker_fallback'), model=self.ready['model'], memory=result.get('memory', {}))
            if result.get('status') != 'accepted' or result.get('raw') != text or not isinstance(result.get('selected'), str) or not result['selected'].strip() or len(result['selected']) > CONTRACT['max_output_characters'] or result.get('contract') != CONTRACT['version']:
                raise ValueError('response_shape')
            return result
        except Exception as error:
            self._stop()  # Kill timed-out generation and queued/stale output before explicit restart.
            return dict(fallback, reason=type(error).__name__)
        finally:
            self.lock.release()
