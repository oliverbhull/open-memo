#!/usr/bin/env python3
"""Local, review-only speech cleanup. Read one transcript per JSONL stdin row."""
import argparse
import json
import os
from pathlib import Path
import time
from core import messages, select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    if not (args.model / 'config.json').is_file():
        parser.error('An existing local MLX model directory is required')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler
    import sys
    model, tokenizer = load(str(args.model.resolve()))
    for line in sys.stdin:
        row = json.loads(line)
        source = row['text']
        if not isinstance(source, str) or not source.strip() or len(source) > 20000:
            raise ValueError('Expected nonempty text of at most 20000 characters')
        prompt = tokenizer.apply_chat_template(messages(source), tokenize=False, add_generation_prompt=True)
        start = time.perf_counter()
        candidate = generate(model, tokenizer, prompt=prompt, max_tokens=512,
                             sampler=make_sampler(temp=0), verbose=False).strip()
        result = select(source, candidate)
        result.update(latency_ms=(time.perf_counter()-start)*1000,
                      model=args.model.name, review_required=True)
        print(json.dumps(result, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
