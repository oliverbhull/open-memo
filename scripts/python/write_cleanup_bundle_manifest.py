#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def record(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    names = [
        "model/model.safetensors", "model/config.json", "model/tokenizer.json",
        "model/memo-cleanup-model.json", "worker/transcript-cleanup-worker.py",
        "worker/cleanup_prompt.py", "worker/cleanup_completion.py",
        "LICENSE-LFM-1.0.txt", "NOTICE.txt", "VERSIONS",
    ]
    manifest = {
        "schema_version": 1,
        "candidate": "memo-lfm-hybrid-v5-step-1024-6bit",
        "status": "fixture" if args.fixture else "production_ready",
        "precision": "affine-group64-6bit",
        "fixture": args.fixture,
        "files": {name: record(args.bundle / name) for name in names},
    }
    (args.bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
