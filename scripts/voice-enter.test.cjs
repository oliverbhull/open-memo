const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');

function load(relativePath) {
  const entry = path.resolve(relativePath);
  const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  loaded._compile(js, entry);
  return loaded.exports;
}

const { formatDictationForPaste, stripTrailingEnter } = load('electron/main/services/textProcessing.ts');
const { applyPhraseReplacements } = load('electron/main/services/phraseReplacement.ts');

test('trailing spoken Enter is captured before cleanup and survives an email sign-off', async () => {
  const result = await formatDictationForPaste('hey sam see you tomorrow enter.', true, async input => {
    assert.equal(input, 'hey sam see you tomorrow');
    return 'Hi Sam,\n\nSee you tomorrow.\n\nBest,\nOliver';
  });
  assert.deepEqual(result, {
    textToPaste: 'Hi Sam,\n\nSee you tomorrow.\n\nBest,\nOliver',
    pressEnter: true,
  });
});

test('cleanup and punctuation formatting can change the ending without losing Enter', async () => {
  for (const output of ['See you tomorrow.', 'See you tomorrow!']) {
    const result = await formatDictationForPaste('see you tomorrow ENTER!', true, async input => {
      assert.equal(input, 'see you tomorrow');
      return output;
    });
    assert.deepEqual(result, { textToPaste: output, pressEnter: true });
  }
});

test('cleanup fallback retains the body and the submit instruction', async () => {
  assert.deepEqual(await formatDictationForPaste('see you tomorrow enter', true, async input => input), {
    textToPaste: 'see you tomorrow', pressEnter: true,
  });
});

test('disabled voice Enter remains part of the formatting input and never submits', async () => {
  const result = await formatDictationForPaste('see you tomorrow enter.', false, async input => {
    assert.equal(input, 'see you tomorrow enter.');
    return 'See you tomorrow enter.';
  });
  assert.deepEqual(result, { textToPaste: 'See you tomorrow enter.', pressEnter: false });
});

test('Enter introduced by cleanup cannot cause submission', async () => {
  assert.deepEqual(await formatDictationForPaste('see you tomorrow', true, async () => 'See you tomorrow enter.'), {
    textToPaste: 'See you tomorrow enter.', pressEnter: false,
  });
});

test('speech without a submit command reaches cleanup unchanged', async () => {
  const original = '  hello\n\nenter the room  ';
  const result = await formatDictationForPaste(original, true, async input => {
    assert.equal(input, original);
    return input;
  });
  assert.deepEqual(result, { textToPaste: original.trim(), pressEnter: false });
});

test('snippets cannot rewrite the captured command or turn saved text into a command', async () => {
  const rules = [{ find: 'enter', replace: 'replacement' }, { find: 'send message', replace: 'Hello enter' }];
  const format = async input => applyPhraseReplacements(input, rules);
  assert.deepEqual(await formatDictationForPaste('hello enter', true, format), {
    textToPaste: 'hello', pressEnter: true,
  });
  assert.deepEqual(await formatDictationForPaste('send message', true, format), {
    textToPaste: 'Hello enter', pressEnter: false,
  });
});

test('command matching tolerates recognition punctuation but requires a final whole word', () => {
  for (const ending of ['enter', 'ENTER.', 'Enter!', 'enter?', 'enter…', 'enter.”', 'enter,']) {
    assert.deepEqual(stripTrailingEnter(`hello ${ending}`, true), { textToPaste: 'hello', pressEnter: true });
  }
  for (const text of ['enter the room', 'hello enter tomorrow', 'hello reenter', 'hello center']) {
    assert.deepEqual(stripTrailingEnter(text, true), { textToPaste: text, pressEnter: false });
  }
});
