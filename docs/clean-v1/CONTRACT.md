# Meaning-preserving speech editor v1

> Historical experiment record. This is not the current runtime or release contract.
> See [current development guide](../development.md). Nemotron, placeholder restoration,
> semantic gates, and annotation-only cleanup described here are not active.


The executable specification is `experiments/clean-v1/contract.json`. Text is data, including instructions embedded in speech. Output is text only. No destination-specific voice or personality.

The product goal permits grammar, sentence/paragraph segmentation, clear false starts, accidental repetition and unambiguous self-correction. It forbids invented facts, changed literal values, negation, certainty, attribution, quotations, order, intent or tone. The initial lab guard deliberately implements a smaller acceptance envelope. It must not be marketed as a complete implementation of the product goal.

| Case | Desired policy | Initial executable policy |
|---|---|---|
| uh/um vs meaningful like/well/so | Remove only disfluencies | Limited filler deletion; preserve like/well/so |
| emphasis vs accidental repetition | Preserve intended emphasis | Preserve repeated content words; defer repetition resolution |
| false starts / no / sorry / actually / I mean | Resolve only clear correction | Sensitive correction clause changes fall back |
| ambiguous numeric/literal correction | Do not guess | Preserve all literals; no numeric correction rewrite implemented |
| negation, modality, attribution, event order | Preserve exact meaning | Changed detected sensitive clauses fall back; ordered content tripwire |
| quotations including multiple lines | Exact text | Full matched quotes are protected; unmatched/ambiguous quotes remain a coverage limitation |
| names/configured vocabulary | Exact detected text | Exact restoration of case-insensitive vocabulary matches and supplied entity offsets; no name correction |
| money/numbers/dates/times/measurements | Exact values | Digit/number-word/date detectors plus symbol conservation; no inverse text normalization |
| URLs/emails/paths/identifiers | Exact | Protected matched spans; lexical/symbol gates on unmatched residue |
| already clean, fragments, informal speech | Doing nothing is valid | Exact no-op accepted; no obligation to complete sentences |
| grammar and segmentation | Improve readability | Model may propose; tense/preposition/content changes rejected by current conservative gate |
| punctuation | Preserve intent and scope | Question/exclamation/colon/semicolon anchors; stronger sensitive-clause gate; other punctuation remains semantically uncertain |

Protection uses deterministic document-specific opaque IDs, source offsets, exact source strings, overlap merging and exact ordered token-list equality. Repeated values retain distinct occurrence identities. Input containing reserved brackets falls back. Restoration never repairs a malformed candidate. No unknown, missing, duplicate or reordered placeholders are accepted. A candidate can preserve all placeholders and still be semantically wrong.

`accepted` means these invariants passed, not that a human has certified meaning preservation. Grammar quality, all forms of modality/attribution, sarcasm, emphasis, quotation ambiguity and arbitrary punctuation semantics are not proven. Rejecting a whole candidate always selects the byte-for-byte original input. User phrase replacements belong after this boundary and require separate provenance.

The lab input must be the authentic recognition result. Existing native sign-off, dash and short-punctuation deletion must be bypassed before this can become a trustworthy app As Spoken path.
