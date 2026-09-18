"""Format-only invariant checks. This does not certify semantic equivalence."""
import json,re
from pathlib import Path
CONTRACT=json.loads(Path(__file__).with_name('contract.json').read_text())
WORD=re.compile(r"\w+(?:['’]\w+)*",re.UNICODE)
QUOTE=re.compile(r'"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)\x27[^\x27]+\x27(?!\w)',re.S)
NUMBER=re.compile(r'(?<!\w)[$€£¥₹₩]?[+−-]?(?:\d+(?:[.,]\d+)*|[.]\d+)(?:[/:−-]\d+)*(?:st|nd|rd|th)?[%‰°]?')
LITERAL=re.compile(r'https?://[^\s<>"\]]+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?<!\w)(?:~?/|\./|\.\./)[^\s,;"\]]+|\b\w+(?:[_./-]\w+)+\b')

TECHNICAL_CHARS = set('=:+*<>|{}[]\\@/')
def technical_tokens(text):return [t for t in text.split() if any(c in TECHNICAL_CHARS for c in t)]

def words(text):return [m.group().casefold() for m in WORD.finditer(text)]

def select(source,candidate,vocabulary=()):
    result=dict(raw=source,candidate=candidate if isinstance(candidate,str) else None,selected=source,status='fallback',reason='malformed_output',contract=CONTRACT['version'])
    if not isinstance(candidate,str) or not candidate.strip() or len(candidate)>24000:return result
    if technical_tokens(source)!=technical_tokens(candidate):return dict(result,reason='technical_literal_changed')
    a,b=list(WORD.finditer(source)),list(WORD.finditer(candidate))
    if words(source)!=words(candidate):return dict(result,reason='word_sequence_changed')
    if any(x.group().isupper() and len(x.group())>1 and x.group()!=y.group() for x,y in zip(a,b)):return dict(result,reason='acronym_changed')
    if QUOTE.findall(source)!=QUOTE.findall(candidate):return dict(result,reason='quotation_changed')
    if NUMBER.findall(source)!=NUMBER.findall(candidate):return dict(result,reason='number_changed')
    if LITERAL.findall(source) != LITERAL.findall(candidate):return dict(result,reason='literal_changed')
    for value in vocabulary:
        pattern=re.compile(r'(?<!\w)'+re.escape(value)+r'(?!\w)',re.I)
        original, edited = pattern.findall(source), pattern.findall(candidate)
        if len(original)!=len(edited) or any(after not in (before,value) for before,after in zip(original,edited)):return dict(result,reason='vocabulary_changed')
    def anchors(text,marks):
        return [(m.group(),len(WORD.findall(text[:m.start()]))) for m in re.finditer(marks,text)]
    # Preserve all non-formatting symbols and their word boundaries, including quotes, minus signs and emoji.
    if anchors(source,r'[^\w\s.,?!]')!=anchors(candidate,r'[^\w\s.,?!]'):return dict(result,reason='symbol_changed')
    for mark in ['?', '!']:
        old=anchors(source,re.escape(mark));new=anchors(candidate,re.escape(mark))
        if any(anchor not in new for anchor in old) or (mark == '!' and old != new):return dict(result,reason='intent_punctuation_changed')
    # Polarity must not be split from its local predicate by inserted punctuation.
    for i,match in enumerate(a):
        if match.group().casefold().endswith(("n't", "n’t")) or match.group().casefold() in {'no','not','never','cannot',"don't","can't","isn't","wasn't","didn't","won't"}:
            for boundary in range(max(0,i-1),min(len(a)-1,i+2)):
                old=source[a[boundary].end():a[boundary+1].start()]
                new=candidate[b[boundary].end():b[boundary+1].start()]
                if re.sub(r'\s','',old)!=re.sub(r'\s','',new):return dict(result,reason='polarity_boundary_changed')
    return dict(result,status='accepted',selected=candidate,reason='format_invariants_passed')
