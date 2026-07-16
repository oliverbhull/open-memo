import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPhraseReplacements,
  clampPhraseReplacementRulesFromInput,
  MAX_PHRASE_REPLACEMENT_RULES,
} from '../electron/main/services/phraseReplacement.ts';
import {
  stripLeadingDashSpace,
  stripTrailingEnter,
} from '../electron/main/services/textProcessing.ts';

test('removes only a leading transcription dash', () => {
  assert.equal(stripLeadingDashSpace(' - Hello there'), 'Hello there');
  assert.equal(stripLeadingDashSpace('Hello - there'), 'Hello - there');
});

test('converts a trailing spoken enter only when enabled', () => {
  assert.deepEqual(stripTrailingEnter('Send this Enter.', true), {
    textToPaste: 'Send this',
    pressEnter: true,
  });
  assert.deepEqual(stripTrailingEnter('Send this Enter.', false), {
    textToPaste: 'Send this Enter.',
    pressEnter: false,
  });
});

test('applies phrase replacements across case, spacing, and punctuation', () => {
  const rules = [{ id: '1', find: 'open memo', replace: 'OpenMemo', enabled: true }];
  assert.equal(applyPhraseReplacements('OPEN,   MEMO and open memo', rules), 'OpenMemo and OpenMemo');
});

test('ignores disabled phrase rules', () => {
  const rules = [{ id: '1', find: 'alpha', replace: 'beta', enabled: false }];
  assert.equal(applyPhraseReplacements('alpha', rules), 'alpha');
});

test('validates and caps phrase replacement input', () => {
  const input = Array.from({ length: MAX_PHRASE_REPLACEMENT_RULES + 10 }, (_, index) => ({
    id: `rule-${index}`,
    find: ` phrase ${index} `,
    replace: String(index),
  }));
  const result = clampPhraseReplacementRulesFromInput(input);
  assert.equal(result.length, MAX_PHRASE_REPLACEMENT_RULES);
  assert.equal(result[0]?.find, 'phrase 0');
});
