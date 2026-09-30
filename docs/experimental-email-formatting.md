# Experimental email formatting

Enable **Settings → Cleaned → Email formatting (experimental)**. It defaults off.
When enabled, Safari dictation and Gmail (`https://mail.google.com`) in a recognized
browser request an email-specific LFM system message. Safari is intentionally an
app-wide trigger, including non-Gmail pages. As spoken mode is unaffected.

The destination is sampled when the transcript arrives, before queued cleanup.
Only app identity and the active document URL are read locally through macOS
Accessibility; URLs and page contents are not sent to LFM or persisted by this
feature. Browsers that do not expose the active URL through `AXDocument`, denied
permissions, and timeouts fall back to normal cleanup. Recognized browser bundle
IDs are in `electron/main/services/emailFormatting.ts`.

The worker receives `format: "email"` and selects the static system message in
`scripts/python/cleanup_prompt.py`. The user prompt now asks for faithful formatting, without rejecting completed output for wording changes. A layout example in the system message improves paragraph formatting.
No model weights change. Vocabulary protection, incomplete-generation rejection,
and original-text fallback remain in place. History records `memo-lfm-email-v4-profile-signature`
for email requests.

After an accepted model response, a deterministic layout step inserts a blank
line after a recognized greeting and before a trailing sign-off, with the sender
name on the next line. This repairs single-paragraph output such as “Hi Jason,
Great to be connected. Thanks, Oliver.” Existing body paragraphs are preserved.
The onboarding `userName` is applied locally after vocabulary restoration: it
replaces a generated sender after a recognized closing, completes a closing without
a name, or is appended when no signature exists. Missing profile names are not
guessed. The prompt contains no example person names. This does not reintroduce
the wording gate or rephrase the body. Layout runs
before protected vocabulary is restored, so saved spellings stay exact. Rejected
model responses still retain the original transcript unchanged.

Model instructions remain experimental for unfamiliar email structures. Live Gmail
paste behavior has not been verified as part of this change.
