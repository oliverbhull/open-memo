"""Socket isolation/dedup tests; no heavy model loaded in this suite."""
import base64
from pathlib import Path
import tempfile
import threading
import unittest

from conomo.client import SpeechClient

from conomo import server as shared
from types import SimpleNamespace
from conomo.vocabulary import Tokenizations, Vocabulary, VocabularyDecoder
import numpy as np

class FakeSession:
    instances = []
    def __init__(self, vocabulary, strength=None, emit_fn=None):
        self.phrases = list(vocabulary.phrases)
        self.instances.append(self)
        self.output = emit_fn
        self.text = ''

    def feed(self, samples):
        self.text += 'word '
        self.output('PARTIAL', self.text.strip())

    def finish(self):
        self.output('FINAL', self.text.strip())


class SharedSpeechTest(unittest.TestCase):
    def setUp(self):
        FakeSession.instances.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / 's.sock')
        core = object.__new__(shared.SharedModel)
        core.path = '/model'
        core.chunk_samples = 8960
        core.lock = threading.RLock()
        core.memo_owner = None
        core.epoch = 0
        core.quiet_until = 0
        core.clients = {}
        core.backend = SimpleNamespace(session=FakeSession)
        self.server = shared.Server(self.path, shared.Handler)
        self.server.core = core
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def audio(self, client):
        return client.request({'type': 'audio', 'pcm16le': base64.b64encode(b'\x01\x00' * 320).decode()})

    def test_microphone_overlap_is_suppressed_but_system_audio_survives(self):
        with SpeechClient(self.path, source='microphone') as mic, \
                SpeechClient(self.path, source='memo') as memo, \
                SpeechClient(self.path, source='system') as system:
            mic.request({'type': 'start'})
            self.audio(mic)
            memo.request({'type': 'start'})
            self.assertTrue(self.audio(mic)['suppressed'])
            system.request({'type': 'start'})
            self.audio(system)
            self.audio(memo)
            self.assertEqual(memo.request({'type': 'end'})['text'], 'word')
            self.assertEqual(mic.request({'type': 'end'})['text'], '')
            self.assertEqual(system.request({'type': 'end'})['text'], 'word')
            self.assertEqual(memo.request({'type': 'status'})['model_loads'], 1)

    def test_abort_and_new_utterance_cannot_reuse_prior_words(self):
        with SpeechClient(self.path) as memo:
            memo.request({'type': 'start'})
            self.audio(memo)
            memo.request({'type': 'abort'})
            memo.request({'type': 'start'})
            self.audio(memo)
            self.assertEqual(memo.request({'type': 'end'})['text'], 'word')
            self.assertFalse(memo.request({'type': 'status'})['dictation_active'])

    def test_bad_audio_releases_claim_and_status_client_cannot_capture(self):
        with SpeechClient(self.path) as memo, SpeechClient(self.path, source='status') as status:
            memo.request({'type': 'start'})
            with self.assertRaises(RuntimeError):
                memo.request({'type': 'audio', 'pcm16le': 'bad!'})
            self.assertFalse(status.request({'type': 'status'})['dictation_active'])
            with self.assertRaises(RuntimeError):
                status.request({'type': 'start'})

    def test_vocabulary_is_isolated_and_frozen_at_start(self):
        with SpeechClient(self.path) as memo, SpeechClient(self.path, source='system') as system:
            response = memo.request({'type': 'context', 'phrases': ['Memo']})
            self.assertTrue(response['vocabulary_boosting'])
            memo.request({'type': 'start'})
            memo.request({'type': 'context', 'phrases': []})
            self.audio(memo)
            self.assertEqual(FakeSession.instances[-1].phrases, ['Memo'])
            system.request({'type': 'start'})
            self.audio(system)
            self.assertEqual(FakeSession.instances[-1].phrases, [])
            # The active utterance retains its snapshot; other clients start empty.
            self.assertEqual(system.request({'type':'context', 'phrases': []})['phrase_count'], 0)
            with self.assertRaises(RuntimeError):
                system.request({'type':'context', 'phrases': ['Memo'], 'strength': -1})
            memo.request({'type':'end'})
            self.assertEqual(memo.request({'type':'context', 'phrases': []})['phrase_count'], 0)
            memo.request({'type':'start'})
            self.audio(memo)
            self.assertEqual(FakeSession.instances[-1].phrases, [])

    def test_structured_vocabulary_is_not_replaced_by_window_prompt(self):
        with SpeechClient(self.path) as memo:
            memo.request({'type':'context', 'phrases':['Memo, Inc.']})
            result = memo.request({'type':'context', 'prompt':'Vocabulary: unrelated window text.'})
            self.assertEqual(result['phrase_count'], 1)
            memo.request({'type':'start'})
            self.audio(memo)
            self.assertEqual(FakeSession.instances[-1].phrases, ['Memo, Inc.'])
            memo.request({'type':'end'})

class VocabularyDecoderTest(unittest.TestCase):
    def decoder(self, pieces, phrases):
        model = SimpleNamespace(pieces=pieces, tokenizations=Tokenizations(pieces, blank=0))
        decoder = VocabularyDecoder(model, Vocabulary(phrases), strength=None)
        decoder.capture_frames(np.arange(12).reshape(-1, 1))
        for frame in (0, 3, 4, 5, 8):
            decoder.capture_emission(frame, None, None, None)
        return decoder

    def test_same_candidate_needs_different_boost_on_different_audio(self):
        decoder = self.decoder(
            ['<blank>', '▁Ask', '▁Shiv', 'any', 'ani', '▁tomorrow'], ['Shivani'],
        )
        original = [1, 2, 3, 5]
        compared_frames = []

        def probability(frames, tokens, _predictors):
            compared_frames.append(tuple(frames[:, 0]))
            return -1.0 if tokens == (2, 3, 5) else -candidate_cost

        decoder.log_probability = probability
        candidate_cost = 10.0
        self.assertEqual(decoder.resolve(original), '▁Ask▁Shivani▁tomorrow')
        self.assertEqual(len(set(compared_frames)), 1)
        candidate_cost = 18.0
        self.assertEqual(decoder.resolve(original), '▁Ask▁Shivany▁tomorrow')

    def test_exact_entry_stays_whole_and_preserves_surrounding_text(self):
        pieces = ['<blank>', '▁an', '▁ARCGIS', '▁map', '.', '▁Plan']
        decoder = self.decoder(pieces, ['ArcGIS', 'ArcGIS map', 'map plan'])
        decoder.log_probability = lambda *_: self.fail('An exact entry needs no rescoring')
        self.assertEqual(decoder.resolve([1, 2, 3, 4, 5]), '▁an▁ArcGIS map.▁Plan')

    def test_exact_entry_preserves_literal_symbols(self):
        pieces = ['<blank>', '▁with', '▁memo', ',', '▁inc', '.', '▁we', '▁use', '▁c++']
        decoder = self.decoder(pieces, ['Memo, Inc.', 'C++'])
        self.assertEqual(decoder.resolve(list(range(1, len(pieces)))), '▁with▁Memo, Inc.▁we▁use▁C++')

    def test_first_letter_errors_still_reach_the_audio_scorer(self):
        pieces = ['<blank>', '▁At', '▁Knomo', '▁Conomo', '▁Point', '▁Road']
        decoder = self.decoder(pieces, ['Conomo', 'Vercel', 'Zainab'])
        self.assertEqual(
            [(entry.spelling, edits) for entry, edits in decoder.vocabulary.candidates('wersel', 1)],
            [('Vercel', 2)],
        )
        self.assertEqual(
            [(entry.spelling, edits) for entry, edits in decoder.vocabulary.candidates('sainab', 1)],
            [('Zainab', 1)],
        )

        decoder.log_probability = lambda _, tokens, __: -1 if tokens[0] == 2 else -4
        self.assertEqual(decoder.resolve([1, 2, 4, 5]), '▁At▁Conomo▁Point▁Road')
        decoder.log_probability = lambda _, tokens, __: -1 if tokens[0] == 2 else -20
        self.assertEqual(decoder.resolve([1, 2, 4, 5]), '▁At▁Knomo▁Point▁Road')

if __name__ == '__main__':
    unittest.main()
