# Dictation formatting without a wording gate

Cleaned mode asks LFM for punctuation, capitalization, and paragraph breaks while
preserving meaning. Completed model output is delivered without comparing its
words against the original transcript. The wording gate was removed at the user's
request: a wording difference must not replace formatted output with raw speech.

The word-comparison helper remains an offline evaluation diagnostic only. It is
not imported or invoked by the runtime worker. This change does not establish
that model rewrites always preserve meaning; the prompt and model evaluations
remain the tools for improving that behavior.

The source-sized output budget, deadline, empty/oversized response checks,
incomplete-generation detection, and saved-vocabulary placeholder protection
remain. Technical failures still retain the original transcript. Email line-break
formatting remains in place after completed output is accepted.

History records `memo-lfm-faithful-v2-ungated` or `memo-lfm-email-v4-profile-signature`.
Development workers need restarting to load these changes; packaged applications
need an updated bundle.
