#!/usr/bin/env python3
"""Conomo: standalone local ASR service, isolated state per client."""
from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import signal
import socketserver
import sys
import threading
import time

import numpy as np
from .nemotron import Model, PhraseBias
from .models import MANIFEST, verify
from . import __version__

MAX_MESSAGE = 4 * 1024 * 1024


class SharedModel:
    def __init__(self, model_path):
        self.path = str(Path(model_path).resolve())
        self.backend = Model(self.path)
        self.model = self.backend
        self.tokenizer = self.backend.tokenizer
        self.lock = threading.RLock()
        self.memo_owner = None
        self.epoch = 0
        self.quiet_until = 0.0
        self.clients = {}

    def status(self):
        return {'ok': True, 'pid': os.getpid(), 'model': self.path, 'model_loads': 1, 'runtime': 'Conomo', 'runtime_version': __version__, 'model_revision': json.loads(MANIFEST.read_text())['revision'], 'protocol_version': 1,
                'capabilities': {'vocabulary_boosting': True, 'boost_method': 'rnnt-phrase-logit-bias'},
                'sources': list(self.clients.values()), 'dictation_active': self.memo_owner is not None}

    def release(self, client):
        if self.memo_owner is client:
            self.memo_owner = None
            # Let the ambient endpoint drain before accepting a fresh utterance.
            self.quiet_until = time.monotonic() + 1.2

    def execute(self, client, message):
        with self.lock:
            kind = message['type']
            if kind == 'hello':
                source = message.get('source')
                if source not in {'memo', 'memo-device', 'microphone', 'system', 'status'}:
                    raise ValueError('Unknown speech source')
                if client.source is not None:
                    raise ValueError('Source is already set')
                client.source = source
                self.clients[id(client)] = source
                return self.status()
            if client.source is None:
                raise ValueError('Send hello first')
            if kind == 'status':
                return self.status()
            if client.source == 'status':
                raise ValueError('Status client cannot send audio')
            if kind == 'context':
                if 'phrases' not in message and client.structured_context:
                    return {'ok': True, 'vocabulary_boosting': True, 'phrase_count': len(client.phrases)}
                phrases = message.get('phrases')
                if phrases is None:
                    # Compatibility with the recorder's existing vocabulary prompt.
                    import re
                    match = re.search(r'Vocabulary: (.*?)(?:\.(?:\n|$)|$)', message.get('prompt') or '')
                    phrases = [p.strip() for p in match.group(1).split(',')] if match else []
                if not isinstance(phrases, list) or len(phrases) > 256 or any(
                        not isinstance(p, str) or not p.strip() or len(p) > 160 for p in phrases):
                    raise ValueError('Expected at most 256 nonempty phrases of at most 160 characters')
                strength = message.get('strength', 2.0)
                PhraseBias(self.tokenizer, phrases, strength)  # Validate before storing.
                client.structured_context = 'phrases' in message
                client.phrases = list(dict.fromkeys(phrases))
                client.strength = strength
                return {'ok': True, 'vocabulary_boosting': True, 'phrase_count': len(client.phrases)}
            if kind == 'start':
                if client.source == 'memo':
                    if self.memo_owner not in (None, client):
                        raise ValueError('Another Memo dictation is active')
                    self.memo_owner = client
                    self.epoch += 1
                client.session = None
                client.text = ''
                client.epoch = self.epoch
                client.suppressed = client.source == 'microphone' and (
                    self.memo_owner is not None or time.monotonic() < self.quiet_until)
                client.active_phrases = list(client.phrases)
                client.active_strength = client.strength
                client.started = True
                return {'ok': True}
            if kind == 'abort':
                client.session = None
                client.started = False
                self.release(client)
                return {'ok': True}
            if not client.started:
                raise ValueError('Send start before audio or end')
            if client.source == 'microphone' and (client.epoch != self.epoch or self.memo_owner is not None
                                                  or time.monotonic() < self.quiet_until):
                client.suppressed = True
                client.session = None
                client.text = ''
            if kind == 'audio':
                pcm = base64.b64decode(message['pcm16le'], validate=True)
                if len(pcm) % 2:
                    raise ValueError('Expected mono PCM16LE')
                if not client.suppressed and pcm:
                    if client.session is None:
                        def emit(_kind, text, **_metadata):
                            client.text = text
                        client.session = self.backend.session(client.active_phrases, client.active_strength, emit_fn=emit)
                    client.session.feed(np.frombuffer(pcm, dtype='<i2'))
                return {'ok': True, 'text': client.text, 'suppressed': client.suppressed}
            if kind == 'end':
                try:
                    if client.session is not None:
                        client.session.finish()
                    return {'ok': True, 'text': client.text, 'suppressed': client.suppressed}
                finally:
                    client.session = None
                    client.started = False
                    self.release(client)
            raise ValueError(f'Unknown speech operation: {kind!r}')


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.structured_context = False
        self.phrases = []
        self.strength = 2.0
        self.source = None
        self.session = None
        self.started = False
        self.suppressed = False
        self.text = ''
        core = self.server.core
        try:
            while True:
                line = self.rfile.readline(MAX_MESSAGE + 1)
                if not line:
                    break
                if len(line) > MAX_MESSAGE:
                    break
                try:
                    response = core.execute(self, json.loads(line))
                except Exception as error:
                    with core.lock:
                        self.session = None
                        self.started = False
                        core.release(self)
                    response = {'ok': False, 'error': f'{type(error).__name__}: {error}'}
                self.wfile.write((json.dumps(response) + '\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with core.lock:
                self.session = None
                core.release(self)
                core.clients.pop(id(self), None)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_file = open(str(args.socket) + '.lock', 'a')
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    args.socket.unlink(missing_ok=True)
    verify(args.model)
    core = SharedModel(args.model)
    with Server(str(args.socket), Handler) as server:
        os.chmod(args.socket, 0o600)
        server.core = core
        def stop(_sig, _frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print('READY', flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            args.socket.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
