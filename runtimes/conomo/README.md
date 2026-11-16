# Conomo

An independently installable local streaming ASR runtime, used by Open Memo.
Memo supplies audio and vocabulary hints; Conomo owns model loading and decoding.
The current backend is Nemotron 3.5 ASR 0.6B ONNX INT4, running on CPU. Model code
lives entirely in this package. No audio is sent over the network.

## Memo installers and source builds

macOS installers include Conomo's Python environment, service, worker bridge and
verified model weights. Nothing needs to be downloaded when an installed app
starts. Each app connects through `conomo --worker`; the bridge starts one detached
runtime process if necessary. The shared process survives a client disconnect;
streaming state and phrase history are separate for every utterance/client.
Bundled Memo uses a private socket under `~/Library/Application Support/Memo/asr/`,
identified by runtime code and model manifest. It does not connect to the standalone
Conomo/Memo Agent socket. An app update with different code or weights starts a
separate compatible runtime automatically. `CONOMO_SOCKET` remains an explicit
operator override.

Build from the repository root:

```sh
npm ci
npm run build:conomo
```

The build fetches the public model revision pinned in
[`conomo/model-manifest.json`](conomo/model-manifest.json), verifies every file's
size and SHA-256, and publishes the complete model directory after verification.
A verified cache avoids another download. Corrupt or partial files are rejected;
failed downloads never publish a partial installation. Model changes require an
explicit manifest update, including a new revision and file hashes.

To reuse a local model, set `CONOMO_MODEL_SOURCE=/path/to/model`. Add
`CONOMO_OFFLINE=1` to disallow model downloads. The Python runtime and dependency
wheels must also be cached for a fully offline first build. Private runtime-archive
tokens are not required. Weights, caches, captured audio and transcripts are not
committed to the repository.

Windows installers bundle the native NeMo worker, its DLLs, and pinned Nemotron
GGUF weights under the same Conomo resource name. Both platforms verify packaged
model assets. Windows retains Whisper Base for explicit selection and fallback.

## Standalone package

On macOS with Python 3.12 or newer:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/conomo-model --destination ./models/pinned
.venv/bin/conomo-server --model ./models/pinned --socket "$HOME/Library/Application Support/Conomo/speech.sock"
```

Run the server independently of its clients. `CONOMO_WORKER` can point Memo at an
external `conomo-worker` executable; `CONOMO_SOCKET` overrides the private socket.
A running runtime with a different model revision must be restarted before use.
Models keep their original license; consult the pinned model card included with
the downloaded files. Package source is MIT; see `THIRD_PARTY_NOTICES`.

## Streaming and vocabulary

The JSON-lines Unix-socket protocol uses `hello`, `context`, `start`, `audio`,
`end`, `abort` and `status`. Audio is 16 kHz mono PCM16LE, base64 in `pcm16le`.
The worker emits `READY`, incremental `PARTIAL` text and one `FINAL` per completed
utterance. It streams in 560 ms model chunks. `end` processes the remaining
audio and scores vocabulary candidates. Clients handle microphone selection
and endpoint detection.

`context` takes a `phrases` array (maximum 256 phrases, 160 characters each).
The service prepares the list on receipt and freezes it at `start`. Edits apply
to the next utterance. Memo forwards saved Vocabulary settings for dictation
and device batches. Callers can omit `strength` for automatic selection or pass
a finite nonnegative ceiling on the score gap, with zero disabling vocabulary.

The decoder considers saved spellings close to complete recognized spans and
scores alternate wordpiece paths against the same encoded audio. The competing
paths must pass a score gap check before the saved spelling can win. The
automatic allowance uses spelling similarity and mid-sentence capitalization
as context. The final transcript uses the saved casing for matched entries.

## Validation

```sh
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v
```

Tests cover cancellation, source isolation, frozen vocabulary, whole-word
candidate scoring, pinned downloads, cache corruption,
interrupted downloads and offline local reuse. CI runs them with the bundled
Python environment. No personal recordings or history are required.

A local synthetic replay demonstrated partial text before the utterance ended and
about 90 ms to process its tail. Phrase hints corrected an uncommon name but did
not fix every hinted phrase. These checks do not establish human-speech accuracy
or latency under every workload. Silence endpoint time belongs to the client and
is additional to tail decoding time.

The feature extractor follows Microsoft's MIT-licensed
onnxruntime-extensions `shared/api/nemo_mel_spectrogram.cc` at
58dfaaed11614e32270acb9d6a50b2a8bc7dd64e. RNNT state updates follow
onnxruntime-genai's `src/models/nemotron_speech.cpp`.
