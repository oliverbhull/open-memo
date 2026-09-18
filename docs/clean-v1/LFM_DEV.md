# Test LFM dictation cleanup

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


From `/Users/oliverhull/dev/open-memo`, run `npm run dev`.

Select **Settings → Writing → Clean — LFM**, wait for the loading message to clear, then dictate normally. **As spoken** is available for comparison.

Development logs now include `[Dictation comparison]` for each completed dictation, as explicitly requested by Oliver. It contains `rawGranite` (recognition text, not audio ground truth), `lfmOutput` (null when no cleanup result was accepted), `finalText` (after phrase replacements and spoken-Enter handling), cleanup status/reason/timing, and the delivery outcome. A fallback may include the model's unselected candidate, when generation produced one. The same ID identifies the memo. Text is JSON-escaped and this comparison is disabled in packaged builds.

This uses the previous local LFM2.5 1.2B model: the 8-bit model fused with the step-1024 cleanup adapter. It uses the original cleanup prompt on the actual Granite transcript, without vocabulary/number placeholders. On 2026-09-11, Oliver explicitly requested removing the semantic safety gate. Completed edits are now delivered without that rejection step. The model and Python runtime are already installed; startup does not require Ollama or download models.

The development path is Granite → LFM cleanup → paste. Unavailable, timed-out, empty, incomplete or malformed cleanup still retains the original Granite transcript. There is no placeholder restoration or semantic rejection step. Vocabulary still informs Granite recognition; LFM receives the resulting text directly. There is no additional punctuation model in this development path.

The cleanup deadline now scales with transcript length: `max(750, 350 + 12 × words)` milliseconds, capped at 5 seconds. For example, 100 words get up to 1.55 seconds; short dictations retain the 750 ms allowance. These are maximum processing times, not added delays: completed text is returned immediately. This is an initial development budget to measure on actual hardware, not a promise that all supported lengths finish within it.

Generation uses the same MLX decoding routine as before, but now checks whether it reached the model's end marker. If it merely hits its token limit, the partial text is not pasted. The model, its prompt and the maximum output-token setting are unchanged.

Processing stays visible through cleanup and delivery. Clean mode checks the captured app name and any available window title in the same macOS request that pastes. If the destination no longer matches, text remains on the clipboard and in Memo for manual paste. This checks app/window identity, not the exact text field or caret position within that window.

The current native dictation backend now obtains the foreground app directly from macOS instead of launching two AppleScript lookups. It leaves window titles empty to avoid blocking or using a stale title. Consequently the automatic-paste check currently detects app changes, not tab/window/field changes within the same app. The native app name matched System Events in the live comparison, and the complete context lookup measured 6.5 ms in that check, versus the earlier separate-script measurements of 311–363 ms. This is a component measurement; full stop-to-paste latency still needs a fresh live dictation log. New logs include `context_lookup_ms` and the cleanup word count/deadline.

This is the earlier LFM model for manual testing, with the semantic gate removed. Its model and prompt have not been retuned. App request ordering and stopped-worker isolation are retained. The cleanup contract is `memo-lfm-hybrid-v3-plain-text` so new history can be distinguished from guarded output.

Historical restoration checks, before gate removal, are saved in `.build/lfm-restore/live-smoke.json`. The short formatting question lost its final “is it”; removing the gate does not change the model itself. Direct-output baseline results are in `.build/lfm-direct/live-smoke.json`. The completion-handling replay in `.build/lfm-hone/live-smoke.json` produced identical text on all three supplied examples. This verifies those examples, not general accuracy.

On 2026-09-11, the Suffolk/Memo paragraph reproduced a restoration failure: LFM omitted the first of two Suffolk placeholders. The plain-text replay accepted the paragraph in 449 ms and preserved both Suffolk mentions and Memo. Five local replays completed, but the email example still became ‘Oliver at memonetworks.com’ rather than a complete email address, and the formatting question still lost its trailing question. These are known model-quality limitations, not delivery failures. Results: .build/lfm-restoration/direct.jsonl. The former number/correction normalizer is no longer applied; number and literal fidelity require further real dictation testing.
