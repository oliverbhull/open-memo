const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const compiled = buildSync({ entryPoints: ['electron/renderer/src/utils/applicationUsage.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports });
const group = records => JSON.parse(JSON.stringify(loaded.exports.groupApplicationUsage(records)));

test('Messages with and without a bundle ID combine regardless of history order', () => {
  const records = [
    { appName: 'Messages', words: 126 },
    { appName: 'Messages', bundleId: 'com.apple.MobileSMS', words: 1 },
    { appName: 'Claude', bundleId: 'com.anthropic.claudefordesktop', words: 3 },
  ];
  for (const input of [records, [...records].reverse()]) {
    const apps = group(input);
    assert.equal(apps.length, 2);
    const messages = apps.find(app => app.appName === 'Messages');
    assert.equal(messages.words, 127);
    assert.equal(messages.bundleId, 'com.apple.MobileSMS');
    assert.equal(apps.reduce((sum, app) => sum + app.words, 0), 130);
  }
});

test('whitespace and capitalization do not split one application', () => {
  const apps = group([
    { appName: 'Messages', bundleId: ' com.apple.MobileSMS ', words: 10 },
    { appName: ' messages ', bundleId: '', words: 2 },
    { appName: 'Messages', bundleId: 'COM.APPLE.MOBILESMS', words: 3 },
  ]);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].words, 15);
  assert.equal(apps[0].bundleId, 'com.apple.MobileSMS');
});

test('distinct apps sharing a name keep their identities and ambiguous history', () => {
  const apps = group([
    { appName: 'Editor', bundleId: 'com.example.one', words: 10 },
    { appName: 'Editor', bundleId: 'com.example.two', words: 20 },
    { appName: 'Editor', words: 3 },
  ]);
  assert.equal(apps.length, 3);
  assert.deepEqual(apps.map(app => app.words), [10, 20, 3]);
});

test('renamed applications with the same identifier remain one row', () => {
  const apps = group([
    { appName: 'Old Name', bundleId: 'com.example.app', words: 10 },
    { appName: 'New Name', bundleId: 'com.example.app', words: 20 },
  ]);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].words, 30);
});
