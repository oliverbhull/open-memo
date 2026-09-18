#!/usr/bin/env python3
"""Bounded development JSONL facade over the native annotation model."""
import argparse,hashlib,json,sys,time
from pathlib import Path
from runtime import Runtime,ROOT
from guard import CONTRACT

def emit(value):print(json.dumps(value,ensure_ascii=False),flush=True)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=Path);parser.add_argument('--identity',action='store_true');args=parser.parse_args()
 if not args.identity:
  if not args.manifest:parser.error('Validated local manifest required')
  manifest=json.loads(args.manifest.read_text())
  if manifest['contract']!=CONTRACT['version'] or manifest['status']!='internal_formatting_candidate':parser.error('Candidate not enabled')
  required={str((ROOT/'experiments/clean-v3'/name).resolve()) for name in ['worker.py','runtime.py','guard.py','contract.json']}
  required.add(str((ROOT/'.build/clean-v3/memo-annotations').resolve()))
  required.add(str((ROOT/'.build/pnc/tokenizer.vocab').resolve()))
  required.update(str(p.resolve()) for p in (ROOT/'.build/pnc/compiled').rglob('*') if p.is_file())
  if not required.issubset(manifest['sha256']):parser.error('Incomplete checksum coverage')
  for filename,expected in manifest['sha256'].items():
   digest=hashlib.sha256()
   with Path(filename).open('rb') as handle:
    for block in iter(lambda:handle.read(8*1024*1024),b''):digest.update(block)
   if digest.hexdigest()!=expected:parser.error('Candidate checksum mismatch')
 runtime=None if args.identity else Runtime()
 model='identity-test' if args.identity else 'native-pnc-annotations-v3'
 emit(dict(type='ready',protocol=1,contract=CONTRACT['version'],model=model))
 try:
  while True:
   line=sys.stdin.buffer.readline(262145)
   if not line or len(line)>262144:return
   r={}
   try:
    r=json.loads(line)
    if not isinstance(r,dict) or r.get('protocol')!=1 or not isinstance(r.get('id'),str):raise ValueError('request_shape')
    source=r['text'];vocabulary=r.get('vocabulary',[])
    if not isinstance(source,str) or not source.strip() or len(source)>20000:raise ValueError('input_bounds')
    if not isinstance(vocabulary,list) or len(vocabulary)>500 or any(not isinstance(v,str) or not v.strip() or len(v)>200 for v in vocabulary):raise ValueError('vocabulary_bounds')
    deadline=time.monotonic()+(r['deadline_unix_ms']-time.time()*1000)/1000
    if not 0<deadline-time.monotonic()<=60:raise ValueError('deadline')
    result=dict(raw=source,selected=source,candidate=source,status='accepted',reason='identity') if args.identity else runtime.format(source,vocabulary)
    if time.monotonic()>deadline:result.update(selected=source,status='fallback',reason='deadline')
    emit(dict(result,id=r['id'],protocol=1,contract=CONTRACT['version'],model=model))
   except Exception as error:
    emit(dict(id=r.get('id') if isinstance(r,dict) else None,protocol=1,contract=CONTRACT['version'],model=model,status='fallback',reason=type(error).__name__))
    if runtime and runtime.process.poll() is not None:return
 finally:
  if runtime:runtime.close()
if __name__=='__main__':main()
