#!/usr/bin/env python3
"""Thin development broker: tokenize Vocab, then stream to native Core ML."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

from tokenizers import Tokenizer


def vocabulary_from_prompt(prompt: object) -> list[str]:
    if not isinstance(prompt, str):
        return []
    match = re.search(r"(?:^| )Vocabulary: (.*)\.$", prompt)
    if match is None:
        return []
    return list(
        dict.fromkeys(
            term
            for value in match.group(1).split(", ")
            if (term := " ".join(value.strip().split()).casefold())
        )
    )


def token_patterns(tokenizer: Tokenizer, vocabulary: list[str]) -> list[list[int]]:
    patterns: list[list[int]] = []
    seen: set[tuple[int, ...]] = set()
    for term in vocabulary:
        for text in (term, f" {term}"):
            ids = tuple(tokenizer.encode(text, add_special_tokens=False).ids)
            if ids and ids not in seen:
                seen.add(ids)
                patterns.append(list(ids))
    return patterns


def safe_contextual_change(greedy: str, contextual: str, vocabulary: list[str]) -> bool:
    if contextual == greedy:
        return True
    allowed = {term.replace(" ", "") for term in vocabulary}
    before = greedy.casefold().split()
    after = contextual.casefold().split()
    changed = False
    for tag, left_start, left_end, right_start, right_end in difflib.SequenceMatcher(
        a=before, b=after, autojunk=False
    ).get_opcodes():
        if tag == "equal":
            continue
        changed = True
        replacement = "".join(after[right_start:right_end])
        if left_start == left_end or not replacement or replacement not in allowed:
            return False
    return changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--tokenizer-path", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.worker:
        print("error: --worker is required", file=sys.stderr)
        return 2

    tokenizer = Tokenizer.from_file(str(args.tokenizer_path))
    native = subprocess.Popen(
        [
            str(args.native),
            "--model-path", str(args.model_path),
            "--tokenizer-path", str(args.tokenizer_path),
            "--worker",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert native.stdin is not None and native.stdout is not None
    ready = native.stdout.readline().strip()
    if ready != "READY":
        raise RuntimeError(f"native Contextual Granite did not become ready: {ready!r}")
    print("READY", flush=True)
    vocabulary: list[str] = []

    try:
        for line in sys.stdin:
            message = json.loads(line)
            if message.get("type") == "context":
                vocabulary = vocabulary_from_prompt(message.get("prompt"))
                message = {
                    "type": "context",
                    "patterns": token_patterns(tokenizer, vocabulary),
                }
                print(
                    f"CONTEXTUAL: vocabulary={len(vocabulary)} patterns={len(message['patterns'])}",
                    file=sys.stderr,
                    flush=True,
                )
            native.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            native.stdin.flush()
            if message.get("type") == "end":
                response = native.stdout.readline().strip()
                if response.startswith("FINAL:"):
                    payload = json.loads(response.removeprefix("FINAL:"))
                    contextual = str(payload.get("processedText", ""))
                    greedy = str(payload.get("greedyText", contextual))
                    accepted = safe_contextual_change(greedy, contextual, vocabulary)
                    selected = contextual if accepted else greedy
                    if contextual != greedy:
                        print(
                            f"CONTEXTUAL: {'accepted' if accepted else 'rejected unsafe change'} "
                            f"greedy={greedy!r} contextual={contextual!r}",
                            file=sys.stderr,
                            flush=True,
                        )
                    response = "FINAL:" + json.dumps({"processedText": selected})
                print(response, flush=True)
    finally:
        native.stdin.close()
        native.wait(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
