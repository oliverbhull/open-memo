# Contextual CTC prototype

This is a disposable, offline experiment. It does not change Granite, Memo's
production decoder, application settings, packaging, or phrase replacements.

It always computes Granite's normal greedy transcript first. When vocabulary is
provided, it also runs a small CTC beam search over the same model logits and
gives complete vocabulary terms a bounded score bonus.

## One-time setup

Reuse the existing Granite environment and install only the two experimental
decoder packages into the ignored `.build` directory:

```bash
uv pip install \
  --python /Users/oliverhull/models/asr/.venv-granite/bin/python \
  --target .build/contextual-ctc-python \
  --no-deps \
  pyctcdecode==0.5.0 pygtrie==2.6.1
```

This avoids changing or downgrading packages in the working Granite environment.
`kenlm` is intentionally not installed; this prototype has no language model.

## Verify token alignment

```bash
PYTHONPATH=.build/contextual-ctc-python \
  /Users/oliverhull/models/asr/.venv-granite/bin/python \
  experiments/contextual-ctc/prototype.py --self-test
```

The self-test verifies that Granite's byte-level BPE tokens map losslessly into
the experimental decoder's BPE boundary notation.

## Compare one recording

```bash
PYTHONPATH=.build/contextual-ctc-python \
  /Users/oliverhull/models/asr/.venv-granite/bin/python \
  experiments/contextual-ctc/prototype.py recording.wav \
  --vocab Rayaan \
  --vocab JTECH
```

Use `--json` for machine-readable results or `--vocab-file terms.txt` for one
term or phrase per line. With no vocabulary, the contextual result is exactly
the greedy result and beam search is skipped.

The default beam, boost, and token-pruning values are only a starting point
that recovered `rayaan` from a synthetic `rayon` confusion while preserving a
separate negative `rayon` example. They are not production-safe settings.

## Evaluation rule

Test both recordings containing the vocabulary and ordinary recordings where
the terms were not spoken. Compare exact entity recognition, false vocabulary
insertions, unrelated transcript changes, and contextual decoding time.

Do not integrate this into Memo unless a small beam improves entity recognition
without material false insertions or latency.

## Test through Memo in development

Run:

```bash
npm run dev
```

Development mode automatically uses the local Contextual Granite worker. Add
terms in Memo's Vocab settings, then dictate normally. The terminal logs both
the greedy and contextual transcripts when a vocabulary change is accepted.
The app worker uses the existing INT4 Core ML model, performs completed windows
during recording, and rejects contextual output that changes anything other
than a complete vocabulary term. Packaged builds continue to use Conomo.
