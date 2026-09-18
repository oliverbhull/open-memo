# Clean v2: word-preserving formatting

The model's only task is punctuation, capitalization and sentence boundaries. No filler deletion, grammar rewrite, spelling correction or inferred ASR repair. This is narrower than the eventual Clean Writing goal. A whole candidate is rejected on word-sequence, numeric, literal, quote, vocabulary, symbol or tested polarity-boundary violations.

Local experiment inputs and weights are under `.build/clean-v2/`. `prepare.py` authors synthetic development labels and may include explicitly supplied user regression examples. These are agent-authored/reviewed, not human-approved or audio-grounded. Held-out synthetic cases are independently authored and kept unread until candidate freeze. They do not establish universal speaker performance.

Internal promotion criteria declared before opening holdout: >=85% accepted on the independent 40-case set; >=75% exact authored target matches; zero selected word changes, protected-value changes or identified critical meaning errors in independent output review; useful punctuation on both supplied regression inputs; measured warm p95 <=250ms on this host. Compare against authentic raw text and existing PnC. These are internal experiment criteria, not shipping gates; native insertion, real audio/user preference and oldest-supported-Mac remain separate.

Model/guard/prompt hashes are frozen before holdout. Any subsequent change invalidates final status for that set. Old reports/benchmarks remain historical snapshots. New candidate is enabled only by `.build/clean-v2/LIVE.json`, which pins model/runtime hashes checked by the worker before readiness. Missing manifest uses existing formatter; corrupt artifacts cannot become ready.

Commands:
- `python3 experiments/clean-v2/prepare.py`
- local MLX `python -m mlx_lm lora --config .build/clean-v2/train-long.yaml`
- `python experiments/clean-v2/evaluate.py --model <local model> --adapter <local adapter> --data <explicit jsonl> --output <local result dir>`
- `npm run test:cleanup`

All training, model inference and evaluation remain local. No publishing or application installation.
