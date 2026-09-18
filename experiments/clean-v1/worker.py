#!/usr/bin/env python3
"""JSONL experiment worker. Requires explicit local model path; never downloads."""
import argparse
import json
from pathlib import Path
import sys
import time
import resource
from core import CONTRACT, protect, select


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path)
    parser.add_argument('--identity', action='store_true', help='Protocol test only; not an LFM candidate')
    args = parser.parse_args()
    model_version = 'identity-test'
    memory = lambda: {}
    if args.identity:
        generate_text = lambda text: text
    else:
        if not args.model or not (args.model / 'config.json').is_file():
            parser.error('An existing local model directory is required')
        import mlx.core as mx
        from mlx_lm import load, generate
        memory = lambda: dict(mlx_peak_bytes=mx.get_peak_memory(), mlx_active_bytes=mx.get_active_memory(), peak_rss_native_units=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        from mlx_lm.sample_utils import make_sampler
        model, tokenizer = load(str(args.model.resolve()))
        model_version = args.model.name
        sampler = make_sampler(temp=0)
        def generate_text(text):
            prompt = tokenizer.apply_chat_template([
                {'role': 'system', 'content': CONTRACT['instruction']},
                {'role': 'user', 'content': text},
            ], tokenize=False, add_generation_prompt=True)
            return generate(model, tokenizer, prompt=prompt, max_tokens=min(512, max(64, len(text))), sampler=sampler, verbose=False)
        generate_text('Hello there.')
    emit(dict(type='ready', protocol=1, contract=CONTRACT['version'], model=model_version, adapter='none-or-fused'))
    while True:
        line = sys.stdin.buffer.readline(CONTRACT['max_frame_bytes'] + 1)
        if not line:
            return
        if len(line) > CONTRACT['max_frame_bytes']:
            return  # Oversized framing is fatal; supervisor retains original.
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('request_shape')
            if request.get('protocol') != 1 or not isinstance(request.get('id'), str):
                raise ValueError('protocol')
            # Unix milliseconds cross the Node/Python boundary; monotonic time enforces generation budget.
            deadline = (time.monotonic() + (request['deadline_unix_ms'] - time.time() * 1000) / 1000
                        if 'deadline_unix_ms' in request else request['deadline'])
            if not isinstance(deadline, (float, int)) or not 0 < deadline - time.monotonic() <= 60:
                raise ValueError('deadline')
            doc = protect(request['text'], request.get('vocabulary', []), request.get('entities', []))
            candidate = generate_text(doc.text)
            result = select(doc, candidate)
            if time.monotonic() > deadline:
                result.update(selected=doc.raw, status='fallback', reason='deadline')
            emit(dict(result, id=request['id'], protocol=1, model=model_version, memory=memory()))
        except Exception as error:
            # Exceptions expose types only, never corpus content or stack traces.
            emit(dict(id=request.get('id') if isinstance(request, dict) else None,
                      protocol=1, model=model_version, contract=CONTRACT['version'], status='fallback', reason=type(error).__name__))

if __name__ == '__main__':
    main()
