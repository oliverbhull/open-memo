"""Standard-library client for the private, machine-local speech socket."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket

DEFAULT_SOCKET = str(Path.home() / 'Library/Application Support/Conomo/speech.sock')
MAX_MESSAGE = 4 * 1024 * 1024


class SpeechClient:
    def __init__(self, path=None, *, source='memo', timeout=30):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(timeout)
        try:
            self.socket.connect(str(Path(path or os.getenv('CONOMO_SOCKET', os.getenv('MEMO_SPEECH_SOCKET', DEFAULT_SOCKET))).expanduser()))
            self.reader = self.socket.makefile('rb')
            self.info = self.request({'type': 'hello', 'source': source})
        except Exception:
            self.close()
            raise

    def request(self, message):
        self.socket.sendall((json.dumps(message) + '\n').encode())
        line = self.reader.readline(MAX_MESSAGE + 1)
        if not line or len(line) > MAX_MESSAGE:
            raise ConnectionError('Shared speech service disconnected or sent an oversized response')
        response = json.loads(line)
        if not response.get('ok'):
            raise RuntimeError(response.get('error', 'Shared speech request failed'))
        return response

    def close(self):
        if getattr(self, 'reader', None) is not None:
            self.reader.close()
        self.socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
