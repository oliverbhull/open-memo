"""CPU cache-aware RNNT with per-utterance phrase biasing at the joiner logits.

Streaming features follow Microsoft's MIT-licensed NeMo feature extractor:
onnxruntime-extensions/shared/api/nemo_mel_spectrogram.cc (58dfaaed).
"""
import json
import re
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer, models


class PhraseBias:
    """Match phrase prefixes across every valid wordpiece segmentation.

    The exported tokenizer has synthetic unigram scores, so using just its
    preferred encoding misses larger pieces emitted by the acoustic decoder.
    """
    def __init__(self, tokenizer, phrases=(), strength=2.0):
        self.strength = float(strength)
        if not np.isfinite(self.strength) or not 0 <= self.strength <= 5:
            raise ValueError('Boost strength must be between 0 and 5')
        self.pieces = {i: tokenizer.id_to_token(i).casefold() for i in range(tokenizer.get_vocab_size())}
        self.prefixes = {}
        self.max_length = 1
        vocabulary = {}
        for token, piece in self.pieces.items():
            if piece and '<' not in piece:
                vocabulary.setdefault(piece, []).append(token)
        for phrase in phrases:
            text = '▁' + '▁'.join(phrase.casefold().split())
            self.max_length = max(self.max_length, len(text))
            for position in range(len(text)):
                prefix, remaining = text[:position], text[position:]
                candidates = self.prefixes.setdefault(prefix, set())
                for end in range(1, len(remaining) + 1):
                    piece = remaining[:end]
                    if position or piece != '▁':
                        candidates.update(vocabulary.get(piece, ()))
        self.history = ''

    def apply(self, logits, blank):
        if not self.prefixes or not self.strength:
            return logits
        result = logits.copy()
        candidates = {}
        for prefix, tokens in self.prefixes.items():
            if not prefix or self.history.endswith(prefix):
                reward = self.strength * (0.6 if not prefix else 1.0)
                for token in tokens:
                    candidates[token] = max(candidates.get(token, 0), reward)
        for token, reward in candidates.items():
            if token != blank:
                result[token] += reward
        return result

    def accept(self, token):
        self.history = (self.history + self.pieces[token])[-self.max_length:]


class Features:
    def __init__(self, cfg):
        self.c = cfg
        self.previous = np.float32(0)
        self.overlap = np.zeros(cfg['fft_size'] // 2, np.float32)
        self.cache = np.zeros((cfg['pre_encode_cache_size'], cfg['num_mels']), np.float32)
        self.window = np.hanning(cfg['win_length']).astype(np.float32)
        maxmel = 15 + np.log(cfg['sample_rate'] / 2000) / 0.06875177742094912
        m = np.linspace(0, maxmel, cfg['num_mels'] + 2)
        hz = np.where(m < 15, m * (200 / 3), 1000 * np.exp((m - 15) * 0.06875177742094912))
        bins = np.arange(cfg['fft_size'] // 2 + 1) * cfg['sample_rate'] / cfg['fft_size']
        lower = (bins[None, :] - hz[:-2, None]) / np.diff(hz)[:-1, None]
        upper = (hz[2:, None] - bins[None, :]) / np.diff(hz)[1:, None]
        self.filters = (np.maximum(0, np.minimum(lower, upper)) * (2 / (hz[2:] - hz[:-2]))[:, None]).astype(np.float32)

    def process(self, audio):
        c = self.c
        emphasized = audio - c['preemph'] * np.concatenate(([self.previous], audio[:-1]))
        self.previous = audio[-1]
        offset = (c['fft_size'] - c['win_length']) // 2
        padded = np.concatenate((self.overlap, emphasized, np.zeros(offset, np.float32)))
        self.overlap = emphasized[-len(self.overlap):].copy()
        frames = np.lib.stride_tricks.sliding_window_view(padded[offset:], c['win_length'])[::c['hop_length']]
        spectrum = np.fft.rfft(frames * self.window, n=c['fft_size'])
        power = (spectrum.real ** 2 + spectrum.imag ** 2).astype(np.float32)
        mel = np.log(power @ self.filters.T + c['log_eps']).astype(np.float32)
        result = np.concatenate((self.cache, mel))[None, :, :]
        self.cache = mel[-c['pre_encode_cache_size']:].copy()
        return result


class Model:
    def __init__(self, path):
        self.path = str(Path(path).resolve())
        self.cfg = json.loads((Path(path) / 'genai_config.json').read_text())['model']
        c = self.cfg
        if c['sample_rate'] != 16000 or c['type'] != 'nemotron_speech':
            raise ValueError('Expected a 16 kHz Nemotron speech model')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.encoder = ort.InferenceSession(str(Path(path) / c['encoder']['filename']), options, providers=['CPUExecutionProvider'])
        self.decoder = ort.InferenceSession(str(Path(path) / c['decoder']['filename']), options, providers=['CPUExecutionProvider'])
        self.joiner = ort.InferenceSession(str(Path(path) / c['joiner']['filename']), options, providers=['CPUExecutionProvider'])
        vocabulary = json.loads((Path(path) / 'tokenizer.json').read_text())['model']['vocab']
        self.tokenizer = Tokenizer(models.Unigram([(p, float(s)) for p, s in vocabulary], unk_id=0))
        self.pieces = [item[0] for item in json.loads((Path(path) / 'tokenizer.json').read_text())['model']['vocab']]

    def session(self, phrases=(), strength=2.0, emit_fn=None):
        return Session(self, phrases, strength, emit_fn)


class Session:
    def __init__(self, model, phrases=(), strength=2.0, emit_fn=None):
        self.model = model
        self.c = c = model.cfg
        self.features = Features(c)
        self.bias = PhraseBias(model.tokenizer, phrases, strength)
        self.emit = emit_fn or (lambda *_args: None)
        self.buffer = np.empty(0, np.float32)
        self.tokens = []
        self.text = ''
        self.channel = np.zeros((1, c['encoder']['num_hidden_layers'], c['left_context'], c['encoder']['hidden_size']), np.float32)
        self.time = np.zeros((1, c['encoder']['num_hidden_layers'], c['encoder']['hidden_size'], c['conv_context']), np.float32)
        self.length = np.zeros(1, np.int64)
        self.h = np.zeros((c['decoder']['num_hidden_layers'], 1, c['decoder']['hidden_size']), np.float32)
        self.cell = self.h.copy()
        self.last = c['blank_id']

    def decode(self, audio):
        c, m = self.c, self.model
        mel = self.features.process(audio)
        encoded, lengths, self.channel, self.time, self.length = m.encoder.run(None, {
            'audio_signal': mel, 'length': np.array([mel.shape[1]], np.int64),
            'cache_last_channel': self.channel, 'cache_last_time': self.time,
            'cache_last_channel_len': self.length, 'lang_id': np.array([0], np.int64)})
        for frame in encoded[0, :int(lengths[0])]:
            for _ in range(c['max_symbols_per_step']):
                prediction, h, cell = m.decoder.run(None, {'targets': np.array([[self.last]], np.int64), 'h_in': self.h, 'c_in': self.cell})
                logits = m.joiner.run(None, {'encoder_output': frame.reshape(1, 1, -1), 'decoder_output': prediction.reshape(1, 1, -1)})[0].reshape(-1)
                token = int(np.argmax(self.bias.apply(logits, c['blank_id'])))
                if token == c['blank_id']:
                    break
                self.last, self.h, self.cell = token, h, cell
                self.tokens.append(token)
                self.bias.accept(token)
        text = ''.join(m.pieces[t] for t in self.tokens).replace('▁', ' ')
        self.text = re.sub(r'\s+', ' ', re.sub(r'<[a-z]{2}-[A-Z]{2}>', '', text)).strip()
        self.emit('PARTIAL', self.text)

    def feed(self, pcm):
        self.buffer = np.concatenate((self.buffer, pcm.astype(np.float32) / 32768))
        chunk = self.c['chunk_samples']
        while len(self.buffer) >= chunk:
            self.decode(self.buffer[:chunk])
            self.buffer = self.buffer[chunk:]

    def finish(self):
        if len(self.buffer):
            self.decode(np.pad(self.buffer, (0, self.c['chunk_samples'] - len(self.buffer))))
        self.buffer = np.empty(0, np.float32)
        self.emit('FINAL', self.text)
