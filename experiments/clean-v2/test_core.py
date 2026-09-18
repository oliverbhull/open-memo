import unittest
from core import select
class CoreTests(unittest.TestCase):
 def test_useful_formatting(self):
  for source,target in [('i will not go today','I will not go today.'),('i am ready let us begin','I am ready. Let us begin.'),('i do not know if this will work properly let us see','I do not know if this will work properly. Let us see.')]:
   self.assertEqual(select(source,target)['status'],'accepted')
 def test_lexical_changes(self):
  for source,target in [('um i think so','I think so.'),('i think this might work','This works.'),('she was ready','She is ready.'),('i do not agree','I agree.'),('John likes Mary','Mary likes John.'),('determ rest stick','deterministic')]:
   self.assertEqual(select(source,target)['status'],'fallback')
 def test_literals(self):
  for source,target in [('use foo.py','Use foo. Py.'),('use /tmp/a.','Use /tmp/a...'),('pay $12.50','Pay $12.60.'),('margin 12%','Margin 12.'),('temperature -12','Temperature 12.'),('say "no thank you"','Say "No, thank you."'),('use user@example.com','Use user@example.org')]:
   self.assertEqual(select(source,target)['status'],'fallback')
 def test_polarity_scope(self):
  for source,target in [('do not go','Do. Not go.'),('no more work','No, more work.'),('i cannot leave','I cannot. Leave.'),("i shouldn't go","I shouldn't. Go."),('i did not say she stole it','I did not say. She stole it.')]:
   self.assertEqual(select(source,target)['status'],'fallback')
 def test_intent(self):
  self.assertEqual(select('you left? she stayed','You left. She stayed?')['status'],'fallback')
  self.assertEqual(select('you left','You left!')['status'],'fallback')
 def test_noops(self):
  for source in ['Not yet.','She said "Um, no."','-12.5°C','Hello 😀\nAnother paragraph.','US']:
   self.assertEqual(select(source,source)['selected'],source)
   self.assertEqual(select(source,source)['status'],'accepted')
 def test_acronym_and_vocab(self):
  self.assertEqual(select('send to US','Send to us')['status'],'fallback')
  self.assertEqual(select('ask Acme','Ask ACME',['Acme'])['status'],'fallback')
  self.assertEqual(select('ask acme','Ask Acme',['Acme'])['status'],'accepted')
