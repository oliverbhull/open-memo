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

`npm run dev` is the existing local development experience. It first checks
contextual Granite and LFM assets, builds native helpers, then starts Electron
and Vite. It is not a clean-checkout bootstrap: the recognition prototype still
requires development Python/model assets, and trained cleanup weights are not
distributed by this repository. Read the setup scripts before supplying paths.
Missing assets must be provisioned explicitly; do not copy private training data
into source to make startup pass.

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

`build:dir` builds an unsigned application directory. CI uses protocol-only Conomo
and cleanup fixtures to validate packaging shape; those fixtures do not recognize
or clean speech. Signed builds reject fixtures. Actual releases download immutable
ASR and cleanup bundles by SHA-256, sign nested native code, sign the app, notarize
it, and verify the updater ZIP/DMG manifest before upload.

Packaged Clean mode runs the bundled 6-bit LFM entirely offline. As spoken mode
uses the bundled punctuation model. Neither model bundle is stored in Git.
