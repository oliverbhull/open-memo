"""Exercise the installer's default route with an incompatible service present."""
import base64
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading

bundle = Path(sys.argv[1]).resolve()
python = str(bundle / 'device-runtime/bin/python3.12')
with tempfile.TemporaryDirectory(prefix='memo-isolation-', dir='/tmp') as home:
    legacy = Path(home) / 'Library/Application Support/Conomo/speech.sock'
    legacy.parent.mkdir(parents=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(legacy))
    server.listen()
    server.settimeout(.2)
    stopped = threading.Event()
    connections = []

    def old_service():
        while not stopped.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            with conn:
                connections.append(True)
                conn.recv(4096)
                conn.sendall((json.dumps({'ok': True, 'runtime': 'Conomo', 'pid': os.getpid()}) + '\n').encode())

    thread = threading.Thread(target=old_service, daemon=True)
    thread.start()
    env = dict(os.environ, HOME=home, PYTHONPATH=str(bundle / 'runtime'))
    env.pop('CONOMO_SOCKET', None)
    env.pop('MEMO_SPEECH_SOCKET', None)
    env['CONOMO_MODEL_DIR'] = str(bundle / 'model')
    try:
        messages = [
            {'type': 'context', 'phrases': ['Project Memo']},
            {'type': 'start'},
            {'type': 'audio', 'pcm16le': base64.b64encode(bytes(6400)).decode()},
            {'type': 'end'},
        ]
        request = ''.join(json.dumps(message) + '\n' for message in messages)
        result = subprocess.run([str(bundle / 'conomo'), '--worker'], input=request, capture_output=True, text=True, env=env, timeout=150)
        lines = result.stdout.splitlines()
        if result.returncode or lines[:1] != ['READY'] or any(line.startswith('ERROR:') for line in lines):
            raise RuntimeError(f'Bundled default startup failed: {result.stdout}\n{result.stderr}')
        finals = [json.loads(line.removeprefix('FINAL:'))['processedText'] for line in lines if line.startswith('FINAL:')]
        if finals != ['']:
            raise RuntimeError(f'Short silence produced text with vocabulary enabled: {finals}')
        if connections:
            raise RuntimeError('Bundled app contacted the incompatible standalone runtime')
        print('Bundled default startup passed with incompatible standalone runtime present.')
    finally:
        # Only stop the server in this isolated test home, never a user service.
        cleanup = "from conomo.bootstrap import runtime_socket; from conomo.client import SpeechClient; import os,signal; c=SpeechClient(str(runtime_socket())); pid=c.info['pid']; c.close(); os.kill(pid,signal.SIGTERM)"
        subprocess.run([python, '-B', '-c', cleanup], env=env, timeout=10, check=False)
        stopped.set()
        thread.join(timeout=1)
        server.close()
