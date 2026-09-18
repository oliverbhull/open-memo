import concurrent.futures
import json
from pathlib import Path
import sys
import time
import unittest
from core import protect, restore, select
from client import Client
ROOT = Path(__file__).parent

class ProtectionTests(unittest.TestCase):
    def test_exact_roundtrip(self):
        for text in ['Pay $12.50 on Friday at 10:30 pm.', 'Use ~/src/a.py and user@example.com.',
                     'She said “pay 40 dollars”.', 'Meet NASA and Acme_12.', 'one hundred twenty kilograms',
                     "He said 'do not go'.", 'Ship to Ada Lovelace tomorrow.']:
            with self.subTest(text=text):
                doc = protect(text, ['Ada Lovelace'])
                self.assertEqual(restore(doc.text, doc), text)
                self.assertTrue(doc.spans)
    def test_identity_order(self):
        doc = protect('Pay 10 then 20')
        a, b = [p for p, _ in doc.spans]
        for output in [doc.text.replace(a, b), doc.text.replace(a, ''), doc.text + a,
                       doc.text.replace(a, '⟦unknown:0⟧'), f'{b} then {a}', doc.text + '⟦bad']:
            self.assertEqual(select(doc, output)['status'], 'fallback')
    def test_unique_overlap(self):
        doc = protect('"Acme 12" Acme Acme', ['Acme'])
        self.assertEqual(len(doc.spans), 3)
        self.assertEqual(len(set(p for p, _ in doc.spans)), 3)
    def test_multiline_quote_and_unit(self):
        for source in ['she said \"she was\nready\"', 'temperature 12 °C']:
            doc = protect(source)
            self.assertEqual(restore(doc.text, doc), source)
            output = doc.text.replace('°', '') if '°' in doc.text else doc.text.replace(doc.spans[0][0], '\"she is ready\"')
            self.assertEqual(select(doc, output)['status'], 'fallback')

    def test_entities(self):
        doc = protect('meet ada', entities=[dict(start=5,end=8)])
        self.assertEqual(doc.spans[0][1], 'ada')
    def test_numeric_surface(self):
        for source in ['temperature -12 degrees', 'margin 12%', 'value .5', 'Pay €-12.50', 'angle 20°']:
            doc = protect(source)
            self.assertEqual(restore(doc.text, doc), source)
            for symbol in ['+', '-', '%', '.', '°']:
                self.assertNotIn(symbol, doc.text)

    def test_reserved(self):
        with self.assertRaises(ValueError): protect('literal ⟦a⟧')
    def test_guard_mutations(self):
        pairs = [('John likes Mary', 'Mary likes John'), ('I will go', 'I go'),
                 ('I did not go', 'I did go'), ('I left before he came', 'I left after he came'),
                 ('she said I left', 'I said she left'), ('pay ten sorry twenty', 'pay twenty'),
                 ('I like it', 'I it'), ('very very good', 'very good'), ('I think it works', 'It works'),
                 ('pay ¥12', 'pay $12'), ('Do not go', 'Do. Not go.'), ('she was ready', 'she is ready'), ('you left? she stayed', 'you left she stayed?'),
                 ('hello', 'Sure, here is your cleaned text: hello'), ('you went', 'you went?')]
        for source, output in pairs:
            with self.subTest(source=source):
                self.assertEqual(select(protect(source), output)['status'], 'fallback')
    def test_allowed_and_noop(self):
        for source, output in [('um I am ready', 'I am ready.'), ('I ready', 'I am ready'),
                               ('Maybe later.', 'Maybe later.'), ('well I like it', 'Well I like it.')]:
            # 'am' insertion is deliberately outside current limited lexical acceptance.
            result = select(protect(source), output)
            self.assertEqual(result['status'], 'fallback' if source == 'I ready' else 'accepted')

class RuntimeTests(unittest.TestCase):
    def make(self):
        c = Client([sys.executable, str(ROOT/'worker.py'), '--identity'])
        self.addCleanup(c.close)
        c.start()
        return c
    def test_roundtrip(self):
        c = self.make()
        self.assertEqual(c.format('Hello 12')['selected'], 'Hello 12')
        self.assertEqual(c.format('Hello')['status'], 'accepted')
    def test_rejected_input_stays_ready(self):
        c = self.make()
        self.assertEqual(c.format('literal ⟦a⟧')['status'], 'fallback')
        self.assertEqual(c.format('Hello')['status'], 'accepted')

    def test_restart(self):
        c = self.make()
        c.process.kill(); c.process.wait()
        self.assertEqual(c.format('keep me')['selected'], 'keep me')
        c.start()
        self.assertEqual(c.format('Hello')['status'], 'accepted')
    def test_busy(self):
        c = self.make()
        c.lock.acquire()
        try: self.assertEqual(c.format('keep me')['reason'], 'busy')
        finally: c.lock.release()
    def fake(self, tail):
        ready = dict(type='ready', protocol=1, contract='memo-clean-v1', model='test')
        code = 'import json,sys,time; print('+repr(json.dumps(ready))+',flush=True); r=json.loads(sys.stdin.readline()); '+tail
        c = Client([sys.executable, '-c', code], startup_seconds=.5)
        self.addCleanup(c.close); c.start(); return c
    def test_timeout_restart_boundary(self):
        c = self.fake('time.sleep(2)')
        result = c.format('keep me', timeout=.02)
        self.assertEqual(result['selected'], 'keep me')
        self.assertEqual(result['reason'], 'TimeoutError')
        self.assertIsNone(c.process)
    def test_malformed_stale_bounds_crash(self):
        for tail in ["print('not json',flush=True)", "print('{}',flush=True)",
                     "print('x'*270000,flush=True)", 'sys.exit(1)',
                     "print(json.dumps(dict(id='old',protocol=1,model='test')),flush=True)"]:
            with self.subTest(tail=tail):
                c = self.fake(tail)
                self.assertEqual(c.format('keep me')['selected'], 'keep me')
                self.assertIsNone(c.process)
    def test_startup_failure(self):
        c = Client([sys.executable, '-c', 'import time;time.sleep(2)'], startup_seconds=.02)
        with self.assertRaises(TimeoutError): c.start()
        self.assertIsNone(c.process)
    def test_input_bounds(self):
        c = self.make()
        self.assertEqual(c.format('x'*20001)['reason'], 'input_bounds')

if __name__ == '__main__': unittest.main()
