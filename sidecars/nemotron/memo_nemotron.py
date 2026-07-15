"""Cache-aware Nemotron ONNX worker for Memo's Rust capture process.

stdin is newline-delimited JSON with one session per transmission:
``start`` -> one or more base64 PCM16LE ``audio`` messages -> ``end``.
stdout stays machine-readable: READY, PARTIAL:{json}, FINAL:{json}, or ERROR:text.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

import numpy as np

_LANG_TAG = re.compile(r"<[a-z]{2}(?:-[A-Z]{2})?>")
_MAX_AUDIO_MESSAGE_BYTES = 2 * 1024 * 1024


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(prefix: str, text: str) -> None:
    text = text.strip()
    if text or prefix == "FINAL:":
        print(prefix + json.dumps({"processedText": text}), flush=True)


def decode_pcm(message: dict) -> np.ndarray:
    encoded = message.get("pcm16le")
    if not isinstance(encoded, str):
        raise ValueError("audio event requires a base64 pcm16le string")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > _MAX_AUDIO_MESSAGE_BYTES:
        raise ValueError("audio event exceeds the 2 MiB limit")
    if len(raw) % 2:
        raise ValueError("pcm16le audio must contain complete 16-bit samples")
    return np.frombuffer(raw, dtype="<i2")


class OnnxGenAIModel:
    def __init__(self, model_dir: Path):
        log(f"loading {model_dir.name} via ONNX Runtime GenAI ...")
        import onnxruntime_genai as og

        self.og = og
        config = og.Config(str(model_dir))
        config.clear_providers()
        self.model = og.Model(config)
        self.tokenizer = og.Tokenizer(self.model)
        self.chunk_samples = 8960
        config_path = model_dir / "genai_config.json"
        if config_path.exists():
            data = json.loads(config_path.read_text())
            configured_chunk_samples = int(
                data.get("model", {}).get("chunk_samples", self.chunk_samples)
            )
            if 160 <= configured_chunk_samples <= 160_000:
                self.chunk_samples = configured_chunk_samples

    def new_session(self) -> "OnnxStreamingSession":
        return OnnxStreamingSession(self)


class OnnxStreamingSession:
    """One transmission with persistent processor and generator caches."""

    def __init__(self, owner: OnnxGenAIModel):
        self.owner = owner
        self.processor = owner.og.StreamingProcessor(owner.model)
        self.processor.set_option("use_vad", "false")
        self.token_stream = owner.tokenizer.create_stream()
        self.generator = owner.og.Generator(
            owner.model, owner.og.GeneratorParams(owner.model)
        )
        self.generator.set_runtime_option("lang_id", "0")
        self.buffer = np.zeros(0, dtype=np.float32)
        self.pieces: list[str] = []
        self.closed = False

    def feed(self, pcm_i16: np.ndarray) -> str:
        if self.closed:
            return ""
        pieces_before = len(self.pieces)
        audio = np.asarray(pcm_i16, dtype=np.int16).astype(np.float32) / 32768.0
        if len(audio):
            self.buffer = np.concatenate([self.buffer, audio])
        while len(self.buffer) >= self.owner.chunk_samples:
            chunk = self.buffer[: self.owner.chunk_samples]
            self.buffer = self.buffer[self.owner.chunk_samples :]
            self._process(self.processor.process(chunk))
        return self.text if len(self.pieces) > pieces_before else ""

    def finish(self) -> str:
        if self.closed:
            return self.text
        if len(self.buffer):
            tail = self.buffer
            if len(tail) < self.owner.chunk_samples:
                tail = np.pad(tail, (0, self.owner.chunk_samples - len(tail)))
            self.buffer = np.zeros(0, dtype=np.float32)
            self._process(self.processor.process(tail))
        self._process(self.processor.flush())
        self.closed = True
        return self.text

    @property
    def text(self) -> str:
        return _LANG_TAG.sub("", "".join(self.pieces)).strip()

    def _process(self, inputs) -> None:
        if inputs is None:
            return
        self.generator.set_inputs(inputs)
        while not self.generator.is_done():
            self.generator.generate_next_token()
            tokens = self.generator.get_next_tokens()
            if len(tokens):
                piece = self.token_stream.decode(tokens[0])
                if piece:
                    self.pieces.append(piece)


class StreamingWorker:
    def __init__(self, model: OnnxGenAIModel):
        self.model = model
        self.session: OnnxStreamingSession | None = None

    def handle(self, message: dict) -> tuple[str, str] | None:
        kind = message.get("type")
        if kind == "start":
            self.session = self.model.new_session()
            return None
        if kind == "audio":
            if self.session is None:
                return None
            text = self.session.feed(decode_pcm(message))
            return ("PARTIAL:", text) if text else None
        if kind == "end":
            if self.session is None:
                return ("FINAL:", "")
            session, self.session = self.session, None
            return ("FINAL:", session.finish())
        if kind == "abort":
            self.session = None
            return None
        raise ValueError(f"unknown worker event: {kind!r}")


def run_worker(model: OnnxGenAIModel) -> None:
    worker = StreamingWorker(model)
    print("READY", flush=True)
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line or line.startswith(b"VOCAB:"):
            continue
        try:
            result = worker.handle(json.loads(line))
            if result is not None:
                emit(*result)
        except Exception as error:
            worker.session = None
            print(f"ERROR:{error}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()

    if not args.worker:
        parser.error("Memo launches this script with --worker")
    model_path = Path(args.model_path).expanduser()
    if not (model_path / "genai_config.json").is_file():
        log(f"Nemotron ONNX model is missing genai_config.json: {model_path}")
        return 1
    model = OnnxGenAIModel(model_path)
    log("nemotron ONNX ready")
    run_worker(model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
