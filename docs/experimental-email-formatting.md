# Experimental email formatting

On macOS, enable **Writing → Groq cleanup** and **Email formatting** in Settings.
Email formatting defaults off. In Safari and in Gmail on supported browsers,
Memo selects an email prompt for Groq cleanup. Safari is an app-wide trigger.

Memo samples the destination when recognition finishes, before the dictation
enters the delivery queue. macOS Accessibility reads app identity and the active
document URL locally. Groq receives the transcript text with protected vocabulary
placeholders and a static email prompt. Memo keeps the URL, page contents, and
profile name out of the request. Missing destination information, permission
errors, or timeouts select the ordinary cleanup prompt.

After successful cleanup, Memo adjusts line breaks, preserves the dictated
opening, and applies the profile signature locally after vocabulary restoration
and spelling. A failed cleanup uses the ordinary local punctuation path.
History identifies accepted or fallback email cleanup with the
`memo-groq-email-v1` contract.
