#!/usr/bin/env python3
"""Build an offline sensitivity-calibrated mixed 4/6-bit cleanup model."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import time


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def calibration_tokens(tokenizer, source: Path, samples: int, sequence_length: int):
    import mlx.core as mx

    token_stream: list[int] = []
    rows = 0
    with source.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            messages = row.get("messages")
            if not isinstance(messages, list):
                raise ValueError("calibration row is missing messages")
            rendered = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=False
            )
            token_stream.extend(tokenizer.encode(rendered, add_special_tokens=False))
            rows += 1
            if len(token_stream) >= samples * sequence_length:
                break
    required = samples * sequence_length
    if len(token_stream) < required:
        raise ValueError(
            f"calibration data supplied {len(token_stream)} tokens; {required} required"
        )
    # Fixed contiguous segments are deterministic and never invoke remote calibration data.
    return mx.array(token_stream[:required]).reshape(samples, sequence_length), rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--calibration-data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--sensitivities", type=Path)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--sequence-length", type=int, default=128)
    parser.add_argument("--target-bpw", type=float, default=5.0)
    parser.add_argument("--low-bits", type=int, default=4)
    parser.add_argument("--high-bits", type=int, default=6)
    parser.add_argument("--group-size", type=int, default=64)
    args = parser.parse_args()

    if args.output.exists():
        parser.error(f"output already exists: {args.output}")
    if not args.model.joinpath("model.safetensors").is_file():
        parser.error("model must be a complete fused MLX directory")
    if not args.calibration_data.is_file():
        parser.error("calibration data does not exist")
    if not 4.0 <= args.target_bpw <= 6.0:
        parser.error("target-bpw must be between 4 and 6")

    # Imports occur only after argument validation so --help works without MLX.
    import mlx.core as mx
    from mlx_lm import load
    from mlx_lm.quant.dynamic_quant import estimate_sensitivities, estimate_threshold
    from mlx_lm.utils import quantize_model, save

    mx.random.seed(20260917)
    started = time.perf_counter()
    model, tokenizer, config = load(str(args.model), return_config=True)
    data, calibration_rows = calibration_tokens(
        tokenizer, args.calibration_data, args.samples, args.sequence_length
    )

    if args.sensitivities and args.sensitivities.is_file():
        sensitivities_list = json.loads(args.sensitivities.read_text())
    else:
        sensitivities_list = estimate_sensitivities(
            model,
            data,
            low_bits=args.low_bits,
            low_group_size=args.group_size,
            high_bits=args.high_bits,
            high_group_size=args.group_size,
            batch_size=1,
            gradient_accum_dtype=mx.float32,
            gradient_checkpoint=True,
        )
        if args.sensitivities:
            args.sensitivities.parent.mkdir(parents=True, exist_ok=True)
            args.sensitivities.write_text(
                json.dumps(sensitivities_list, indent=2) + "\n", encoding="utf-8"
            )

    sensitivities = dict(sensitivities_list)
    threshold = estimate_threshold(
        model,
        sensitivities,
        target_bpw=args.target_bpw,
        low_bits=args.low_bits,
        low_group_size=args.group_size,
        high_bits=args.high_bits,
        high_group_size=args.group_size,
    )
    high_precision_layers: list[str] = []
    low_precision_layers: list[str] = []

    def quantization_choice(path, module):
        if not hasattr(module, "to_quantized"):
            return False
        if path not in sensitivities:
            raise KeyError(f"missing sensitivity for quantizable layer {path}")
        if sensitivities[path] > threshold:
            high_precision_layers.append(path)
            return {
                "bits": args.high_bits,
                "group_size": args.group_size,
                "mode": "affine",
            }
        low_precision_layers.append(path)
        return {
            "bits": args.low_bits,
            "group_size": args.group_size,
            "mode": "affine",
        }

    model, config = quantize_model(
        model,
        config,
        group_size=args.group_size,
        bits=args.low_bits,
        quant_predicate=quantization_choice,
    )
    save(args.output, args.model, model, tokenizer, config)

    source_weights = args.model / "model.safetensors"
    output_weights = args.output / "model.safetensors"
    manifest_path = args.manifest or args.output / "memo-cleanup-model.json"
    manifest = {
        "schema_version": 1,
        "candidate": "memo-lfm-hybrid-v5-step-1024-mixed-4-6",
        "status": "candidate_not_promoted",
        "source_model": str(args.model),
        "source_weights_sha256": sha256(source_weights),
        "output_weights_sha256": sha256(output_weights),
        "calibration_data_sha256": sha256(args.calibration_data),
        "calibration_rows_read": calibration_rows,
        "calibration_samples": args.samples,
        "calibration_sequence_length": args.sequence_length,
        "calibration_network_access": False,
        "quantization": {
            "mode": "affine",
            "group_size": args.group_size,
            "low_bits": args.low_bits,
            "high_bits": args.high_bits,
            "target_bits_per_weight": args.target_bpw,
            "sensitivity_threshold": threshold,
            "low_precision_layer_count": len(low_precision_layers),
            "high_precision_layer_count": len(high_precision_layers),
            "high_precision_layers": sorted(high_precision_layers),
        },
        "directory_bytes": directory_size(args.output),
        "build_seconds": round(time.perf_counter() - started, 2),
        "runtime": {
            "python": sys.version.split()[0],
            "mlx": getattr(mx, "__version__", "unknown"),
        },
        "promotion_requirements": [
            "paired output review against the current 8-bit baseline",
            "latency and memory measurement with ASR active",
            "portable runtime and signed installed-app verification",
        ],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "directory_bytes": manifest["directory_bytes"],
        "low_precision_layers": len(low_precision_layers),
        "high_precision_layers": len(high_precision_layers),
        "manifest": str(manifest_path),
    }))


if __name__ == "__main__":
    main()
