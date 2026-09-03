const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { isDictationBinary, signingOptionsForFile } = require('./sign.cjs');

test('recognizes only the packaged dictation helper', () => {
  assert.equal(isDictationBinary('/tmp/Memo.app/Contents/Resources/dictation/memo-dictation'), true);
  assert.equal(isDictationBinary('/tmp/Memo.app/Contents/Resources/conomo/conomo'), false);
});

test('sets dictation identity and entitlements inside the primary signing pass', () => {
  const defaults = () => ({ hardenedRuntime: true, additionalArguments: ['--timestamp'] });
  const options = signingOptionsForFile(
    defaults,
    '/tmp/Memo.app/Contents/Resources/dictation/memo-dictation',
  );

  assert.equal(options.hardenedRuntime, true);
  assert.equal(options.entitlements, path.resolve('config/entitlements.dictation.plist'));
  assert.deepEqual(options.additionalArguments, [
    '--timestamp',
    '--identifier', 'com.memo.desktop.dictation',
  ]);
});

test('preserves default signing policy for every other file', () => {
  const expected = { entitlements: '/tmp/default.plist' };
  assert.equal(signingOptionsForFile(() => expected, '/tmp/Memo.app/Contents/MacOS/Memo'), expected);
});
