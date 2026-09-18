#!/usr/bin/env python3
"""Write a reproducible local manifest for a cleanup-model candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--precision", required=True)
    parser.add_argument("--source-model", required=True)
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--status", default="candidate_not_promoted")
    args = parser.parse_args()

    files = ["model.safetensors", "config.json", "tokenizer.json"]
    missing = [name for name in files if not args.model.joinpath(name).is_file()]
    if missing:
        parser.error(f"model is missing: {', '.join(missing)}")
    manifest = {
        "schema_version": 1,
        "candidate": args.candidate,
        "status": args.status,
        "precision": args.precision,
        "source_model": args.source_model,
        "prompt_sha256": sha256(args.prompt),
        "files": {
            name: {
                "bytes": args.model.joinpath(name).stat().st_size,
                "sha256": sha256(args.model.joinpath(name)),
            }
            for name in files
        },
        "directory_bytes": sum(
            item.stat().st_size for item in args.model.rglob("*") if item.is_file()
        ),
        "promotion_requirements": [
            "human review of every output changed from the 8-bit baseline",
            "latency and memory measurement with ASR active",
            "signed installed-app verification and rollback test",
        ],
    }
    output = args.model / "memo-cleanup-model.json"
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
