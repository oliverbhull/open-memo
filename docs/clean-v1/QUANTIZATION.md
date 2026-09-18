# Quantization comparison and next recipe

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Evidence below is existing experiment data, independently audited on 2026-09-05. It is not a new bake-off.

| Existing v4 diagnostic, 50 rows | Exact | Normalized | Heuristic issue rows | Fallback | p50 / p95 ms |
|---|---:|---:|---:|---:|---:|
| BF16 + adapter | 30 | 33 | 5 | 2 | 309.76 / 675.27 |
| Q8 + adapter | 29 | 31 | 8 | 5 | 215.25 / 449.68 |
| Q4 + adapter | 25 | 27 | 11 | 6 | 172.99 / 347.73 |

Source: original ignored `hybrid-v4/results/internal-1024{,-8bit,-4bit}/inference.json` and `evaluation/summary.json`. These are heuristic issue rows, not adjudicated critical failures. The naive Q4 base plus unfused BF16-trained adapter degraded; this does not establish that fusion-first or calibrated Q4 fails. Precision mismatch/quantization error are plausible contributors, not a proven tensor-level cause.

| Local existing artifact | Complete directory bytes |
|---|---:|
| Original BF16 | 2,345,693,856 |
| Q8 | 1,248,655,124 |
| Q4 | 663,549,500 |
| Old fused Q8 | 1,248,407,167 |

Original v5 adapter: 44,453,426 bytes. Installed MLX 0.32.2 and mlx-lm 0.31.3. Q4/Q8 are affine group64. Interpolated Q6 directory ~956 MB; Q5 ~810 MB (decimal). Those are estimates, not new artifacts. Native Q4 currently measures 664 MB; supplied 700–730 MB is a planning budget. Full app compressed transfer size is unmeasured.

Selected old fusion predictions and guard/protection statuses match across 100 spent cases, but one raw candidate differs. Old fused p95 209.99ms versus unfused 347.16ms is engineering regression evidence only. Old load_ms is not cold process-to-ready.

## Next bake-off, gated on a strong reference

1. Fuse exact newly approved LoRA into local original BF16 (2.346GB), save weights/config/tokenizer/checksum. Never call dequantized Q8 a BF16 reference.
2. Convert fused reference to affine Q6 group64 using installed `mlx_lm.utils.quantize_model`.
3. Import `mlx_lm.quant.dynamic_quant.estimate_sensitivities` with explicitly supplied local token arrays, low_bits=4/high_bits=6. Freeze gradient sensitivity scores and per-layer precision map before validation. Use a parameter-dictionary quantization predicate. Target ~800MB and measure actual result.
4. Smoke-test imported `mlx_lm.quant.gptq.gptq_quantize` on the same local calibration tokens, 4-bit, recording Hessian settings and explicit unsupported-layer Q6 policy. Architecture compatibility is not yet verified. Fail rather than silently changing method.
5. DWQ is a later option if simpler candidates fail; budget teacher/student/cache memory first. AWQ currently lacks LFM2 mapping. Built-in `mixed_4_6` expects down_proj while LFM uses w1/w2/w3; it is not a drop-in recipe.

Do not use stock calibration CLIs: installed `quant/utils.py:8-19` fetches remote calibration text when its cache is absent, including dynamic quant paths with supplied sensitivities. Call local APIs with explicit local arrays; set offline environment flags. Never use final evaluation for calibration.

Q6 engineering complexity low, sensitivity/GPTQ medium, DWQ high. New conversion/calibration was not run because no strong new reference exists; creating several hundred MB artifacts from a rejected candidate would not satisfy the requested selection order. Cold start, concurrent ASR memory, energy, full package size and oldest-Mac latency remain unknown for these proposed candidates.
