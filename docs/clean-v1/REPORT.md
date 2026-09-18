# Current-state report and recommendation — 2026-09-05

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


**Superseded:** see [RELIABLE_FORMATTING.md](RELIABLE_FORMATTING.md) for the trained-model rejection and current narrower annotation runtime.

Update: development live wiring was subsequently completed in the main checkout. See [LIVE_INTEGRATION.md](LIVE_INTEGRATION.md) for the current route and tests. The report below preserves the pre-integration audit and benchmark snapshot.

**Blocked from shipping.** Ready only for local engineering experiments. No opt-in beta, app integration or model deployment is justified by these results.

Isolated branch `codex/clean-writing-v1`, worktree `/Users/oliverhull/dev/open-memo-clean-writing-v1`, exact base `060526a7514a06a89d7f2bb581d6abe3232864b3`. Original dirty checkout was not edited, stashed, reset, committed or overwritten. No push, PR action, release, cloud processing or installation occurred.

## What was built

A self-contained Python laboratory runtime replaces the dirty worker's imports from ignored historical experiments: versioned compact contract, deterministic document-specific placeholders, exact ordered restoration, conservative whole-candidate guard, bounded JSONL handshake/request/response, one-flight supervisor, startup/request deadlines, crash termination and explicit restart, original-text fallback, and raw/candidate/selected provenance returned locally. Dataset export checks review approval, hashes, group/text leakage and exact source-linked literal values. A pure insertion admission/clipboard-ownership gate is prepared for later native implementation. Tests enter ordinary CI through `test:clean-v1`; no model downloads or private data are needed in CI.

This is intentionally not full app implementation. No native AX helper, faithful raw ASR transport, main-process provenance persistence, trained LoRA, new quantized model, final evaluation or package candidate was completed. Plans for these are concrete in the linked documents. Model and annotation evidence must come before enabling Clean.

## Directly observed architecture / risks

References below refer to the original checkout audit snapshot, including dirty changes.

- `electron/main/services/MemoSttService.ts:175-181,249-279`: owned Rust recorder, Conomo selection, development contextual Granite vs packaged backend; vocabulary at `120-138`.
- `sidecars/dictation/src/transcription_engine.rs:201-241`: stream/resample -> Conomo `end` -> processed result; per-read response timeout is 120 seconds.
- `sidecars/dictation/src/main.rs:87-164,1519-1529,1988-1999`: deletes trailing sign-offs, punctuation on short phrases and any leading dash. `173-198` joins segments and inserts periods. These precede Clean and can alter legitimate speech.
- `MemoSttService.ts:704-723`: prioritizes processed text and suppresses explicitly empty processed output. Raw input must be established before calling fallback As Spoken.
- Dirty `electron/main/index.ts:274-302`: normalization -> development Clean -> PnC on rejection -> ordered phrase replacement -> spoken-enter removal -> normalization. `PunctuationService.ts:63-74` bypasses formatting on existing uppercase or sentence punctuation and uses a 150ms budget.
- `sidecars/pnc/main.swift:105-132`: preserves word strings, changes initial capitalization, adds comma/period/question labels, rejoins single spaces. It does not perform grammar repair or speech correction; paragraph layout is flattened.
- `phraseReplacement.ts:18-43`: ordered case/punctuation-insensitive substitutions can cascade and lack outer word boundaries. These are post-guard user actions, not Clean proof. `textProcessing.ts:21-26` can interpret literal trailing “enter” as a keypress.
- `index.ts:304-327`: overwrites clipboard and synchronously invokes unbounded AppleScript Cmd-V into whatever is focused; no destination revalidation or consumption verification. Native app context is captured after recording stops (`main.rs:1405-1418,1852-1868`), not at recording start.
- `index.ts:333-365`: optional audio save followed by renderer notification; `App.tsx:175-189` initiates entry persistence. Overlapping async transcript callbacks can reorder work, and absent renderer can lose history. Voice-enter overwrites raw provenance (`index.ts:360`). Full-text diagnostic logging is at `289-296`.
- Dirty CleanupService lacks versioned handshake/model identity, frame bounds, one-flight admission, startup timeout and generation-safe exits; timeout leaves computation running. New lab supervisor addresses these mechanics without copying the entire integration.

## Sub-agent findings reconciled

Three independent read-only audits covered pipeline, data/safety and quantization. Main-agent checks confirmed native destructive preprocessing, PnC implementation, old independent source/target numeric protection, old set/count-only restoration, artifact sizes and the calibration loader's remote behavior.

**Existing experiment:** v5 remains rejected: 59/100 exact, 12 fallback, p95 350.73ms and failed meaning gate. Its zero “contract failures” is a narrower structural metric and does not contradict critical meaning failures. Runtime changes subsequently spent the evaluation set.

**Directly observed by dataset audit:** 847 training rows, only 14 exact no-ops (368 lexical no-ops), 108 validation with one exact no-op, zero paragraph targets. Legacy ID-based split is not speaker/family isolated. Canonical source contains one real speaker and zero human-approved rows; synthetic personas inflate manifest speaker counts. Old protection normalizes noon and midnight both to 12:00. New exporter preserves source literals exactly and requires review; it does not auto-approve old targets.

**Correction to prior memory:** old fusion has identical selected predictions and guard/protection decisions on 100 spent cases, but ONE raw model output differs. Main independently compared aggregate differences. Therefore raw-output parity is not claimed. Old fused p95 209.99ms is not fresh safety or oldest-Mac evidence.

**Correction to planning size:** existing local Q4 directory is 663,549,500 bytes, below the supplied 700–730MB budget. Q6 ~956MB and Q5 ~810MB remain interpolations. New quantization is gated on a strong frozen reference. Installed AWQ/built-in mixed recipe are not drop-in LFM recipes; default calibration loader can access the network. See QUANTIZATION.md for local-only alternatives.

**Independent implementation review:** reviewers found numeric sign/percent/leading-decimal gaps, multiline-quote gaps, tense-changing function exemptions, moved question marks, and rejected-input responses missing model identity. These were corrected with regression coverage. Fallback candidate provenance is now retained. Passing tests still do not prove semantics.

## Current smoke evidence

`experiments/clean-v1/results/base8-smoke.json` records a new 15-case synthetic DEVELOPMENT smoke with the existing Q8 base, no LoRA, v1 prompt/protection/guard and greedy decoding. No private rows are in the report.

- Accepted: 4; fallback: 11; selected text unchanged: 15/15.
- Warm p50 63.73ms, p95 339.84ms (nearest-rank p95 for 15 samples is the maximum).
- Process-start-to-ready including warmup: 1424.86ms, with warm filesystem cache; not true cold-install startup.
- MLX peak allocation 1,384,101,920 bytes; max sampled active allocation 1,243,608,584 bytes; macOS peak RSS 1,364,983,808 bytes. These are not full-app or concurrent-ASR memory.
- Diagnostic request budget 10s; this does not demonstrate the normal 750ms runtime deadline or the <=250ms shipping gate.
- No human preference, audio review, grammar correctness or paste-ready gain is established. All selected outputs are no-ops, and placeholder failures show the prompt/base is not trained for this contract. Do not choose it as the quality reference.

An earlier development run preceded guard fixes and had different results; it is superseded. The stored smoke manifest pins the final source/model hashes. There is no valid new locked final set and no new model artifact.

## Deliverables and remaining gates

- `DECISION.md`: pre-implementation decision record.
- `CONTRACT.md` + executable `contract.json`: product contract vs initial conservative acceptance envelope.
- `DATA_AND_EVALUATION.md`: schema, quarantine/review/export, bounded LoRA plan, predeclared unseen-final protocol and thresholds.
- `QUANTIZATION.md`: existing comparison, exact sizes, supported local recipes and missing measurements.
- `PACKAGING_AND_INSERTION.md`: model install/rollback/signing/license/CI plan, raw transport/persistence changes, native destination/clipboard matrix and PnC retirement.
- `experiments/clean-v1/`: runnable local implementation, aggregate results and tests.

Before training: human-reviewed compliant development labels. Before a beta: strong reference, new speaker-held-out evaluation, measured human paste-ready benefit, zero critical selected failures, protected invariants, oldest-Mac p95, trustworthy raw input, native insertion and provenance, license/package review. Current guard is intentionally too conservative for the desired full grammar/correction experience; semantic coverage and broader acceptance remain unresolved. Do not grow it into hundreds of English rules.

## Execution handoff

Files changed: only isolated `.gitignore`, `package.json`, `.github/workflows/ci.yml`, new `docs/clean-v1/*` and `experiments/clean-v1/*`. No production source changes. Typecheck reused existing dependencies through a temporary local symlink, removed afterward; no dependency install was run. `.gitignore` exposes only the new Clean documentation under the otherwise ignored docs directory.

Commands: `git worktree add -b codex/clean-writing-v1 ... 060526a7514a06a89d7f2bb581d6abe3232864b3`; focused read-only audits; `python3 -m unittest discover -s experiments/clean-v1 -v`; `npm run test:clean-v1`; `npm run typecheck`; local offline MLX `smoke.py --model /Users/oliverhull/models/llm/LFM2.5-1.2B-Instruct-MLX-8bit --output experiments/clean-v1/results/base8-smoke.json`. No `npm test` exists. CI configuration was edited but remote CI was not run. Packaging/native app tests were not run.

Tests: initial tests exposed a case-insensitive acronym detector bug; fixed. Subsequent independent adversarial findings also fixed as described above. Final test count and worktree disk use are recorded in `results/validation.json`. TypeScript check passes. All model workers exit after smoke/test completion.

Model artifacts created: none; only aggregate benchmark/hash manifests. Existing model is read in place. Disk: small source/report files plus ordinary Git worktree checkout; no copied base weights or adapters. Memory: measured smoke values above; process released afterward, no new persistent production process.

Actions requiring Oliver: review/approve target labels and authorize any additional audio acquisition/review; identify oldest supported Mac hardware for performance validation. External upload, push, merge, publish and production installation remain unauthorized. Local development/training/quantization itself is already authorized; no redundant permission is needed once evidence prerequisites are met.
