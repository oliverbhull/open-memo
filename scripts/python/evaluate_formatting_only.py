#!/usr/bin/env python3
"""Evaluate the existing punctuation worker without generative rewriting."""
import argparse
import json
from pathlib import Path
import re
import selectors
import subprocess
import time

from evaluate_cleanup_prompt import CASES


def read_line(process, timeout):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise TimeoutError('punctuation worker response timed out')
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('punctuation worker exited')
        return line


def word_sequence(text):
    # Ignore case and sentence punctuation only. Keep contractions, numbers,
    # and technical symbols so content changes cannot count as a pass.
    return [word.strip('.,?!;:').casefold() for word in text.split()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, default=Path('.build/pnc'))
    parser.add_argument('--output', type=Path, default=Path('.build/lfm-hone/formatting-only-comparison'))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cases = CASES + [{
        'id': 'long-600-words', 'source': 'synthetic length stress test',
        'text': ' '.join(f'for task {i} please keep the original schedule and do not confirm without my approval' for i in range(1, 41)),
        'review': 'Keep every numbered instruction, including the final one, across model chunks.',
    }]
    model = next((args.bundle / 'compiled').glob('*.mlmodelc'))
    rows = []
    with args.output.with_suffix('.worker.log').open('w') as errors:
        worker = subprocess.Popen([
            str(args.bundle / 'memo-pnc'), '--model-path', str(model),
            '--vocabulary-path', str(args.bundle / 'tokenizer.vocab'), '--worker',
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True, bufsize=1)
        try:
            assert read_line(worker, 30).strip() == 'READY'
            for case in cases:
                # Measure an initial and warm request; preserve each observation.
                for repeat in range(2):
                    request_id = f"{case['id']}-{repeat}"
                    started = time.perf_counter()
                    worker.stdin.write(json.dumps({'id': request_id, 'text': case['text']}) + '\n')
                    worker.stdin.flush()
                    result = json.loads(read_line(worker, 15))
                    if result['id'] != request_id or result.get('error'):
                        raise RuntimeError(result)
                    row = {**case, 'repeat': repeat, 'output': result['text'],
                           'latency_ms': round((time.perf_counter() - started) * 1000, 2),
                           'words_preserved': word_sequence(case['text']) == word_sequence(result['text']),
                           'current_service_would_skip': bool(re.search(r'[A-Z]|[.!?](?:\s|$)', case['text']))}
                    rows.append(row)
                    print(json.dumps(row), flush=True)
        finally:
            worker.terminate()
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
    args.output.with_suffix('.json').write_text(json.dumps({'model': str(model), 'rows': rows}, indent=2))
    report = ['# Formatting-only comparison', '',
              'Direct existing punctuation-worker output. No LFM, fallback substitution, filler removal, or paragraph postprocessing. Word preservation is checked independently from formatting quality. The app currently skips this worker for inputs with uppercase letters or sentence punctuation; those cases are explicitly marked.', '']
    for row in rows:
        if row['repeat'] != 0:
            continue
        report += ['## ' + row['id'], '', 'Source: ' + row['source'], '',
                   f"Words preserved: {row['words_preserved']}. Current app service would skip: {row['current_service_would_skip']}.", '',
                   '**Review:** ' + row['review'], '', '### Input', '', row['text'], '', '### Output', '', row['output'], '']
    args.output.with_suffix('.md').write_text('\n'.join(report))


if __name__ == '__main__':
    main()
