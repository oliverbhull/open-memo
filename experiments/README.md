# Experiments

`clean-v1` through `clean-v4` and `shared` preserve historical cleanup research.
Their restoration/guard/annotation behavior is not part of the active LFM path.
Run their checks explicitly with `npm run test:experiments`.

`contextual-ctc` is different: the development app currently uses this recognition
prototype. It remains a development dependency with machine-specific setup and
does not establish parity with the bundled release backend.

Store generated corpora, weights and private replays in ignored `.build/`, never
beside source. Current setup and release boundaries are in
[`docs/development.md`](../docs/development.md).
