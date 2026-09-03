#!/usr/bin/env python3
"""Replay reviewed Memo recordings through the locked contextual prototype."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AUDIO_DIR = Path.home() / "Library/Application Support/Memo/audio"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-dir", type=Path, default=DEFAULT_AUDIO_DIR)
    parser.add_argument("--native", type=Path)
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="validate the committed manifest without requiring private audio files",
    )
    return parser.parse_args()


def validate_manifest(manifest: dict[str, object]) -> list[str]:
    failures: list[str] = []
    vocabulary = manifest.get("vocabulary")
    fixtures = manifest.get("fixtures")
    if not isinstance(vocabulary, list) or not vocabulary or not all(isinstance(term, str) and term.strip() for term in vocabulary):
        failures.append("vocabulary must be a non-empty list of terms")
    if not isinstance(fixtures, list) or not fixtures:
        return [*failures, "fixtures must be a non-empty list"]
    required = {
        "name", "audioFile", "sha256", "reviewedSpokenText",
        "expectedGreedy", "expectedContextual", "expectedSelected",
    }
    for index, fixture in enumerate(fixtures):
        if not isinstance(fixture, dict):
            failures.append(f"fixture {index} must be an object")
            continue
        missing = sorted(required.difference(fixture))
        if missing:
            failures.append(f"fixture {index} is missing: {', '.join(missing)}")
        digest = fixture.get("sha256")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            failures.append(f"fixture {index} has an invalid SHA-256")
    return failures


def worker_messages(audio_path: Path, vocabulary: list[str], native: Path | None) -> tuple[list[str], list[str]]:
    source_path = audio_path
    temporary: tempfile.TemporaryDirectory[str] | None = None
    with wave.open(str(audio_path), "rb") as recording:
        audio_format = (recording.getnchannels(), recording.getsampwidth(), recording.getframerate())
    if audio_format != (1, 2, 16000):
        temporary = tempfile.TemporaryDirectory(prefix="memo-contextual-replay-")
        source_path = Path(temporary.name) / "audio.wav"
        subprocess.run(
            ["afconvert", str(audio_path), str(source_path), "-f", "WAVE", "-d", "LEI16@16000", "-c", "1"],
            check=True,
            capture_output=True,
        )
    with wave.open(str(source_path), "rb") as recording:
        pcm = recording.readframes(recording.getnframes())

    environment = os.environ.copy()
    if native is not None:
        environment["MEMO_CONTEXTUAL_NATIVE"] = str(native.resolve())
    process = subprocess.Popen(
        [str(ROOT / "scripts/shell/run-contextual-granite.sh"), "--worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    if process.stdout.readline().strip() != "READY":
        raise RuntimeError("contextual prototype did not become ready")
    messages: list[dict[str, object]] = [
        {"type": "context", "prompt": "Vocabulary: " + ", ".join(vocabulary) + "."},
        {"type": "start"},
    ]
    messages.extend(
        {"type": "audio", "pcm16le": base64.b64encode(pcm[offset : offset + 32000]).decode()}
        for offset in range(0, len(pcm), 32000)
    )
    messages.append({"type": "end"})
    for message in messages:
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()
    final = process.stdout.readline().strip()
    process.stdin.close()
    process.terminate()
    stderr = process.stderr.read().splitlines()
    process.wait(timeout=5)
    if temporary is not None:
        temporary.cleanup()
    if not final.startswith("FINAL:"):
        raise RuntimeError(f"unexpected worker response: {final!r}")
    return [final.removeprefix("FINAL:")], stderr


def observed(stderr: list[str], final_json: str) -> dict[str, object]:
    selected = str(json.loads(final_json)["processedText"])
    decision = next((line for line in reversed(stderr) if line.startswith("CONTEXTUAL: accepted") or line.startswith("CONTEXTUAL: rejected")), "")
    match = re.search(r"greedy=(['\"])(.*?)\1 contextual=(['\"])(.*?)\3$", decision)
    greedy = match.group(2) if match else selected
    contextual = match.group(4) if match else selected
    timing = [line.removeprefix("TIMING:") for line in stderr if line.startswith("TIMING:")]
    return {"greedy": greedy, "contextual": contextual, "selected": selected, "timing": timing}


def main() -> int:
    args = parse_args()
    manifest_path = Path(__file__).with_name("fixtures.json")
    manifest = json.loads(manifest_path.read_text())
    failures = validate_manifest(manifest)
    if args.validate_only:
        if failures:
            print("\n".join(failures), file=sys.stderr)
            return 1
        print(f"validated {len(manifest['fixtures'])} contextual replay fixtures")
        return 0
    for fixture in manifest["fixtures"]:
        audio_path = args.audio_dir / fixture["audioFile"]
        if not audio_path.is_file():
            failures.append(f"{fixture['name']}: missing {audio_path}")
            continue
        digest = hashlib.sha256(audio_path.read_bytes()).hexdigest()
        expected_digest = fixture["sha256"]
        if expected_digest != "TO_BE_CAPTURED" and digest != expected_digest:
            failures.append(f"{fixture['name']}: audio SHA-256 changed")
            continue
        final_lines, stderr = worker_messages(audio_path, manifest["vocabulary"], args.native)
        result = observed(stderr, final_lines[0])
        for key in ("greedy", "contextual", "selected"):
            if result[key] != fixture[f"expected{key.title()}"]:
                failures.append(f"{fixture['name']}: {key} expected {fixture[f'expected{key.title()}']!r}, got {result[key]!r}")
        print(json.dumps({"fixture": fixture["name"], "sha256": digest, **result}, ensure_ascii=False))

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
