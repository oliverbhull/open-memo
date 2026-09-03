#!/usr/bin/env python3
"""Offline Granite CTC hotword experiment.

This intentionally leaves Granite unchanged. It compares the model's normal
greedy transcript with a small CTC beam search that receives user vocabulary as
hotwords. The experiment is not imported by, packaged with, or called by Memo.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import soundfile as sf
import torch
import torchaudio
from tokenizers import Tokenizer
from transformers import AutoModelForCTC, AutoProcessor

logging.getLogger("pyctcdecode").setLevel(logging.ERROR)
try:
    from pyctcdecode import build_ctcdecoder
except ImportError as error:
    raise SystemExit(
        "pyctcdecode is missing. Follow the one-time setup in "
        "experiments/contextual-ctc/README.md."
    ) from error


DEFAULT_MODEL = Path(
    "/Users/oliverhull/models/asr/huggingface/"
    "granite-speech-5.0-470m-turboctc"
)
SAMPLE_RATE = 16_000
CTC_BLANK_ID = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare Granite greedy and vocabulary-aware CTC decoding."
    )
    parser.add_argument("audio", nargs="?", type=Path, help="Audio file to transcribe")
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"Local Granite model directory (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--vocab",
        action="append",
        default=[],
        metavar="TERM",
        help="Term or phrase to boost; repeat for more than one term",
    )
    parser.add_argument(
        "--vocab-file",
        type=Path,
        help="UTF-8 text file with one term or phrase per line",
    )
    parser.add_argument("--beam-width", type=int, default=4)
    parser.add_argument("--hotword-weight", type=float, default=20.0)
    parser.add_argument(
        "--token-min-logp",
        type=float,
        default=-20.0,
        help="Prune frame-level tokens below this log probability",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps"),
        default="auto",
        help="Inference device; auto prefers Apple Metal when available",
    )
    parser.add_argument(
        "--top-beams",
        type=int,
        default=3,
        help="Number of contextual candidates to display",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Verify Granite tokenizer/decoder alignment without loading the model",
    )
    return parser.parse_args()


def load_vocabulary(cli_terms: Iterable[str], vocab_file: Path | None) -> list[str]:
    terms = list(cli_terms)
    if vocab_file is not None:
        terms.extend(vocab_file.read_text(encoding="utf-8").splitlines())

    normalized: list[str] = []
    seen: set[str] = set()
    for raw in terms:
        term = " ".join(raw.strip().split()).casefold()
        if term and term not in seen:
            normalized.append(term)
            seen.add(term)
    return normalized


def decoder_labels(tokenizer: Tokenizer) -> list[str]:
    """Translate Granite's byte-level word boundary into pyctcdecode's form."""
    labels: list[str] = []
    for token_id in range(tokenizer.get_vocab_size(with_added_tokens=True)):
        token = tokenizer.id_to_token(token_id)
        if token is None:
            raise ValueError(f"Granite tokenizer has no token for id {token_id}")
        if token_id == CTC_BLANK_ID:
            token = ""
        elif token.startswith("Ġ"):
            token = "▁" + token[1:]
        labels.append(token)

    if len(labels) != 16_384:
        raise ValueError(f"Expected Granite's 16,384 labels, found {len(labels):,}")
    if len(labels) != len(set(labels)):
        raise ValueError("Decoder label conversion produced duplicate tokens")
    return labels


def run_self_test(model_path: Path) -> None:
    tokenizer = Tokenizer.from_file(str(model_path / "tokenizer.json"))
    labels = decoder_labels(tokenizer)
    decoder = build_ctcdecoder(labels)

    examples = (
        "i spoke with rayaan",
        "hello world",
        "rayaan at jtech",
    )
    for expected in examples:
        encoded = tokenizer.encode(expected, add_special_tokens=False)
        token_ids = [part for token_id in encoded.ids for part in (token_id, CTC_BLANK_ID)]
        logits = np.full((len(token_ids), len(labels)), -20.0, dtype=np.float32)
        logits[np.arange(len(token_ids)), token_ids] = 20.0
        actual = decoder.decode(logits, beam_width=8)
        if actual != expected:
            raise AssertionError(f"Tokenizer parity failed: {expected!r} != {actual!r}")
    print("Self-test passed: Granite BPE labels and CTC decoding are aligned.")


def select_device(requested: str) -> torch.device:
    if requested == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS was requested but is unavailable")
    if requested == "auto":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    return torch.device(requested)


def load_audio(path: Path) -> np.ndarray:
    samples, source_rate = sf.read(path, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(samples.mean(axis=1)).unsqueeze(0)
    if source_rate != SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, source_rate, SAMPLE_RATE)
    return waveform.squeeze(0).to(torch.float32).numpy()


def greedy_decode(logits: torch.Tensor, processor: object) -> str:
    token_ids = torch.unique_consecutive(logits.argmax(dim=-1)).tolist()
    return processor.decode(token_ids).strip()


def exact_vocabulary_matches(text: str, vocabulary: Iterable[str]) -> list[str]:
    padded = f" {text.casefold()} "
    return [term for term in vocabulary if f" {term} " in padded]


def transcribe(args: argparse.Namespace) -> dict[str, object]:
    if args.audio is None:
        raise ValueError("Provide an audio file, or use --self-test")
    if args.beam_width < 1 or args.beam_width > 64:
        raise ValueError("--beam-width must be between 1 and 64")
    if args.top_beams < 1:
        raise ValueError("--top-beams must be at least 1")
    if not args.audio.is_file():
        raise FileNotFoundError(args.audio)
    if not args.model.is_dir():
        raise FileNotFoundError(args.model)

    vocabulary = load_vocabulary(args.vocab, args.vocab_file)
    device = select_device(args.device)
    started = time.perf_counter()
    processor = AutoProcessor.from_pretrained(
        args.model, trust_remote_code=True, local_files_only=True
    )
    model = AutoModelForCTC.from_pretrained(
        args.model, trust_remote_code=True, local_files_only=True
    )
    # FP32 is the reliable common dtype for CPU and MPS in this experiment.
    model = model.to(device=device, dtype=torch.float32).eval()
    loaded = time.perf_counter()

    audio = load_audio(args.audio)
    prepared = processor([audio], sampling_rate=SAMPLE_RATE, device=device)
    prepared = prepared.to(device=device, dtype=torch.float32)
    with torch.inference_mode():
        logits = model(**prepared).logits[0]
    inferred = time.perf_counter()

    greedy = greedy_decode(logits, processor)
    greedy_finished = time.perf_counter()

    candidates: list[dict[str, object]] = []
    if vocabulary:
        tokenizer = Tokenizer.from_file(str(args.model / "tokenizer.json"))
        decoder = build_ctcdecoder(decoder_labels(tokenizer))
        beams = decoder.decode_beams(
            logits.detach().to(device="cpu", dtype=torch.float32).numpy(),
            beam_width=args.beam_width,
            token_min_logp=args.token_min_logp,
            hotwords=vocabulary,
            hotword_weight=args.hotword_weight,
        )
        for beam in beams[: args.top_beams]:
            candidates.append(
                {
                    "text": beam[0],
                    "acoustic_score": beam[-2],
                    "combined_score": beam[-1],
                    "vocabulary_matches": exact_vocabulary_matches(beam[0], vocabulary),
                }
            )
        contextual = candidates[0]["text"] if candidates else greedy
    else:
        # Empty vocabulary is a strict fail-open path: do not run beam search.
        contextual = greedy
        candidates.append(
            {
                "text": greedy,
                "acoustic_score": None,
                "combined_score": None,
                "vocabulary_matches": [],
            }
        )
    decoded = time.perf_counter()

    return {
        "audio": str(args.audio.resolve()),
        "device": str(device),
        "vocabulary": vocabulary,
        "beam_width": args.beam_width,
        "hotword_weight": args.hotword_weight,
        "token_min_logp": args.token_min_logp,
        "greedy": greedy,
        "contextual": contextual,
        "changed": contextual != greedy,
        "contextual_candidates": candidates,
        "timing_ms": {
            "model_load": round((loaded - started) * 1_000, 1),
            "inference": round((inferred - loaded) * 1_000, 1),
            "greedy_decode": round((greedy_finished - inferred) * 1_000, 1),
            "contextual_decode": round((decoded - greedy_finished) * 1_000, 1),
        },
    }


def print_result(result: dict[str, object]) -> None:
    timing = result["timing_ms"]
    print(f"Greedy:    {result['greedy']}")
    print(f"Contextual:{' ' if result['contextual'] else ''}{result['contextual']}")
    print(f"Changed:   {str(result['changed']).lower()}")
    print("Candidates:")
    for index, candidate in enumerate(result["contextual_candidates"], start=1):
        matches = ", ".join(candidate["vocabulary_matches"]) or "none"
        score = candidate["combined_score"]
        score_text = "n/a" if score is None else f"{score:.3f}"
        print(f"  {index}. {candidate['text']}  score={score_text}  vocab={matches}")
    print(
        "Timing:    "
        f"load={timing['model_load']:.1f} ms  "
        f"inference={timing['inference']:.1f} ms  "
        f"greedy={timing['greedy_decode']:.1f} ms  "
        f"contextual={timing['contextual_decode']:.1f} ms"
    )


def main() -> int:
    logging.getLogger("pyctcdecode").setLevel(logging.ERROR)
    args = parse_args()
    try:
        if args.self_test:
            run_self_test(args.model)
            return 0
        result = transcribe(args)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
