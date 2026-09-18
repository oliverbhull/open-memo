#!/usr/bin/env python3
"""JSONL experiment worker. Requires explicit local model path; never downloads."""
import argparse
import json
from pathlib import Path
import sys
import time
import resource
from core import CONTRACT, prompt as user_prompt, select
import hashlib


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path)
    parser.add_argument('--adapter', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--identity', action='store_true', help='Protocol test only; not an LFM candidate')
    args = parser.parse_args()
    if args.manifest:
        manifest = json.loads(args.manifest.read_text())
        if manifest['contract'] != CONTRACT['version'] or manifest['status'] != 'internal_formatting_candidate':
            parser.error('Unvalidated contract manifest')
        if args.adapter or args.model: parser.error('Pinned candidates do not allow model/adapter overrides')
        model_root = Path(manifest['model']).resolve()
        required = {str(Path(__file__).resolve()), str(Path(__file__).with_name('core.py').resolve()), str(Path(__file__).with_name('contract.json').resolve())}
        required.update(str((model_root / name).resolve()) for name in ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'])
        required.update(str(p.resolve()) for p in model_root.iterdir() if p.is_file())
        if not required.issubset(manifest['sha256']): parser.error('Incomplete candidate checksum coverage')
        for filename, expected in manifest['sha256'].items():
            digest = hashlib.sha256()
            with Path(filename).open('rb') as handle:
                for block in iter(lambda: handle.read(8 * 1024 * 1024), b''): digest.update(block)
            if digest.hexdigest() != expected: parser.error('Candidate checksum mismatch')
        args.model = Path(manifest['model'])
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
        model, tokenizer = load(str(args.model.resolve()), adapter_path=str(args.adapter) if args.adapter else None)
        model_version = args.model.name
        sampler = make_sampler(temp=0)
        def generate_text(text):
            prompt = tokenizer.apply_chat_template([
                {'role': 'user', 'content': user_prompt(text)},
            ], tokenize=False, add_generation_prompt=True)
            return generate(model, tokenizer, prompt=prompt, max_tokens=min(512, max(64, len(tokenizer.encode(text)) * 2 + 16)), sampler=sampler, verbose=False)
        generate_text('Hello there.')
    emit(dict(type='ready', protocol=1, contract=CONTRACT['version'], model=model_version, adapter='none-or-fused'))
    while True:
        line = sys.stdin.buffer.readline(262144 + 1)
        if not line:
            return
        if len(line) > 262144:
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
            source = request['text']
            vocabulary = request.get('vocabulary', [])
            if not isinstance(source, str) or not source.strip() or len(source) > 20000: raise ValueError('input_bounds')
            if not isinstance(vocabulary, list) or len(vocabulary) > 500 or any(not isinstance(v, str) or not v.strip() or len(v)>200 for v in vocabulary): raise ValueError('vocabulary_bounds')
            candidate = generate_text(source).strip()
            result = select(source, candidate, vocabulary)
            if time.monotonic() > deadline:
                result.update(selected=source, status='fallback', reason='deadline')
            emit(dict(result, id=request['id'], protocol=1, model=model_version, memory=memory()))
        except Exception as error:
            # Exceptions expose types only, never corpus content or stack traces.
            emit(dict(id=request.get('id') if isinstance(request, dict) else None,
                      protocol=1, model=model_version, contract=CONTRACT['version'], status='fallback', reason=type(error).__name__))

if __name__ == '__main__':
    main()
