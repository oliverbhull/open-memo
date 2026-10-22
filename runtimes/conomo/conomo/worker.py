#!/usr/bin/env python3
"""Thin recorder bridge to the independent Conomo streaming runtime."""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time

from conomo.client import SpeechClient
from conomo.bootstrap import ensure_running

def emit(kind, text):
    print(kind + ':' + json.dumps({'processedText': text}), flush=True)


def serve(client, lines):
    last_partial = ''
    print('READY', flush=True)
    for line in lines:
        try:
            message = json.loads(line)
            response = client.request(message)
            kind = message['type']
            if kind in {'start', 'abort'}:
                last_partial = ''
            elif kind == 'audio':
                text = response.get('text', '')
                if text and text != last_partial:
                    emit('PARTIAL', text)
                    last_partial = text
            elif kind == 'end':
                emit('FINAL', response.get('text', ''))
                last_partial = ''
        except (OSError, ConnectionError) as error:
            print('ERROR:' + json.dumps(str(error)), flush=True)
            raise
        except (ValueError, RuntimeError, KeyError) as error:
            print('ERROR:' + json.dumps(str(error)), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', required=True)
    args = parser.parse_args()
    parent = os.getppid()

    def watch_parent():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()
    ensure_running()
    with SpeechClient(source=os.getenv('MEMO_ASR_SOURCE', 'memo')) as client:
        if client.info.get('runtime') != 'Conomo' or not client.info.get('capabilities', {}).get('vocabulary_boosting'):
            raise RuntimeError('Conomo with vocabulary boosting is required')
        if os.getenv('CONOMO_PHRASES'):
            client.request({'type': 'context', 'phrases': json.loads(os.environ['CONOMO_PHRASES'])})
        serve(client, sys.stdin)


if __name__ == '__main__':
    main()
