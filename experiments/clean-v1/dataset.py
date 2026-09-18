"""Fail-closed source-linked export. Private input/output paths are always explicit."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from core import CONTRACT, TOKEN, protect


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def export_rows(rows):
    seen_ids, groups, texts = set(), {}, {}
    output = {'train': [], 'validation': []}
    for row in rows:
        if row['id'] in seen_ids: raise ValueError('duplicate_id')
        seen_ids.add(row['id'])
        if row['contract'] != CONTRACT['version'] or row['review_status'] != 'human_approved':
            raise ValueError('unapproved')
        if not row['reviewer'] or row['reviewed_target_sha256'] != digest(row['target']):
            raise ValueError('review_hash')
        if row['source_sha256'] != digest(row['source']): raise ValueError('source_hash')
        if row['exposure'] != 'development' or row['split'] not in output:
            raise ValueError('evaluation_isolation')
        if row['source_kind'] not in ['real', 'synthetic'] or not row['license_or_consent']:
            raise ValueError('provenance')
        if row['source_kind'] == 'real' and (not row.get('audio_reviewed') or not row.get('audio_sha256')):
            raise ValueError('audio_review')
        if row.get('ambiguity') or row.get('decision') not in ['edit', 'noop']:
            raise ValueError('quarantine')
        for key in ['speaker', 'recording', 'family', 'template']:
            value = row.get(key)
            if not isinstance(value, str) or not value: raise ValueError('group_missing')
            group = (key, value)
            if group in groups and groups[group] != row['split']: raise ValueError('group_leakage')
            groups[group] = row['split']
        for text in [row['source'], row['target']]:
            normalized = ' '.join(text.casefold().split())
            if normalized in texts and texts[normalized] != row['split']: raise ValueError('text_leakage')
            texts[normalized] = row['split']
        source = protect(row['source'], row.get('vocabulary', []), row.get('source_entities', []))
        target = protect(row['target'], row.get('vocabulary', []), row.get('target_entities', []))
        # Value equality, multiplicity AND order; target tokens are never trusted as source identities.
        if [value for _, value in source.spans] != [value for _, value in target.spans]:
            raise ValueError('literal_value_changed')
        def residual_symbols(text):
            return re.sub(r'[\w\s.,]', '', TOKEN.sub('', text))
        if residual_symbols(source.text) != residual_symbols(target.text):
            raise ValueError('literal_symbol_changed')
        protected_target = target.text
        for (target_token, _), (source_token, _) in zip(target.spans, source.spans):
            protected_target = protected_target.replace(target_token, source_token)
        output[row['split']].append(dict(messages=[
            dict(role='system', content=CONTRACT['instruction']),
            dict(role='user', content=source.text),
            dict(role='assistant', content=protected_target)], id=row['id']))
    if not all(output.values()): raise ValueError('missing_split')
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    exported = export_rows([json.loads(line) for line in args.input.read_text().splitlines() if line.strip()])
    args.output.mkdir(parents=True, exist_ok=False)
    for split, rows in exported.items():
        (args.output/f'{split}.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
    print(json.dumps({split: len(rows) for split, rows in exported.items()}))

if __name__ == '__main__': main()
