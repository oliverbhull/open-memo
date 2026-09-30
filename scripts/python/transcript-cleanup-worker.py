#!/usr/bin/env python3
"""Local LFM transcript cleanup worker with fail-safe original-text fallback."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import sys
import time
from cleanup_completion import complete_output, output_token_budget


from cleanup_prompt import PROMPT_VERSION, chat_messages


MAX_INPUT_CHARACTERS = 20_000


def write_message(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def validate_request(payload: object) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    request_id = payload.get("id")
    text = payload.get("text")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("request id is required")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("transcript text is required")
    if len(text) > MAX_INPUT_CHARACTERS:
        raise ValueError("transcript is too long")
    if payload.get("format", "plain") not in ("plain", "email"):
        raise ValueError("unsupported cleanup format")
    return request_id, text.strip()


def self_test() -> None:
    _, text = validate_request({"id": "test", "text": "ask JTECH for fifty two"})
    assert text == "ask JTECH for fifty two"


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def run_worker(
    model_path: Path,
    adapter_path: Path | None,
    adapter_file: Path | None,
    use_prefix_cache: bool,
) -> None:
    import mlx.core as mx
    from mlx_lm import generate, load, stream_generate
    from mlx_lm.models.cache import make_prompt_cache
    from mlx_lm.sample_utils import make_sampler

    load_kwargs = {"adapter_path": str(adapter_path)} if adapter_path else {}
    model, tokenizer = load(str(model_path), **load_kwargs)
    if adapter_file:
        model.load_weights(str(adapter_file), strict=False)
    sampler = make_sampler(temp=0.0)

    def prompt_tokens(text: str, format: str = "plain") -> list[int]:
        prompt = tokenizer.apply_chat_template(
            chat_messages(text, format),
            tokenize=False,
            add_generation_prompt=True,
        )
        add_special_tokens = tokenizer.bos_token is None or not prompt.startswith(tokenizer.bos_token)
        return tokenizer.encode(prompt, add_special_tokens=add_special_tokens)

    prefix_cache = None
    stable_prefix: list[int] = []
    if use_prefix_cache:
        left = prompt_tokens("AAAA UNIQUE PREFIX PROBE")
        right = prompt_tokens("zzzz unique suffix probe")
        for left_token, right_token in zip(left, right):
            if left_token != right_token:
                break
            stable_prefix.append(left_token)
        if stable_prefix:
            prefix_cache = make_prompt_cache(model)
            model(mx.array(stable_prefix)[None], cache=prefix_cache)
            mx.eval([item.state for item in prefix_cache])
    warmup = tokenizer.apply_chat_template(
        chat_messages("hello there"),
        tokenize=False,
        add_generation_prompt=True,
    )
    generate(model, tokenizer, prompt=warmup, max_tokens=16, sampler=sampler, verbose=False)
    write_message({
        "type": "ready",
        "prompt_version": PROMPT_VERSION,
        "prefix_cache_tokens": len(stable_prefix),
    })

    for line in sys.stdin:
        request_id = "unknown"
        source_text = ""
        model_output = None
        started = time.perf_counter()
        stages: dict[str, float] = {}
        try:
            stage_started = time.perf_counter()
            payload = json.loads(line)
            # Preserve correlation even when text validation rejects the request.
            if isinstance(payload, dict) and isinstance(payload.get("id"), str):
                request_id = payload["id"]
            request_id, source_text = validate_request(payload)
            stages["request"] = elapsed_ms(stage_started)
            stage_started = time.perf_counter()
            tokens = prompt_tokens(source_text, payload.get("format", "plain"))
            cache = None
            if prefix_cache is not None and tokens[:len(stable_prefix)] == stable_prefix:
                cache = copy.deepcopy(prefix_cache)
                tokens = tokens[len(stable_prefix):]
            stages["prompt"] = elapsed_ms(stage_started)
            max_tokens = output_token_budget(len(tokenizer.encode(source_text, add_special_tokens=False)))
            stage_started = time.perf_counter()
            model_output = complete_output(stream_generate(
                model,
                tokenizer,
                prompt=tokens,
                max_tokens=max_tokens,
                sampler=sampler,
                prompt_cache=cache,
            ))
            stages["generation"] = elapsed_ms(stage_started)
            if not model_output:
                raise ValueError("empty model output")
            if len(model_output) > max(len(source_text) * 2, 256):
                raise ValueError("model output exceeded the length bound")
            write_message({
                "id": request_id,
                "text": model_output,
                "candidate_text": model_output,
                "status": "accepted",
                "latency_ms": elapsed_ms(started),
                "stage_ms": stages,
            })
        except (json.JSONDecodeError, ValueError) as error:
            write_message({
                "id": request_id,
                "text": source_text,
                "status": "fallback",
                "reason": type(error).__name__,
                "candidate_text": model_output,
                "error_detail": str(error),
                "latency_ms": elapsed_ms(started),
                "stage_ms": stages,
            })
        except Exception as error:  # Keep the dictation path alive during local testing.
            print(f"cleanup worker error: {type(error).__name__}", file=sys.stderr, flush=True)
            write_message({
                "id": request_id,
                "text": source_text,
                "status": "fallback",
                "reason": "worker_error",
                "candidate_text": model_output,
                "latency_ms": elapsed_ms(started),
                "stage_ms": stages,
            })


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--adapter-file", type=Path)
    parser.add_argument("--prefix-cache", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("LFM cleanup worker self-test passed.")
        return
    if not args.model:
        parser.error("--model is required")
    if bool(args.adapter) != bool(args.adapter_file):
        parser.error("--adapter and --adapter-file must be provided together")
    run_worker(args.model, args.adapter, args.adapter_file, args.prefix_cache)


if __name__ == "__main__":
    main()
