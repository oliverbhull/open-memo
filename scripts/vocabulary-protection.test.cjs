const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve('electron/main/services/vocabularyProtection.ts');
const compiled = buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;
const loaded = new Module(entry, module);
loaded._compile(compiled, entry);
const { protectVocabulary } = loaded.exports;

test('protects exact vocabulary terms and restores canonical spelling', () => {
  const protectedText = protectVocabulary(
    'rayaan met Jtech at Suffolk with the supermicrophone.',
    ['Rayaan', 'JTECH', 'Suffolk', 'supermicrophone'],
  );
  assert.doesNotMatch(protectedText.text, /rayaan|jtech|suffolk|supermicrophone/i);
  const restored = protectedText.restore(`Yesterday, ${protectedText.text}`);
  assert.deepEqual(restored, {
    ok: true,
    text: 'Yesterday, Rayaan met JTECH at Suffolk with the supermicrophone.',
  });
});

test('uses one pass for overlapping terms and does not rewrite substrings', () => {
  const protectedText = protectVocabulary(
    'Memo met Open Memo about a memorandum and genuine rayon.',
    ['Memo', 'Open Memo', 'Rayaan'],
  );
  const restored = protectedText.restore(protectedText.text);
  assert.deepEqual(restored, {
    ok: true,
    text: 'Memo met Open Memo about a memorandum and genuine rayon.',
  });
});

test('rejects missing, duplicated, altered, and invented placeholders', () => {
  const protectedText = protectVocabulary('Rayaan met JTECH.', ['Rayaan', 'JTECH']);
  const markers = protectedText.text.match(/__MEMO_VOCAB_[A-F0-9]+_\d+__/g);
  assert.equal(markers.length, 2);
  assert.deepEqual(protectedText.restore(protectedText.text.replace(markers[0], 'Rayon')), { ok: false });
  assert.deepEqual(protectedText.restore(`${protectedText.text} ${markers[0]}`), { ok: false });
  assert.deepEqual(protectedText.restore(protectedText.text.replace(markers[0], `${markers[0]}x`)), { ok: false });
  assert.deepEqual(protectedText.restore(`${protectedText.text} __MEMO_VOCAB_0_99__`), { ok: false });
});

test('empty vocabulary is a no-op', () => {
  const protectedText = protectVocabulary('Leave this untouched.', []);
  assert.equal(protectedText.text, 'Leave this untouched.');
  assert.deepEqual(protectedText.restore('Cleaned text.'), { ok: true, text: 'Cleaned text.' });
});
