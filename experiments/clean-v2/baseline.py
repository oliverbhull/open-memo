"""Run the existing local PnC baseline on explicit evaluation data; aggregate only stdout."""
import json,sys,time,subprocess,re,statistics
from pathlib import Path
from core import select
root=Path(__file__).resolve().parents[2];bundle=root/'.build/pnc'
worker=subprocess.Popen([str(bundle/'memo-pnc'),'--model-path',str(next((bundle/'compiled').glob('*.mlmodelc'))),'--vocabulary-path',str(bundle/'tokenizer.vocab'),'--worker'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
 while worker.stdout.readline().strip()!='READY':
  if worker.poll() is not None:raise RuntimeError('PnC startup failed')
 rows=[json.loads(x) for x in Path(sys.argv[1]).read_text().splitlines()];results=[]
 for row in rows:
  raw=row['source'];started=time.monotonic()
  # Same bypass rule as the production PunctuationService.
  if any(c.isupper() for c in raw) or re.search(r'[.!?](?:\s|$)',raw): candidate=raw
  else:
   worker.stdin.write(json.dumps({'id':row['id'],'text':raw})+'\n');worker.stdin.flush()
   candidate=json.loads(worker.stdout.readline())['text']
  elapsed=(time.monotonic()-started)*1000
  result=select(raw,candidate);result.update(id=row['id'],target=row['target'],latency_ms=elapsed,baseline_candidate=candidate)
  results.append(result)
 out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
 (out/'outputs.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in results))
 times=sorted(r['latency_ms'] for r in results)
 summary={'rows':len(rows),'exact':sum(r['selected']==r['target'] for r in results),'changed':sum(r['selected']!=r['raw'] for r in results),'accepted':sum(r['status']=='accepted' for r in results),'p50_ms':statistics.median(times),'p95_ms':times[min(len(times)-1,int(len(times)*.95))],'note':'Existing PnC bypass behavior followed; then v2 guard applied for comparable selected safety.'}
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
finally:worker.kill();worker.wait()
