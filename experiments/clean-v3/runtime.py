"""Formatting annotations applied to immutable source words; no generated text repair."""
import json,re,subprocess
from pathlib import Path
from guard import CONTRACT,QUOTE,LITERAL,WORD,TECHNICAL_CHARS,select
ROOT=Path(__file__).resolve().parents[2]
class Runtime:
 def __init__(self):
  bundle=ROOT/'.build/pnc'
  self.process=subprocess.Popen([str(ROOT/'.build/clean-v3/memo-annotations'),'--model-path',str(next((bundle/'compiled').glob('*.mlmodelc'))),'--vocabulary-path',str(bundle/'tokenizer.vocab'),'--worker'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
  while self.process.stdout.readline().strip()!='READY':
   if self.process.poll() is not None:raise RuntimeError('annotation_startup')
 def close(self):self.process.kill();self.process.wait()
 def format(self,source,vocabulary=()):
  self.process.stdin.write(json.dumps(dict(id='format',text=source))+'\n');self.process.stdin.flush()
  response=json.loads(self.process.stdout.readline())
  annotations=json.loads(response['text'])
  candidate=render(source,annotations,vocabulary)
  result=select(source,candidate,vocabulary)
  result['reason']='annotation_invariants_passed' if result['status']=='accepted' else result['reason']
  return result

def render(source,annotations,vocabulary=()):
 tokens=list(re.finditer(r'\S+',source))
 if len(tokens)!=len(annotations):raise ValueError('annotation_count')
 protected=[m.span() for pattern in [QUOTE,LITERAL] for m in pattern.finditer(source)]
 for value in vocabulary:
  protected += [m.span() for m in re.finditer(r'(?<!\w)'+re.escape(value)+r'(?!\w)',source,re.I)]
 words=list(WORD.finditer(source));blocked=set()
 for i,m in enumerate(words):
  if m.group().lower() in {'no','not','never','cannot'} or m.group().lower().endswith(("n't","n’t")):
   blocked.update(words[j].end() for j in range(max(0,i-1),min(len(words)-1,i+2)))
 output=[];cursor=0;capitalize_next=True;suppressed_boundary=False
 for token,annotation in zip(tokens,annotations):
  text=token.group();literal=any(c in TECHNICAL_CHARS for c in text) or any(token.start()<end and token.end()>start for start,end in protected)
  if not literal:
   if text[0].isalpha() and (capitalize_next or (annotation['capitalize'] and not suppressed_boundary)):text=text[0].upper()+text[1:]
   probabilities=annotation['punctuation']
   if len(probabilities)!=4:raise ValueError('annotation_shape')
   label=max(range(4),key=lambda i:probabilities[i]);mark=['',',','.','?'][label]
   threshold=CONTRACT['question_confidence'] if mark=='?' else CONTRACT['punctuation_confidence']
   if mark and probabilities[label]>=threshold and token.end() not in blocked and text[-1] not in '.,?!;:':text+=mark
  label=max(range(4),key=lambda i:annotation['punctuation'][i])
  suppressed_boundary=label in (2,3) and not text.endswith(('.', '?', '!'))
  output += [source[cursor:token.start()],text];cursor=token.end()
  capitalize_next=text.endswith(('.', '?', '!'))
 output.append(source[cursor:])
 return ''.join(output)
