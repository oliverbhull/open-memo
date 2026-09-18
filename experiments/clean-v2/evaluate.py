"""Offline synthetic development/frozen-holdout runner. Never calls remote services."""
import argparse,json,time,statistics,hashlib,math
from pathlib import Path
from core import prompt,select,CONTRACT

def main():
    p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--adapter');p.add_argument('--data',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    from mlx_lm import load,generate
    from mlx_lm.sample_utils import make_sampler
    import mlx.core as mx
    started=time.monotonic();model,tok=load(args.model,adapter_path=args.adapter);startup=(time.monotonic()-started)*1000
    sampler=make_sampler(temp=0)
    def run(text):
        rendered=tok.apply_chat_template([{'role':'user','content':prompt(text)}],tokenize=False,add_generation_prompt=True)
        return generate(model,tok,prompt=rendered,max_tokens=min(512,max(64,len(tok.encode(text))*2+16)),sampler=sampler,verbose=False)
    run('hello there')
    rows=[json.loads(line) for line in Path(args.data).read_text().splitlines()]
    results=[]
    for row in rows:
        started=time.monotonic();candidate=run(row['source']).strip();elapsed=(time.monotonic()-started)*1000
        result=select(row['source'],candidate,row.get('vocabulary',[]))
        result.update(id=row['id'],target=row['target'],latency_ms=elapsed,exact=result['selected']==row['target'])
        results.append(result)
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    (out/'outputs.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in results))
    latency=sorted(r['latency_ms'] for r in results)
    from collections import Counter
    summary=dict(model=args.model,adapter=args.adapter,decoding={'temperature':0,'max_tokens':'min(512,max(64,input_tokens*2+16))'},contract=CONTRACT['version'],rows=len(results),exact=sum(r['exact'] for r in results),
        accepted=sum(r['status']=='accepted' for r in results),changed=sum(r['selected']!=r['raw'] for r in results),
        reasons=dict(Counter(r['reason'] for r in results)),p50_ms=statistics.median(latency),p95_ms=latency[max(0,math.ceil(len(latency)*.95)-1)],
        load_ms=startup,peak_mlx_bytes=mx.get_peak_memory(),dataset_sha256=hashlib.sha256(Path(args.data).read_bytes()).hexdigest(),
        evidence='synthetic_only_not_human_audio_review')
    (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
