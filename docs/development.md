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

`npm run test:cleanup` runs the dictation formatting path against a local mock
Groq server. `npm run test:experiments` runs historical cleanup experiments separately.

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
streaming, endpoint ownership, phrase boosting, and test commands.

The local punctuation path runs by default and when optional Groq cleanup fails.
Packaged builds omit transcript comparison logs.

## Packaging boundary

`build:dir` builds an unsigned application directory. CI builds with the real
pinned Conomo model, validates its file hashes, and checks that the packaged worker
starts. The full installer includes the runtime and both models for offline
installation. The slim updater downloads and verifies separately versioned
model assets before switching to the new app.

The release workflow downloads a versioned Conomo bundle from the private
artifact repository. Set `CONOMO_BUNDLE_ASSET_ID` and `CONOMO_BUNDLE_SHA256`
as release secrets for the selected archive and use a read-only `CONOMO_TOKEN`.
The build verifies the archive and its worker before packaging. Local builds
and pull request CI can use the default development bundle without these secrets.

The release signs nested native code, signs and notarizes the app, and verifies
both artifacts before upload. Memo verifies the bundled content manifest before
using it. Conomo validates the pinned model hashes before starting its model
process; it does not silently load a different revision. Model weights and build
artifacts are excluded from Git.
