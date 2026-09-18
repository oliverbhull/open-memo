# Clean v1 decision record — 2026-09-05

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Status: blocked from shipping; build an isolated laboratory runtime first.
Base: 060526a7514a06a89d7f2bb581d6abe3232864b3. The original dirty checkout remains user-owned.

1. **Directly observed:** owned Rust dictation -> Conomo/Granite -> `resolveTranscriptionText` -> leading-dash removal/trim/no-speech filtering -> production PnC, or dirty development Clean -> phrase replacements -> optional spoken-enter removal -> trim -> clipboard/Cmd-V -> renderer history. Dirty `electron/main/index.ts:273-363` is the evidence snapshot.
2. **Directly observed:** PnC is the existing punctuation/capitalization stage, not the proposed grammatical speech editor. Its exact implementation and lifecycle are audited separately.
3. **Directly observed:** dirty Liquid worker imports protection, prompt and guard from ignored hybrid-v3 experiment files, loads hybrid-v5 weights, generates text, checks a lexical guard, restores literals. Readiness lacks a protocol version; app fallback currently invokes PnC. The isolated experiment will be self-contained and always retain its input.
4. **Decision:** Liquid owns disfluency removal, grammar and segmentation; deterministic code does not implement English grammar. The new contract intentionally rejects ambiguous correction scope.
5. **Decision:** exact vocabulary and explicitly supplied high-confidence entity spans, quoted spans, numeric/literal tokens, URLs/emails/paths/identifiers get unique opaque placeholders. Detector coverage is incomplete; no claim of universal entity recognition.
6. **Inference:** exact placeholder identity/order can prove literal conservation, but not who did what, certainty, or semantic equivalence. Lexical risk gates are conservative tripwires. Changed attribution/correction/event-order inputs may be wholly rejected pending evidence.
7. **Unknown:** new-contract human preference, universal speaker performance, supported-oldest-Mac latency, secure-field insertion behavior, calibrated quantization quality.
8. **Existing experiment result:** CANDIDATE.json rejects hybrid-v5: 59/100 exact, 12 fallbacks, p95 350.73 ms, failed critical-meaning gate. Zero structural contract failures does not mean zero meaning changes. Runtime changed after evaluation, spending that set.
9. **Inference/planning:** desired ~800 MB model, fallback ~950 MB, stretch ~700 MB. Select safety/quality reference before comparing fused Q6, sensitivity mixed Q4/Q6, calibrated Q4. Never requantize old Q8 as if it were a high-precision source.
10. **Implementation plan:** independent audits -> versioned compact contract -> bounded local JSONL worker and supervising client -> exact protection and whole-candidate guards -> behavioral adversarial/lifecycle tests -> synthetic development model smoke -> quarantined dataset transformation plan -> frozen evaluation and packaging/insertion plans. No app enablement or model training on unreviewed legacy targets. Model smoke is development evidence only.

This record precedes implementation. See REPORT.md for verified audit reconciliation and results.
