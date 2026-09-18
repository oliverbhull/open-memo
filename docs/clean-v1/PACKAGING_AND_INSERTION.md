# Packaging and insertion plan

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


Clean remains absent from Electron settings, resource lists and packaged runtime in this worktree. The new code is a local laboratory harness. Existing production PnC is unchanged. No package candidate was built: no approved model or faithful native input/insertion path exists to package.

## Minimal future integration

Native ASR -> immutable recognition text -> faithful As Spoken -> protect -> one-flight Liquid worker -> whole-candidate guard -> exact restore -> selected text -> authorized phrase replacements -> insertion gate -> durable history and renderer notification.

First fix the native boundary in an isolated integration change: preserve Conomo recognition output before sign-off/dash/short-punctuation deletion, forward valid raw output even when legacy processed text is empty, and stop overwriting raw history for spoken Enter. Retain legacy formatting only on the explicit PnC baseline path. Save in main before notifying renderer, using existing context JSON for {rawAsr, asSpoken, candidate, selected, contract/model/checksum, reason, phraseReplacementVersion, insertionOutcome}. Avoid full transcript debug logs by default. No screen/document capture is needed.

One request active; busy, not-ready, deadline, malformed or crash returns original immediately. Prewarm before dictation and show readiness accurately. Restart explicitly after a failed worker, with process generation and pending IDs isolated; no first dictation wait for startup. Laboratory supervisor currently implements this policy in Python; Electron adapter still requires implementation.

## Model install manifest and lifecycle

Required manifest: schema/contract/protocol versions, model ID, exact weights/config/tokenizer SHA256, architecture, precision/per-layer map, base/adapter source revisions, fused=true, adapter checksum (provenance only), file byte counts, runtime minimum version, license files and review status, evaluation manifest hash and approval status. The existing smoke manifest records hashes, not redistribution approval.

Separately version model installation so app upgrades do not retransmit 700–950MB. Stage files in a versioned temporary directory; enforce size/checksum and local load/self-test; atomically switch active-version pointer. Never overwrite a running model. Keep one last-known-good installation and roll back on startup/self-test failure. Fall back to As Spoken if both fail. Download, license review and rollout are future product work, not enabled here.

License/redistribution review: base LFM license and notices; LoRA corpus consent and derived-weight permissions; tokenizer; MLX/MLX-LM/Python and native dependencies; required notices, model-card restrictions and provenance. No legal approval inferred from MIT repository license.

CI/afterPack preparation: `test:clean-v1` is added to ordinary CI without models or private data. Future release CI must run the same suite, verify model manifest/schema and expected resource boundaries, run an offline bundled worker handshake/self-test, reject accidental extra adapters/private data, verify embedded Mach-O signing order, then use existing signing/notarization pipeline. No signing credentials or release workflow were invoked.

Delete PnC only after real Clean and As Spoken gates pass. Then remove service/resources/build scripts/signing support/startup/tests together, measuring app size/process count and regression parity. This change adds zero production formatters and zero production processes; PnC retirement remains a later gate.

## Insertion boundary

`insertion.py` implements a pure tested admission decision. It is NOT a native AX implementation and has no clipboard side effects. A native helper must capture process/window/focused-element/selection at recording START, not stop. Revalidate atomically as close to actual insertion as feasible. Any focus/selection mismatch, unknown target, denied accessibility or secure/literal field skips automatic paste and records a retained transcript outcome. Bundle ID alone is insufficient.

Snapshot all clipboard formats and NSPasteboard changeCount before writing. Restore only if still owned AND paste consumption can be established; Cmd-V success or elapsed time does not prove consumption. On unknown consumption keep transcript recoverable and report clipboard outcome; never blindly overwrite a later user copy. Prefer a verified native insertion path where supported. Bound helper execution and avoid blocking Electron's event loop. Record dispatch vs actual insertion distinctly.

Native manual/integration matrix still REQUIRED: same/different app, window and AX field; selection changes; permission revoked; secure field; terminal/code literal field; destination exiting; app quitting; overlapping dictation; multi-format clipboard; user copy during paste; paste consumption delayed. Text matrix: leading/trailing whitespace, comma/period, paragraph/newline, emoji/combining marks and non-ASCII. Pure gate tests cover identity/selection/security/permission/clipboard ownership only; no real paste behavior is claimed.
