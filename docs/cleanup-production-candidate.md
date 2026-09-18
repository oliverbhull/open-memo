# Cleanup production candidate

Status: selected and packaged for the v0.8.11 production candidate.

The quality reference and rollback remains the fused step-1024 8-bit LFM model.
Normal local development now selects the preferred smaller candidate, rebuilt
from the original BF16 model plus the
selected adapter, then quantized uniformly to affine group-64 6-bit. The 8-bit
directory is retained unchanged for rollback.

## Measured candidates

| Candidate | Directory bytes | Agreement with 8-bit on 108 reused validation rows | Exact historical references | Warm median / p95 |
| --- | ---: | ---: | ---: | ---: |
| Current fused 8-bit | 1,248,407,167 | reference | 59 | 154.19 / 349.26 ms |
| Uniform 6-bit | about 956 MB | 106/108 | 58 | 128.39 / 279.08 ms |
| Mixed 4/6, target 5.5 bpw | 811,175,959 | 95/108 | 58 | 107.20 / 236.43 ms |
| Mixed 4/6, target 5.0 bpw | 767,922,187 | 93/108 | 55 | 110.09 / 252.05 ms |

Timing runs are local engineering measurements, not clean-machine or concurrent
ASR qualification. Exact references are diagnostics, not semantic judgments.
The two changed 6-bit outputs remain available in the private local review
artifact. The selected model matched the 8-bit output on 106/108 rows and passed
the maintained real-worker smoke cases. The mixed candidates are retained
as experiments but are not selected because they changed substantially more
outputs.

## Reproduction

`npm run build:cleanup:6bit` converts the fused BF16 reference to uniform 6-bit.
`npm run build:cleanup:mixed` builds a sensitivity-calibrated 4/6-bit experiment
using only explicit local calibration rows. Neither command downloads calibration
data. Candidate manifests pin model/config/tokenizer/prompt hashes. The release
bundle is marked `production_ready`; signed builds reject fixtures and any other
status.

`npm run build:cleanup:runtime` creates a portable offline runtime from the
existing bundled Python base and an exact production dependency list. The tested
runtime is about 380,408 KiB versus 519,564 KiB for the development environment.
It excludes pandas, pyarrow, datasets and other training/development packages.

The private paired output and review artifacts are under
`.build/cleanup-mixed-eval/`. They intentionally remain ignored and must not be
committed. The review HTML contains transcript text; aggregate source reports do
not.

## Release verification

The production bundle contains the fused model, isolated runtime, worker, prompt,
notices and file hashes. It initializes offline, and technical failures preserve
the original recognized text. Local verification covered the real bundled worker,
Developer ID signing, the nested runtime signature, and updater artifact hashes.

Before publishing a tag, the GitHub release workflow must still notarize the DMG
and CI must pass on the exact main commit. A clean-machine install, previous-version
automatic update, and hands-on dictation into real destinations remain the final
release acceptance checks; source and model tests do not substitute for those.

Development environment variables can still select the retained 8-bit reference
or another candidate. Packaged builds use only the verified bundled 6-bit model.
