"""CPU cache-aware RNNT with per-utterance vocabulary rescoring.

Streaming features follow Microsoft's MIT-licensed NeMo feature extractor:
onnxruntime-extensions/shared/api/nemo_mel_spectrogram.cc (58dfaaed).
"""
import json
import re
from pathlib import Path
import numpy as np
import onnxruntime as ort
from .vocabulary import Tokenizations, Vocabulary, VocabularyDecoder, vocabulary_strength


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
        self.pieces = [piece for piece, _ in vocabulary]
        self.tokenizations = Tokenizations(self.pieces, c['blank_id'])

    def session(self, phrases=(), strength=None, emit_fn=None):
        return Session(self, phrases, strength, emit_fn)


class Session:
    def __init__(self, model, phrases=(), strength=None, emit_fn=None):
        self.model = model
        self.c = c = model.cfg
        self.features = Features(c)
        strength = vocabulary_strength(strength)
        self.vocabulary = None
        if phrases and strength != 0:
            vocabulary = phrases if isinstance(phrases, Vocabulary) else Vocabulary(phrases)
            if vocabulary.entries:
                self.vocabulary = VocabularyDecoder(model, vocabulary, strength)
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
        frames = encoded[0, :int(lengths[0])]
        start = self.vocabulary.capture_frames(frames) if self.vocabulary else 0
        for index, frame in enumerate(frames, start):
            for _ in range(c['max_symbols_per_step']):
                prediction, h, cell = m.decoder.run(None, {'targets': np.array([[self.last]], np.int64), 'h_in': self.h, 'c_in': self.cell})
                logits = m.joiner.run(None, {'encoder_output': frame.reshape(1, 1, -1), 'decoder_output': prediction.reshape(1, 1, -1)})[0].reshape(-1)
                token = int(np.argmax(logits))
                if token == c['blank_id']:
                    break
                if self.vocabulary:
                    self.vocabulary.capture_emission(index, prediction, h, cell)
                self.last, self.h, self.cell = token, h, cell
                self.tokens.append(token)
        self.text = self.render(''.join(m.pieces[t] for t in self.tokens))
        self.emit('PARTIAL', self.text)

    @staticmethod
    def render(pieces):
        text = pieces.replace('▁', ' ')
        return re.sub(r'\s+', ' ', re.sub(r'<[a-z]{2}-[A-Z]{2}>', '', text)).strip()

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
        if self.vocabulary and self.tokens:
            self.text = self.render(self.vocabulary.resolve(self.tokens))
        self.emit('FINAL', self.text)
