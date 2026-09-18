# Current development decision — 2026-09-05

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Historical experiment: the current user-authorized development app uses a single Nemotron call for complete cleanup. See [Nemotron development testing](/Users/oliverhull/dev/open-memo/docs/clean-v1/NEMOTRON_DEV.md). The earlier route described below is no longer selected by development Clean mode.

Clean now uses the existing local punctuation classifier to annotate original words, under contract `memo-clean-v3.1-annotations`. It does not generate replacement prose. Restart `npm run dev` in this checkout and select **Clean — Formatting**. The local `.build/clean-v3/LIVE.json` pins runtime and model checksums; the worker verifies them before readiness. Packaged builds remain disabled for this candidate.

The scope is punctuation and capitalization. Words, technical literals, quotations and existing whitespace are preserved by rendering annotations onto source offsets and checking invariants. Grammar repair, filler removal, repetition removal and recognition-error repair are outside this scope. In particular, the supplied phrase “determ rest stick” remains unchanged. Timeout, crash, busy or rejected results retain the original recognition text. These guarantees describe the formatting stage: user phrase replacements and spoken Enter handling still run afterward.

## Why the model was simplified

We generated a local formatting dataset (205 training rows, 24 validation rows), trained LoRA adapters for 1,500 total steps, fused BF16 weights and evaluated an 8-bit conversion. Training data is synthetic plus two explicitly supplied user regressions; those two examples are not unseen evidence. The final LoRA failed a separately authored 40-case holdout: 30 accepted, 17 exact authored-target matches, warm p95 about 418 ms. It remains offline. We did not weaken its acceptance gate to enable it.

The annotation approach uses the existing DistilBERT punctuation model and a small native helper. Punctuation threshold 0.65 and question threshold 0.8 were chosen on spent development data before fresh evaluation. These are classifier scores, not semantic safety probabilities. The first 30-case review exposed capitalization of a technical key. That candidate failed fidelity; the corrected v3.1 protected technical tokens and was frozen before another fresh 20-case evaluation.

## Evidence and limits

Final fresh synthetic holdout: 20/20 accepted, 14 exact authored-target matches, 17/20 independently agent-reviewed as usable, zero observed word, technical-literal or quotation changes, and no identified critical meaning changes. Warm p95 was approximately 5 ms on this Mac. Three outputs had missing punctuation or capitalization around line boundaries. All 20 changed from raw input, but change alone is not evidence of improvement. This passes the declared internal formatting gate; it is not human/audio validation or proof of universal reliability. All evaluated sets are now spent.

The earlier native-PnC comparison used the stricter v2 question guard, so its selected-output acceptance rates are not a fair direct comparison with v3.1. Do not use them to claim model superiority.

Validation passed: 51 tests including actual native-model inference through the Node/Python live supervisor, timeout/restart/crash/stale-response handling, and immutable-word checks; TypeScript typecheck; main-process build; local startup setup. Actual worker smoke took about 309 ms including startup and teardown. No microphone-to-destination paste test was performed. Existing clipboard/focus handling and renderer-dependent history persistence remain separate limitations.

## Local artifacts

- `experiments/clean-v2/`: reproducible dataset/training evaluation code; `.build/clean-v2/`: data, training logs, adapters, frozen manifest, fused candidates and rejected holdout results.
- `experiments/clean-v3/`: annotation helper source, renderer, guard, worker, tests and declared criteria.
- `.build/clean-v3/FROZEN-v31.json`: runtime/model hashes frozen before the final holdout.
- `.build/clean-v3/holdout-v31-results/`: final evaluation outputs and timing.
- `.build/clean-v3/LIVE.json`: internal development selection with review summary; human/audio review explicitly false.

Artifacts and supplied speech stayed local. No push, upload, release or production-app installation occurred. Earlier reports in this folder are historical snapshots superseded by this decision.
