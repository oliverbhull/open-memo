#!/usr/bin/env python3
"""Persistent JSON-lines worker for the Edge-Punct-Casing ONNX model."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time

import sherpa_onnx


TRAILING_PUNCTUATION = re.compile(r"[,.?]+$")


def word_sequence(text: str) -> list[str]:
    return [TRAILING_PUNCTUATION.sub("", word).casefold() for word in text.split()]


def finalize_utterance(text: str) -> str:
    """Repair only casing consistency and the final boundary; never alter words."""
    tokens = text.split()
    capitalize_next = True
    finalized: list[str] = []
    for token in tokens:
        match = TRAILING_PUNCTUATION.search(token)
        suffix = match.group() if match else ""
        word = token[: match.start()] if match else token
        if len(word) > 1 and word.isupper():
            word = word[:1] + word[1:].lower()
        if capitalize_next and word:
            word = word[:1].upper() + word[1:]
        finalized.append(word + suffix)
        capitalize_next = suffix.endswith((".", "?"))
    if finalized:
        if finalized[-1].endswith(","):
            finalized[-1] = finalized[-1][:-1] + "."
        elif not finalized[-1].endswith((".", "?")):
            finalized[-1] += "."
    return " ".join(finalized)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--vocabulary-path", required=True)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if not args.worker:
        parser.error("--worker is required")

    model_config = sherpa_onnx.OnlinePunctuationModelConfig(
        cnn_bilstm=args.model_path,
        bpe_vocab=args.vocabulary_path,
        num_threads=1,
        provider="cpu",
    )
    punctuator = sherpa_onnx.OnlinePunctuation(
        sherpa_onnx.OnlinePunctuationConfig(model_config=model_config)
    )
    punctuator.add_punctuation_with_case("memo is ready")
    print("READY", flush=True)

    for line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(line)
            request_id = request.get("id", "")
            text = request["text"]
            if not isinstance(request_id, str) or not isinstance(text, str):
                raise ValueError("invalid request")
            started = time.perf_counter()
            formatted = finalize_utterance(punctuator.add_punctuation_with_case(text))
            if word_sequence(formatted) != word_sequence(text):
                raise ValueError("word_sequence_changed")
            elapsed_ms = (time.perf_counter() - started) * 1_000
            print(
                json.dumps({"id": request_id, "text": formatted, "error": None}),
                flush=True,
            )
            print(
                f"TIMING:edge_pnc_ms={elapsed_ms:.1f} words={len(text.split())}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as error:
            print(
                json.dumps({"id": request_id, "text": "", "error": str(error)}),
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
