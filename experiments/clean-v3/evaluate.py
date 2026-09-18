import sys,json,time,statistics,math,hashlib
from pathlib import Path
from runtime import Runtime
from guard import CONTRACT
rows=[json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
started=time.monotonic();runtime=Runtime();startup=(time.monotonic()-started)*1000
try:
 results=[]
 for row in rows:
  started=time.monotonic();r=runtime.format(row['source'],row.get('vocabulary',[]));r.update(id=row['id'],target=row['target'],latency_ms=(time.monotonic()-started)*1000);results.append(r)
 out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
 (out/'outputs.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in results))
 times=sorted(r['latency_ms'] for r in results)
 summary=dict(contract=CONTRACT['version'],rows=len(rows),accepted=sum(r['status']=='accepted' for r in results),exact=sum(r['selected']==r['target'] for r in results),changed=sum(r['selected']!=r['raw'] for r in results),p50_ms=statistics.median(times),p95_ms=times[math.ceil(len(times)*.95)-1],startup_ms=startup,dataset_sha256=hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
finally:runtime.close()
