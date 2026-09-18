# Repository map

| Path | Responsibility |
| --- | --- |
| `electron/main/` | App lifecycle, service ownership, permissions, dictation delivery and SQLite persistence |
| `electron/preload/` | Typed, limited IPC bridge; no renderer Node access |
| `electron/renderer/` | Settings, onboarding, history and playback |
| `electron/shared/` | IPC types, canonical memo records and text selection |
| `sidecars/dictation/` | Owned Rust recorder, hotkey listener and speech-worker protocol |
| `sidecars/conomo/`, `sidecars/pnc/` | Bundled recognition and legacy punctuation support |
| `sidecars/device-sync/`, `sidecars/ble-bridge/` | Recorder transfer, firmware operations and Bluetooth bridge |
| `scripts/` | Build/release tooling and maintained service regression tests |
| `scripts/python/` | Active development LFM worker, prompt and completion validation |
| `tests/contextual-dictation/` | Recognition replay fixtures and runner |
| `experiments/contextual-ctc/` | Development recognition prototype currently selected by `npm run dev` |
| `experiments/clean-v1` through `clean-v4`, `experiments/shared/` | Historical cleanup candidates and their separate tests; not imported by the app |
| `docs/clean-v1/` | Historical decisions and measurements; not current instructions |
| `assets/`, `config/` | App artwork, entitlements and packaging configuration |

Generated files belong in ignored `.build/`, `dist/`, `dist-react/` and native
`target/` directories. Weights, private transcripts, credentials and machine-local
state are not source. Existing local material is retained rather than deleted.
Electron Builder's explicit file/resource allowlists determine shipping contents.

Start with [development](development.md) and [production audit](production-audit.md).
