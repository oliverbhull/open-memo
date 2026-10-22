"""Socket isolation/dedup tests; no heavy model loaded in this suite."""
import base64
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys

from conomo.client import SpeechClient

from conomo import server as shared
from types import SimpleNamespace
from tokenizers import Tokenizer, models
from conomo.nemotron import PhraseBias
import numpy as np

class FakeSession:
    instances = []
    def __init__(self, phrases=(), strength=2.0, emit_fn=None):
        self.phrases = phrases
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
        core.model = object()
        core.tokenizer = object()
        core.chunk_samples = 8960
        core.lock = threading.RLock()
        core.memo_owner = None
        core.epoch = 0
        core.quiet_until = 0
        core.clients = {}
        core.tokenizer = Tokenizer(models.Unigram([('<unk>', 0), ('▁', -1), ('M', -2), ('e', -3), ('m', -4), ('o', -5)], unk_id=0))
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
                system.request({'type':'context', 'phrases': ['Memo'], 'strength': 99})
            memo.request({'type':'end'})
            self.assertEqual(memo.request({'type':'context', 'phrases': []})['phrase_count'], 0)

    def test_structured_vocabulary_is_not_replaced_by_window_prompt(self):
        with SpeechClient(self.path) as memo:
            memo.request({'type':'context', 'phrases':['Memo, Inc.']})
            result = memo.request({'type':'context', 'prompt':'Vocabulary: unrelated window text.'})
            self.assertEqual(result['phrase_count'], 1)
            memo.request({'type':'start'})
            self.audio(memo)
            self.assertEqual(FakeSession.instances[-1].phrases, ['Memo, Inc.'])
            memo.request({'type':'end'})

class BiasTest(unittest.TestCase):
    def test_alternate_segmentation_blank_and_reset(self):
        t = Tokenizer(models.Unigram([('<unk>', 0), ('▁', -1), ('▁me', -2), ('m', -3), ('o', -4), ('mo', -5), ('blank', -6)], unk_id=0))
        b = PhraseBias(t, ['Memo'], 2)
        scores = np.zeros(7, np.float32)
        self.assertGreater(b.apply(scores, 6)[2], 0)
        self.assertEqual(b.apply(scores, 6)[6], 0)
        b.accept(2)
        boosted = b.apply(scores, 6)
        self.assertEqual(boosted[5], 2)
        self.assertEqual(boosted[3], 2)
        self.assertTrue(np.array_equal(PhraseBias(t, []).apply(scores,6), scores))
        self.assertTrue(np.array_equal(PhraseBias(t, ['Memo'],0).apply(scores,6), scores))
        self.assertEqual(PhraseBias(t, ['Memo']).history, '')

if __name__ == '__main__':
    unittest.main()
