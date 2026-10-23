"""Exercise the installer's default route with an incompatible service present."""
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
        result = subprocess.run([str(bundle / 'conomo'), '--worker'], input='', capture_output=True, text=True, env=env, timeout=150)
        if result.returncode or result.stdout.strip() != 'READY':
            raise RuntimeError(f'Bundled default startup failed: {result.stdout}\n{result.stderr}')
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
