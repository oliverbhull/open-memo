Historical experiment. The development app was switched back to [LFM cleanup](LFM_DEV.md) at Oliver’s request on 2026-09-11. The Nemotron instructions below no longer describe the active app.

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


# Test Nemotron dictation cleanup

From `/Users/oliverhull/dev/open-memo`, run:

```sh
npm run dev
```

In Settings, set **Writing → Clean — Nemotron**. Wait for the loading message to clear, then dictate normally. **As spoken** keeps the recognition text for comparison.

The development Clean path sends the raw Granite transcript to the installed Ollama model `nemotron-nano-4b:latest` with one instruction:

> Rewrite this dictation as the user intended it to be written, preserving their message. Return only the cleaned text.

Nemotron handles the whole cleanup, including punctuation and spoken addresses or identifiers. It receives no vocabulary list, examples, deletion rules, or conversation history. Development mode does not start or call the punctuation model. Existing user-configured phrase replacements and the optional spoken Enter action still apply afterward.

Startup checks local Ollama and starts its local server if necessary. It uses the installed model without downloading one. If cleanup is unavailable or a response fails basic transport/completion checks, the original transcript is retained. This is readying a development experiment for manual testing; it is not a claim of reliable meaning preservation.

This implementation supersedes the earlier proposals to split cleanup between models or restrict Nemotron to selecting deletions. Historical experiment files remain records of those earlier tests.

Checked through the actual cleanup service: “oliver at memonetworks dot com” became `oliver@memonetworks.com`. The two earlier supplied “dry underscore…” and “Robin, at example…” transcripts remained spelled out. The short instruction is ready for manual experimentation; those outcomes are not a general accuracy claim. No microphone-to-paste test was performed on your behalf.
