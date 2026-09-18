"""Local experimental literal conservation and conservative risk gates, not semantic proof."""
from dataclasses import dataclass
from pathlib import Path
import json
import re
import hashlib
from collections import Counter

CONTRACT = json.loads(Path(__file__).with_name('contract.json').read_text())
TOKEN = re.compile(r'⟦[^⟦⟧]*⟧')
NUMBER_WORDS = ('zero one two three four five six seven eight nine ten eleven twelve thirteen '
                'fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty '
                'sixty seventy eighty ninety hundred thousand million billion first second third '
                'fourth fifth sixth seventh eighth ninth tenth dollars pounds euros percent '
                'meters metres feet inches kilograms miles').split()
PATTERNS = [
    r'"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)\x27[^\x27]+\x27(?!\w)',
    r'https?://[^\s<>"⟦⟧]+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b',
    r'(?<!\w)(?:~?/|\./|\.\./)[^\s,;"⟦⟧]+|\b[A-Za-z]:\\[^\s]+',
    r'(?<!\w)[$€£¥₹₩]?[+−-]?(?:\d+(?:[.,]\d+)*|[.]\d+)(?:[/:−-]\d+)*(?:st|nd|rd|th)?(?:\s?(?:am|pm|kg|km|cm|mm|mph|lbs|USD|EUR|GB|MB))?[%‰°]?',
    r'\b(?:' + '|'.join(NUMBER_WORDS) + r')\b',
    r'\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|yesterday|noon|midnight)\b',
    r'\b\w+(?:[_./-]\w+)+\b',
    r'\b[A-Z]{2,}\b',
]
RISK = re.compile(r"\b(?:no|not|never|cannot|can't|won't|don't|didn't|isn't|wasn't|wouldn't|shouldn't|couldn't|mustn't|may|might|must|could|should|would|will|probably|possibly|certainly|definitely|perhaps|said|says|told|asked|according|before|after|then|until|unless|sorry|actually|mean|wait)\b|n['’]t\b", re.I)
WORDS = re.compile(r"⟦[^⟦⟧]*⟧|[\w]+(?:['’][\w]+)*", re.UNICODE)
FILLERS = {'um', 'uh', 'erm', 'hmm'}
FUNCTION = {'a', 'an', 'the'}

@dataclass(frozen=True)
class Document:
    raw: str
    text: str
    spans: tuple[tuple[str, str], ...]


def protect(raw: str, vocabulary=(), entities=()) -> Document:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > CONTRACT['max_input_characters']:
        raise ValueError('input_bounds')
    if '⟦' in raw or '⟧' in raw:
        raise ValueError('reserved_placeholder')
    if not isinstance(vocabulary, (list, tuple)) or len(vocabulary) > 500:
        raise ValueError('vocabulary_bounds')
    intervals = []
    for value in vocabulary:
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise ValueError('vocabulary_bounds')
        intervals.extend((m.start(), m.end()) for m in re.finditer(r'(?<!\w)' + re.escape(value) + r'(?!\w)', raw, re.I))
    # Caller-supplied high-confidence offsets, never model-guessed entity corrections.
    for entity in entities:
        if not isinstance(entity, dict):
            raise ValueError('entity_span')
        start, end = entity.get('start'), entity.get('end')
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(raw):
            raise ValueError('entity_span')
        intervals.append((start, end))
    for index, pattern in enumerate(PATTERNS):
        intervals.extend((m.start(), m.end()) for m in re.finditer(pattern, raw, 0 if index == 7 else re.I))
    # Merge overlaps: quoting dominates inner numbers, URLs and vocabulary.
    merged = []
    for start, end in sorted(intervals):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    nonce = hashlib.sha256((CONTRACT['version'] + raw).encode()).hexdigest()[:12]
    parts, spans, cursor = [], [], 0
    for index, (start, end) in enumerate(merged):
        token = f'⟦{nonce}:{index}⟧'
        parts.extend([raw[cursor:start], token])
        spans.append((token, raw[start:end]))
        cursor = end
    parts.append(raw[cursor:])
    return Document(raw, ''.join(parts), tuple(spans))


def restore(candidate: str, document: Document) -> str:
    expected = [token for token, _ in document.spans]
    if TOKEN.findall(candidate) != expected:
        raise ValueError('placeholder_identity_count_order')
    residue = TOKEN.sub('', candidate)
    if '⟦' in residue or '⟧' in residue:
        raise ValueError('placeholder_malformed')
    for token, value in document.spans:
        candidate = candidate.replace(token, value)
    return candidate


def words(text):
    return [w.lower() for w in WORDS.findall(text)]


def select(document: Document, candidate: object) -> dict:
    result = dict(raw=document.raw, candidate=candidate if isinstance(candidate, str) else None,
                  selected=document.raw, status='fallback', reason='malformed_output',
                  contract=CONTRACT['version'])
    if not isinstance(candidate, str) or not candidate.strip() or len(candidate) > CONTRACT['max_output_characters']:
        return result
    try:
        restored = restore(candidate, document)
    except ValueError as error:
        return dict(result, reason=str(error))
    # Conserve unrecognized symbols too: detector omissions must not permit changing money/signs/units.
    def symbols(text):
        return re.sub(r'[\w\s.,]', '', TOKEN.sub('', text))
    if symbols(document.text) != symbols(candidate):
        return dict(result, reason='literal_symbol_changed')
    source_words, candidate_words = words(document.text), words(candidate)
    raw_words, restored_words = words(document.raw), words(restored)
    if RISK.search(document.raw) and (raw_words != restored_words or document.raw.lower().rstrip('.') != restored.lower().rstrip('.')):
        return dict(result, reason='sensitive_clause_changed')
    # No grammar rule engine: conservative content sequence tripwire. It rejects many valid edits.
    source_content = [w for w in source_words if w not in FILLERS | FUNCTION]
    candidate_content = [w for w in candidate_words if w not in FILLERS | FUNCTION]
    if source_content != candidate_content:
        return dict(result, reason='content_sequence_changed')
    if Counter(candidate_words) - Counter(source_words) and any(
        w not in FUNCTION for w in (Counter(candidate_words) - Counter(source_words))
    ):
        return dict(result, reason='unsupported_insertion')
    if len(candidate_words) < max(1, len(source_words) * .65) or len(candidate_words) > len(source_words) * 1.25 + 2:
        return dict(result, reason='edit_budget')
    # New punctuation can change intent, quote scope or polarity even with identical words.
    def punctuation_anchors(text):
        text = TOKEN.sub('LITERAL', text)
        return [(m.group(), tuple(words(text[:m.start()]))) for m in re.finditer(r'[?!;:]', text)]
    if punctuation_anchors(candidate) != punctuation_anchors(document.text) or any(candidate.count(mark) != document.text.count(mark) for mark in ['\"', '“', '”']):
        return dict(result, reason='punctuation_scope')
    return dict(result, selected=restored, status='accepted', reason='invariants_passed')
