# Development live integration — 2026-09-05

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Historical experiment: the current user-authorized development app uses a single Nemotron call for complete cleanup. See [Nemotron development testing](/Users/oliverhull/dev/open-memo/docs/clean-v1/NEMOTRON_DEV.md). The earlier route described below is no longer selected by development Clean mode.

**Historical v1 snapshot:** the route below has been replaced. See [RELIABLE_FORMATTING.md](RELIABLE_FORMATTING.md) for the current v3.1 annotation runtime and validation.

The current checkout now connects `npm run dev` to Clean v1 when Settings -> Clean — Local experiment is selected. Restart an existing development app. Packaged builds and the legacy As spoken/PnC path are unchanged.

Current route: FINAL raw recognition text -> v1 protection -> local LFM Q8 base -> v1 acceptance guard -> restore or original recognition text -> phrase replacements -> existing paste/history. `resolveCleanInput` recovers raw recognition text even when native sign-off/dash/punctuation cleanup emptied or modified processed text. It cannot recover errors already made inside the recognition backend.

CleanupService uses the bounded CleanupWorkerClient, versioned handshake, absolute Unix deadline converted to Python monotonic time, single in-flight request, process-identity checks, frame limits and crash/timeout fallback. Startup is prewarmed; if unavailable, requests retain original immediately. After a failed worker, the next request starts recovery without waiting for startup. Timeout kills generation. All content remains local. History context carries As Spoken/candidate/selected/model/contract/reason when a worker response is available; source/candidate text logging was removed. Raw history is no longer replaced when spoken Enter is handled.

Default model: local LFM2.5-1.2B-Instruct-MLX-8bit without the old hybrid LoRA. The new contract is not silently paired with that rejected adapter. MEMO_CLEANUP_MODEL can select an explicit local model/fused candidate; MEMO_CLEANUP_PYTHON selects the local environment. No model training, downloads or packaging enablement occurred. Expect many unchanged/fallback outputs: this is the conservative experiment, not a newly trained writing model.

Validation: 8 Node integration tests (including actual local MLX inference through the live supervisor) and 26 Python tests pass; typecheck and build:main pass. Ordinary CI runs the 7 model-free Node tests and 26 Python tests; the real-model test is opt-in with MEMO_CLEANUP_MODEL_SMOKE=1 and MEMO_CLEANUP_PYTHON pointing to the MLX environment. Startup setup succeeds locally. No microphone-to-destination manual paste test was performed, and existing destination/clipboard limitations remain.

Earlier REPORT.md and smoke manifests describe the pre-integration snapshot. They are historical evidence, not a hash manifest or benchmark for this revised runtime. New user-audio evaluation and shipping gates remain unmet.
