const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(execFile = () => {}) {
  const entry = path.resolve('electron/main/services/emailFormatting.ts');
  const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const mod = new Module(entry, module);
  mod.require = name => name === 'node:child_process' ? { execFile } : require(name);
  mod._compile(code, entry);
  return mod.exports;
}

test('email targets use exact browser identity and Gmail origin', () => {
  const { isEmailTarget } = load();
  assert.equal(isEmailTarget({ bundleId: 'com.apple.Safari' }), true);
  assert.equal(isEmailTarget({ bundleId: 'com.google.Chrome', url: 'https://mail.google.com/mail/u/0/#inbox' }), true);
  for (const url of ['https://mail.google.com.evil.test', 'https://evil.test/mail.google.com', 'https://google.com', 'file:///mail.google.com', 'http://mail.google.com', 'not a URL', '']) {
    assert.equal(isEmailTarget({ bundleId: 'com.google.Chrome', url }), false, url);
  }
  assert.equal(isEmailTarget({ bundleId: 'com.example.Editor', url: 'https://mail.google.com' }), false);
  assert.equal(isEmailTarget({}), false);
});

test('context lookup is bounded and falls back when accessibility is unavailable', async () => {
  const { detectEmailTarget } = load((_command, _args, options, callback) => {
    assert.equal(options.timeout, 750);
    callback(new Error('access denied'), '');
  });
  assert.equal(await detectEmailTarget(), false);
});

test('context lookup parses active document URL without requiring page contents', async () => {
  const { detectEmailTarget } = load((_command, _args, _options, callback) => {
    callback(null, 'com.google.Chrome\x1ehttps://mail.google.com/mail/u/0/\n');
  });
  assert.equal(await detectEmailTarget(), process.platform === 'darwin');
});

test('single-paragraph email gets greeting, body, closing, and signature breaks', () => {
  const { formatEmailLineBreaks } = load();
  const input = 'Hi Jason, Great to be connected. We’ll try to make this as easy as possible for you. If you pick a time, we’ll make it work. Thanks, Oliver.';
  const expected = 'Hi Jason,\n\nGreat to be connected. We’ll try to make this as easy as possible for you. If you pick a time, we’ll make it work.\n\nThanks,\nOliver';
  assert.equal(formatEmailLineBreaks(input), expected);
  assert.equal(formatEmailLineBreaks(expected), expected);
});

test('email layout preserves body paragraphs and does not invent missing parts', () => {
  const { formatEmailLineBreaks: format } = load();
  assert.equal(format('Please send the invoice. Do not include installation.'), 'Please send the invoice. Do not include installation.');
  assert.equal(format('Hi Jason,\nFirst paragraph.\n\nSecond paragraph.\nThanks,\nOliver'), 'Hi Jason,\n\nFirst paragraph.\n\nSecond paragraph.\n\nThanks,\nOliver');
  assert.equal(format('Thanks, Oliver, for sending that.'), 'Thanks, Oliver, for sending that.');
  assert.equal(format('Say hi Jason, when you arrive. Thanks for your help.'), 'Say hi Jason, when you arrive. Thanks for your help.');
  assert.equal(format('Hello José, Please send it. Best regards, Oliver Hull.'), 'Hello José,\n\nPlease send it.\n\nBest regards,\nOliver Hull');
});

test('onboarding name replaces the generated sender and signs unsigned emails', () => {
  const { formatEmailLineBreaks: format } = load();
  const wrong = 'Hi Jason, Great to be connected. Thanks, Jamie.';
  const expected = 'Hi Jason,\n\nGreat to be connected.\n\nThanks,\nOliver Hull';
  assert.equal(format(wrong, 'Oliver Hull'), expected);
  assert.equal(format(expected, 'Oliver Hull'), expected);
  assert.equal(format('Hi Jason, Please send it. Thanks.', 'Oliver'), 'Hi Jason,\n\nPlease send it.\n\nThanks,\nOliver');
  assert.equal(format('Please send it.', 'Oliver'), 'Please send it.\n\nOliver');
  assert.equal(format('Please send it. Regards, Jamie.', 'Élodie O’Connor'), 'Please send it.\n\nRegards,\nÉlodie O’Connor');
  assert.equal(format('Jamie sent the quote. Thanks, Jamie.', 'Oliver'), 'Jamie sent the quote.\n\nThanks,\nOliver');
  assert.equal(format('Please send it.', '  '), 'Please send it.');
  assert.equal(format('', 'Oliver'), '');
});

test('email opening preserves the spoken thanks or casual greeting', () => {
  const { preserveEmailOpening: preserve } = load();
  assert.equal(preserve('Hello Dimitri,\n\nThis is helpful.\n\nThanks,\nOliver', 'thanks dimitri this is helpful'), 'Thanks Dimitri,\n\nThis is helpful.\n\nThanks,\nOliver');
  assert.equal(preserve('Dear Jason, Please send it.', 'hey jason please send it'), 'Hey Jason,\n\nPlease send it.');
  assert.equal(preserve('Hi Dimitri, Thanks.', 'hello dimitri thanks'), 'Hello Dimitri,\n\nThanks.');
  assert.equal(preserve('Hello Dimitri, Thanks.', 'thanks for helping Dimitri'), 'Hello Dimitri, Thanks.');
  assert.equal(preserve('Thanks Dimitri,\n\nHelpful.', 'thanks dimitri helpful'), 'Thanks Dimitri,\n\nHelpful.');
});
