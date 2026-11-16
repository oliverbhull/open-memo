# Development

## Requirements and checks

Use an Apple silicon Mac with macOS 15+, Node.js 22.12 or newer, Python 3,
Rust 1.88+, Xcode command-line tools and the native build prerequisites in CI.
`npm ci` installs the locked JavaScript dependencies. `npm run check` runs both
TypeScript configurations and maintained application tests without starting Memo.

```sh
npm ci
npm run check
cargo test --locked --manifest-path sidecars/dictation/Cargo.toml
npm run build:ts
npm run build:renderer
```

`npm run test:cleanup` tests the active LFM transport/completion contract without
weights. `npm run test:experiments` runs historical cleanup experiments separately.
An optional `MEMO_LFM_SMOKE=1 npm run test:cleanup` uses local model assets; it
checks basic integration, not audio-grounded accuracy or release readiness.

## Local dictation

`npm run dev` builds the standalone Conomo runtime before starting Memo. Conomo
owns the shared streaming ASR process and vocabulary decoder. Memo supplies audio
and hints through the worker/socket interface; model selection stays in Conomo.

`npm run build:conomo` provisions a managed Python 3.12 runtime and fetches the
public model revision pinned in `runtimes/conomo/conomo/model-manifest.json`.
Every file is checked for size and SHA-256 before installation, including cache
hits. `CONOMO_MODEL_SOURCE=/path/to/existing/model` reuses verified local files;
`CONOMO_OFFLINE=1` prohibits model downloads and fails if required files are missing
or corrupt. Python dependencies must already be cached for an entirely offline
first build. No private model-archive secret is needed.

See [the Conomo package](../runtimes/conomo/README.md) for standalone installation,
streaming, endpoint ownership, phrase boosting, and test commands. Existing
punctuation and optional cleanup prerequisites still apply.

The LFM worker source is `scripts/python/transcript-cleanup-worker.py`, with the
unchanged trained prompt in `cleanup_prompt.py` and technical completion checks
in `cleanup_completion.py`. The current contract is
`memo-lfm-hybrid-v3-plain-text`. It receives plain recognition text, uses greedy
decoding, and falls back to the original input on technical failure. It does not
run Nemotron, a semantic rejection gate, or placeholder restoration.

`MEMO_CLEANUP_PYTHON`, `MEMO_CLEANUP_FUSED_MODEL`, and (for explicit unfused use)
`MEMO_CLEANUP_MODEL` / `MEMO_CLEANUP_ADAPTER` select local dependencies. The
fused step-1024 6-bit path and trimmed cleanup runtime are the development
defaults and the packaged production candidate. The fused 8-bit path remains the
development rollback reference. Full recognition/candidate/delivery comparisons are
development diagnostics and must not be enabled in production by default.

For the smaller production candidate, see
[`cleanup-production-candidate.md`](cleanup-production-candidate.md). The 6-bit
and mixed-precision build commands are offline and refuse to overwrite existing
artifacts.

## Packaging boundary

`build:dir` builds an unsigned application directory. CI builds with the real
pinned Conomo model, validates its file hashes, and checks that the packaged worker
starts. Every release ZIP and DMG includes the runtime, ASR model and punctuation
model. Users do not need Python or a first-launch model download. Dictation works
offline after installation.

The release signs nested native code, signs and notarizes the app, and verifies
both artifacts before upload. Memo verifies the bundled content manifest before
using it. Conomo validates the pinned model hashes before starting its model
process; it does not silently load a different revision. Model weights and build
artifacts are excluded from Git.

As spoken uses the included punctuation model. Cleaned downloads an optional 6-bit
LFM model when selected and then runs it offline. Model bundles are not stored in Git.
