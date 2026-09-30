#!/usr/bin/env python3
"""Compare Edge-Punct-Casing with the current local PnC on shared Memo cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import selectors
import sqlite3
import subprocess
import statistics
import time

from evaluate_cleanup_prompt import CASES


def read_line(process: subprocess.Popen[str], timeout: float) -> str:
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise TimeoutError("punctuation worker response timed out")
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("punctuation worker exited")
        return line


def request(process: subprocess.Popen[str], request_id: str, text: str) -> tuple[str, float]:
    started = time.perf_counter()
    process.stdin.write(json.dumps({"id": request_id, "text": text}) + "\n")
    process.stdin.flush()
    response = json.loads(read_line(process, 15))
    if response.get("id") != request_id or response.get("error"):
        raise RuntimeError(response)
    return response["text"], (time.perf_counter() - started) * 1_000


def service_eligible(text: str) -> bool:
    return bool(text.strip()) and not re.search(r"[A-Z]|[.!?](?:\s|$)", text)


def output_observations(source: str, output: str) -> dict[str, object]:
    def words(text: str) -> list[str]:
        return [word.strip(".,?").casefold() for word in text.split()]

    return {
        "words_preserved": words(source) == words(output),
        "lowercase_after_stop": bool(re.search(r"[.?]\s+[a-z]", output)),
        "all_caps_token": bool(re.search(r"(?<!\w)[A-Z]{2,}(?!\w)", output)),
        "double_punctuation": bool(re.search(r"[,.?]{2,}", output)),
        "terminal_mark": bool(re.search(r"[.?]$", output.rstrip())),
    }


def private_corpus_summary(
    database: Path,
    limit: int,
    workers: dict[str, subprocess.Popen[str]],
) -> dict[str, object]:
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        records = connection.execute(
            "SELECT context_json FROM memo_entries WHERE deleted_at_ms IS NULL "
            "ORDER BY created_at_ms DESC LIMIT ?",
            (limit * 4,),
        ).fetchall()
    finally:
        connection.close()
    texts = []
    for (context_json,) in records:
        raw = json.loads(context_json).get("rawTranscript")
        if isinstance(raw, str) and service_eligible(raw):
            texts.append(raw)
        if len(texts) == limit:
            break

    summary: dict[str, object] = {"eligible_rows": len(texts), "engines": {}}
    for name, worker in workers.items():
        timings: list[float] = []
        counts = {
            "words_preserved": 0,
            "lowercase_after_stop": 0,
            "all_caps_token": 0,
            "double_punctuation": 0,
            "terminal_mark": 0,
        }
        for index, source in enumerate(texts):
            output, latency_ms = request(worker, f"private-{name}-{index}", source)
            timings.append(latency_ms)
            for key, value in output_observations(source, output).items():
                counts[key] += int(bool(value))
        summary["engines"][name] = {
            **counts,
            "latency_p50_ms": round(statistics.median(timings), 2) if timings else None,
            "latency_p95_ms": round(sorted(timings)[max(0, int(len(timings) * 0.95) - 1)], 2) if timings else None,
        }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edge-dir", type=Path, default=Path(".build/edge-punct-casing"))
    parser.add_argument("--pnc-dir", type=Path, default=Path(".build/pnc"))
    parser.add_argument("--output", type=Path, default=Path(".build/edge-punct-casing/evaluation.json"))
    parser.add_argument("--database", type=Path)
    parser.add_argument("--private-limit", type=int, default=100)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    edge_command = [
        str(args.edge_dir / "venv/bin/python"),
        "scripts/python/edge-punct-worker.py",
        "--model-path", str(args.edge_dir / "model/model.int8.onnx"),
        "--vocabulary-path", str(args.edge_dir / "model/bpe.vocab"),
        "--worker",
    ]
    current_model = next((args.pnc_dir / "compiled").glob("*.mlmodelc"))
    current_command = [
        str(args.pnc_dir / "memo-pnc"),
        "--model-path", str(current_model),
        "--vocabulary-path", str(args.pnc_dir / "tokenizer.vocab"),
        "--worker",
    ]
    workers = {
        "edge": subprocess.Popen(edge_command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1),
        "current": subprocess.Popen(current_command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1),
    }
    rows: list[dict[str, object]] = []
    try:
        for worker in workers.values():
            if read_line(worker, 30).strip() != "READY":
                raise RuntimeError("worker did not become ready")
        for case in CASES:
            if not service_eligible(case["text"]):
                continue
            row: dict[str, object] = {
                "id": case["id"],
                "source": case["source"],
                "input": case["text"],
                "review": case["review"],
            }
            for name, worker in workers.items():
                output, latency_ms = request(worker, f"{case['id']}-{name}", case["text"])
                row[name] = {"output": output, "latency_ms": round(latency_ms, 2)}
            rows.append(row)
            print(json.dumps(row), flush=True)
        private_summary = (
            private_corpus_summary(args.database, args.private_limit, workers)
            if args.database else None
        )
    finally:
        for worker in workers.values():
            worker.terminate()
            worker.wait(timeout=5)
    report = {"rows": rows, "private_summary": private_summary}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    if private_summary:
        print(json.dumps(private_summary, indent=2))


if __name__ == "__main__":
    main()
