"""Synthetic local training fixture, agent-authored; never labelled human approved."""
import json,re,hashlib
from core import select
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
CONTRACT=json.loads(Path(__file__).with_name('contract.json').read_text())
TRAIN='''I am going to try this again. Let us see how it works.
The microphone is on. I am speaking at a normal pace.
I do not know whether this will work. We should test it first.
Please send the document when you have a moment.
We are waiting for the delivery. It should arrive soon.
That sounds reasonable to me. I think we can proceed.
Let me check the schedule. I will get back to you.
I would like to keep the original wording. Please do not change it.
The meeting went well. We discussed the next steps.
I can finish this later today. There is no rush.
This is a simple test of the recording system.
I might be wrong about this. We need more information.
She said the work was complete. I have not checked it yet.
He asked me to wait. I stayed where I was.
We left before the rain started. Then we drove home.
I opened the box after the driver left.
I think this is getting better. Let us try another example.
It is not ready yet. I will let you know when it is.
We should not assume that everyone agrees.
They could come tomorrow. They have not confirmed.
I am not sure about the price. Please check it again.
The door is open. The light is still on.
I want to write this down before I forget.
There are several things we need to discuss.
First we checked the equipment. Then we started the job.
I am testing the system and checking the result.
This should be straightforward. I do not want to overcomplicate it.
We need a reliable result. Speed is less important right now.
I am speaking naturally. There may be a few rough edges.
Please keep the details exactly as I said them.
I did not approve the change. Someone else may have approved it.
She did not say that he was late.
The report says the valve failed. I have not seen the valve.
I would prefer to wait until we know more.
I could do that, but I would need some help.
Well, I think we should give it another try.
So, we have a plan. Now we need to follow it.
I like the way this looks. It feels simple and clear.
I mean the smaller box, not the larger one.
It was very, very quiet in the room.
I, I think we need to start again.
Um, I am ready to begin. Uh, let me check one thing.
No, that was not what I meant.
Actually, I wanted the earlier version.
Sorry, I have another question.
We ordered the blue one. No, the green one.
I need to check this carefully. There might be a mistake.
I am going to test the model and see how well it handles my speech.
This is the first part. This is the second part. That is all.
The office is closed today. We can call tomorrow.
I sent the message yesterday. I have not received a reply.
The file is saved on my computer. I can share it later.
We cannot finish until the parts arrive.
It may take longer than we expected.
I will call you after the meeting ends.
The train was late. We arrived in the afternoon.
I have been thinking about this for a while.
This is probably enough for now. We can add more later.
I want the writing to sound like me.
The result should be easy to read and easy to understand.
I do not want extra explanations or a summary.
Please leave the unusual words alone.
I am checking how consistent the output is.
It keeps the words in order. That is what I wanted.
We need to separate the two sentences.
I am happy with the first result. The second needs more work.
I was going to leave, but then the phone rang.
We have enough time. There is no need to hurry.
Thank you for the update. I will read it tonight.
Thanks, that is helpful. I will try it now.
The battery is charged. The recorder is ready.
I was wondering whether you could help me with this.
It is a small change, but it makes a difference.
I am looking at the numbers. They seem consistent.
I want to make sure we have not missed anything.
This could be useful if it works reliably.
I am going to stop here. We can continue later.
The team needs a clear answer. I do not have one yet.
I will check with the supplier before we place the order.
We should keep a copy of the original recording.
The box contains 12 screws. We need 24 screws.
The temperature was -12 degrees. It is warmer now.
We paid $12.50 for the parts. Keep the receipt.
The room is 20 meters long. Please measure it again.
The order number is 5831. Do not lose it.
She said "keep the door open" and walked away.
He told me "I am not ready" before the call.
I wrote "do not change this" on the label.
The note reads "um I do not know" exactly.
I am testing the paragraph breaks. This is still the same thought.
A separate thought starts here. I want to keep it readable.
Maybe later.
Probably tomorrow.
Still waiting.
Not yet.
All good.
Hello there.
That is fine.
I understand.
Yes, please.
No, thanks.'''.splitlines()
VALID='''The package arrived this morning. I left it by the stairs.
We have not decided what to do. I want to hear your opinion.
I might call the office later. Please do not wait for me.
That was a useful conversation. I learned something new.
The engine stopped before we reached the gate.
I do not think the switch is broken. We should check the cable.
I am testing this once more. The words should stay in order.
The answer is probably in the notes. I will look for it.
She said the form was missing. He said it had been sent.
We can try a different approach after lunch.
I, I was going to mention that.
Um, let us look at the next item.
This is really, really important to me.
I need 35 bolts. There are 19 in the container.
The total is $48.75. That includes shipping.
It was 8 degrees outside. We stayed indoors.
He said "leave it alone" and I agreed.
The label says "not for sale" in red.
I would rather keep this short. We can discuss details later.
We should not change the wording. It is a direct quote.
Nothing else.
Almost finished.
I will be there soon.
Please keep me informed.'''.splitlines()

def raw(target):
    keep=[]
    pattern=r'"[^"]*"|[$€£]?-?\d+(?:[.,]\d+)*'
    def stash(m): keep.append(m.group());return f'zzhold{len(keep)-1}zz'
    text=re.sub(pattern,stash,target)
    text=re.sub(r'[.,!?;:]','',text).lower()
    for i,value in enumerate(keep):text=text.replace(f'zzhold{i}zz',value)
    return text

def prompt(source): return CONTRACT['instruction']+'\n\nTranscript: '+source

def main():
    out=ROOT/'.build/clean-v2/data';out.mkdir(parents=True,exist_ok=True)
    manifest={'source_kind':'synthetic_plus_user_supplied_regressions','review_status':'agent_authored_not_human_approved','contract':CONTRACT['version'],'counts':{}}
    long_targets = [' '.join(TRAIN[(i*7+j*11)%80] for j in range(4)) for i in range(24)]
    for split,targets in [('train',TRAIN+long_targets),('valid',VALID)]:
        rows=[]
        for i,target in enumerate(targets):
            variants=[raw(target)]
            if split=='train' and i%2==0: variants.append(target)
            for j,source in enumerate(variants):
                if select(source,target)['status'] != 'accepted': continue
                rows.append({'id':f'{split}-{i}-{j}','source':source,'target':target,'family':f'{split}-{i}',
                  'messages':[{'role':'user','content':prompt(source)},{'role':'assistant','content':target}]})
        if split == 'train':
            reported = ROOT/'.build/clean-v2/reported.jsonl'
            if reported.exists():
                for line in reported.read_text().splitlines():
                    r=json.loads(line)
                    if select(r['source'],r['target'])['status'] == 'accepted':
                        for repeat in range(12):
                            rows.append(dict(r,id=f"{r['id']}-{repeat}",family=r['id'],source_kind='user_supplied_regression',messages=[{'role':'user','content':prompt(r['source'])},{'role':'assistant','content':r['target']}]))
        (out/f'{split}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
        manifest['counts'][split]=len(rows)
        manifest[split+'_sha256']=hashlib.sha256((out/f'{split}.jsonl').read_bytes()).hexdigest()
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
if __name__=='__main__':main()
