# New local experiment: clean-v1

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


No new training dataset or adapter is approved. Current model smoke uses the existing base Q8 without the broad legacy adapter. This tests mechanics and exposes placeholder/prompt mismatch; it is not training or a selected quality reference.

## Source review and schema

`dataset.py` defines the minimum executable schema. Each row requires id, contract, immutable source and source SHA256, target and reviewed-target SHA256, review_status=human_approved, reviewer, real/synthetic source kind, consent/license, split, speaker, recording, family, template, development exposure and edit/noop decision. Real recordings additionally require audio SHA256 and audio-reviewed status. Optional vocabulary and source/target high-confidence entity offsets are local metadata. Ambiguous rows and fallback-intent examples are quarantined from positive training.

Additional annotation metadata: ASR/tokenizer versions, edit-category list, protection version, explicit correction-scope decision and review timestamp. Record resolved span offsets/values in a private sidecar; never print them in aggregate reports. The exporter reuses source placeholder identities only after exact source/target literal values, multiplicity and order agree. Unlike old training, equal placeholder counts cannot conceal different numbers. Approximate semantic duplicates still require family review; string/group checks do not prove no leakage.

Disposition of legacy material: everything remains proposed until reviewed against this contract. Review the 368 lexical-no-op v5 training rows as a pool, not approved labels. Quarantine number normalization, unsupported name correction, ambiguous corrections, argument improvement, tone changes and invented completions. Preserve paragraphs instead of flattening them. All previously inspected test sets are spent regression sets.

Proposed initial mix: 35% exact no-op/negative controls, 40% disfluency/grammar/segmentation, 25% clear corrections and combined safety cases. Review minimal pairs for meaningful fillers, emphasis, negation/correction, attribution, modality, quotation and deliberate fragments. Unsafe mutated candidates belong in guard tests, never positive targets. Synthetic personas do not count as real speakers.

## Bounded training sequence

1. Review/approve 64–128 genuinely compliant development examples and a separate family-held-out development validation set. No audio is sent externally.
2. Use local original BF16 LFM2.5-1.2B, compact v1 system/user prompt, rank-16 LoRA initial configuration, greedy inference and fixed seed. Start with 20 update steps, batch 1, bounded sequence length 256; measure tokens/s, memory, time and validation edits before scaling. These settings are a proposed smoke configuration, not an optimized recipe.
3. Fit no-op/protection behavior first; do not relax safety just to improve acceptance. Inspect critical failures on development data and adjudicate labels. Budget the larger run from the measured step time, with a 30-minute initial run cap and explicit stop for loss divergence or meaning regressions.
4. Freeze chosen adapter and fuse into original BF16, not dequantized Q8. Only a strong reviewed reference earns a quantization bake-off.

Compute is available (24 GiB host), but label approval is the immediate blocker. Runtime/memory and full training duration are unknown until a bounded training smoke; no long training run was started.

## Locked final protocol — no valid new final currently available

Reserve unseen real speaker/audio/source/family/template groups before annotation distribution; at least five real speakers overall, with held-out speakers untouched by development. Proposed final: 300 safety cases plus 200 representative flow cases, audio-adjudicated where authorized. Custodian keeps final text away from model/guard developers. The current one-real-speaker corpus cannot supply this claim.

Freeze code, contract, prompt, tokenizer, model/checkpoint, decoding, quantization maps/calibration membership and harness by SHA256 before access. Quant calibration uses training/development only. Run all baselines in one batch: authentic As Spoken, current PnC, fused BF16/Q8 reference, Q6, mixed Q4/Q6 and calibrated Q4. Missing candidates are reported missing. No tuning after inspecting finals; spend the set and obtain a fresh set after any change.

Predeclare: zero selected critical meaning changes and zero selected protected-value failures on the safety set; report raw-candidate failures too. Meaning preservation must be rated >=99% on the representative set, with all disagreements adjudicated. Clean grammar/readability preference must exceed 60% among non-ties with a 95% confidence interval lower bound >50%. Paste-without-correction rate must improve by at least 10 percentage points over As Spoken, and not regress versus PnC. These are proposed experimental thresholds frozen before final acquisition, not evidence they have been met.

Report per slice: paste-ready rate, pairwise blinded human preference, character/word edits needed, exact/normalized target matches, critical meaning failures, protected failures, no-edit and fallback rates. Include denominators and confidence intervals. A zero-event 300-case result still leaves roughly a 1% upper 95% failure-rate bound; it is not universal safety proof.

Measure warm p50/p95 over repeated representative lengths and cold process-to-ready separately; gate <=250ms p95 on the oldest supported Mac under concurrent ASR. Prewarm before recording, preserve immediate As Spoken while loading. Report peak and steady process/MLX memory, package/transfer size and energy if available. All lifecycle tests and native insertion tests must pass. Current synthetic smoke is development/spent immediately, never final evidence.
