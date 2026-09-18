#!/usr/bin/env python3
"""Compare two cleanup models on local JSONL data without printing transcript text."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time

from cleanup_prompt import INSTRUCTION


PREFIX = f"{INSTRUCTION}\n\nTranscript: "


def load_cases(path: Path, limit: int | None) -> list[dict]:
    cases = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            messages = row.get("messages", [])
            if len(messages) != 2 or not messages[0].get("content", "").startswith(PREFIX):
                raise ValueError(f"row {row.get('id', '?')} does not use the active cleanup prompt")
            cases.append({
                "id": row["id"],
                "source": messages[0]["content"][len(PREFIX):],
                "reference": messages[1]["content"],
            })
            if limit and len(cases) >= limit:
                break
    return cases


def run_model(python: Path, worker: Path, model: Path, cases: list[dict]) -> list[dict]:
    process = subprocess.Popen(
        [str(python), str(worker), "--model", str(model)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdin and process.stdout and process.stderr
    ready = json.loads(process.stdout.readline())
    if ready.get("type") != "ready":
        raise RuntimeError(f"worker did not become ready: {ready}")
    results = []
    try:
        for index, case in enumerate(cases):
            request_id = f"case-{index}"
            process.stdin.write(json.dumps({
                "id": request_id, "text": case["source"], "vocabulary": [],
            }) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            if response.get("id") != request_id:
                raise RuntimeError("worker response order changed")
            results.append(response)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    return results


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * fraction))], 2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    cases = load_cases(args.data, args.limit)
    started = time.perf_counter()
    baseline = run_model(args.python, args.worker, args.baseline, cases)
    candidate = run_model(args.python, args.worker, args.candidate, cases)
    rows = []
    for case, left, right in zip(cases, baseline, candidate, strict=True):
        rows.append({
            **case,
            "baseline": left,
            "candidate": right,
            "same_output": left.get("text") == right.get("text"),
            "baseline_matches_reference": left.get("text") == case["reference"],
            "candidate_matches_reference": right.get("text") == case["reference"],
        })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    changed = [row for row in rows if not row["same_output"]]
    review_path = args.output.with_suffix(".review.html")
    review_sections = []
    for index, row in enumerate(changed, start=1):
        review_sections.append(f"""
        <section>
          <h2>Changed case {index} <small>{html.escape(row['id'])}</small></h2>
          <h3>Raw transcript</h3><pre>{html.escape(row['source'])}</pre>
          <h3>Current 8-bit output</h3><pre>{html.escape(row['baseline'].get('text', ''))}</pre>
          <h3>6-bit candidate</h3><pre>{html.escape(row['candidate'].get('text', ''))}</pre>
          <h3>Historical reference</h3><pre>{html.escape(row['reference'])}</pre>
          <p>Review meaning, usability, names, numbers, negation, attribution, certainty, and question intent.</p>
        </section>""")
    review_path.write_text("""<!doctype html><meta charset="utf-8">
    <title>Private cleanup candidate review</title>
    <style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 24px;background:#111;color:#eee}section{border-top:1px solid #555;padding:24px 0}pre{white-space:pre-wrap;background:#222;padding:14px;border-radius:8px}small{color:#aaa}</style>
    <h1>Private 8-bit vs candidate review</h1>
    <p>This local file contains only cases whose generated output changed. It is not tracked.</p>
    """ + "".join(review_sections), encoding="utf-8")
    baseline_latency = [r["latency_ms"] for r in baseline if isinstance(r.get("latency_ms"), (int, float))]
    candidate_latency = [r["latency_ms"] for r in candidate if isinstance(r.get("latency_ms"), (int, float))]
    report = {
        "cases": len(rows),
        "same_output": sum(row["same_output"] for row in rows),
        "baseline_exact_reference": sum(row["baseline_matches_reference"] for row in rows),
        "candidate_exact_reference": sum(row["candidate_matches_reference"] for row in rows),
        "baseline_fallbacks": sum(r.get("status") != "accepted" for r in baseline),
        "candidate_fallbacks": sum(r.get("status") != "accepted" for r in candidate),
        "baseline_latency_ms": {
            "median": round(statistics.median(baseline_latency), 2),
            "p95": percentile(baseline_latency, 0.95),
        },
        "candidate_latency_ms": {
            "median": round(statistics.median(candidate_latency), 2),
            "p95": percentile(candidate_latency, 0.95),
        },
        "elapsed_seconds": round(time.perf_counter() - started, 2),
        "private_rows": str(args.output),
        "private_review": str(review_path),
        "interpretation": "Exact agreement is diagnostic only; changed outputs require human meaning/usability review.",
    }
    report_path = args.output.with_suffix(".summary.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
