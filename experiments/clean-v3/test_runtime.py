import unittest
from runtime import render
from guard import select

def labels(text,mark=0):return [dict(capitalize=False,punctuation=[1.0 if i==mark else 0.0 for i in range(4)]) for _ in text.split()]
class AnnotationTests(unittest.TestCase):
 def test_immutable_words(self):
  source='um i i think this might work'
  out=render(source,labels(source))
  self.assertEqual(out,'Um i i think this might work')
  self.assertEqual(select(source,out)['status'],'accepted')
 def test_sentence_case(self):
  source='hello there we are ready';a=labels(source);a[1]['punctuation']=[0,0,1,0]
  self.assertEqual(render(source,a),'Hello there. We are ready')
 def test_literals_and_whitespace(self):
  source='say "do not go"\nuse /tmp/a.py and -12.5'
  out=render(source,labels(source,2))
  self.assertIn('"do not go"',out);self.assertIn('\n',out);self.assertIn('/tmp/a.py',out);self.assertIn('-12.5',out)
  self.assertEqual(select(source,out)['status'],'accepted')
 def test_block_polarity(self):
  source='i did not say she stole it';a=labels(source,2)
  out=render(source,a)
  self.assertNotIn('not.',out);self.assertNotIn('say.',out)
  self.assertEqual(select(source,out)['status'],'accepted')
 def test_bad_annotation_count(self):
  with self.assertRaises(ValueError):render('hello there',[])
 def test_existing_question(self):
  source='did you go? i stayed'
  self.assertIn('go?',render(source,labels(source)))
  self.assertEqual(select(source,'Did you go. I stayed?')['status'],'fallback')
 def test_no_word_repair(self):
  self.assertEqual(select('determ rest stick','deterministic')['status'],'fallback')

 def test_technical_tokens(self):
  for source in ['status=204 means success','mode:quiet is selected','x+y is the expression','user@example.com is the address']:
   out=render(source,labels(source,2))
   self.assertEqual(out.split()[0],source.split()[0])
   self.assertEqual(select(source,out)['status'],'accepted')
  self.assertEqual(select('status=204','Status=204')['status'],'fallback')
