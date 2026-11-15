const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');
const entry = path.resolve('electron/shared/windowTitle.ts');
const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(entry, module); loaded._compile(js, entry);
const { resolveWindowTitle, cleanWebTitle } = loaded.exports;
const claude = 'com.anthropic.claudefordesktop';

test('a static Electron window title takes the chat title from the web contents', () => {
  assert.equal(resolveWindowTitle('Claude', 'Claude', claude, { bundleId: claude, webTitle: 'Chat title visibility - Claude' }), 'Chat title visibility');
  assert.equal(resolveWindowTitle('', 'Slack', 'com.tinyspeck.slackmacgap', { bundleId: 'com.tinyspeck.slackmacgap', webTitle: 'Slack | general | Memo' }), 'general | Memo');
});

test('descriptive window titles, other apps and bare app names are left alone', () => {
  assert.equal(resolveWindowTitle('Investigate Cognito login redirect', 'ChatGPT', 'com.openai.chat', { bundleId: 'com.openai.chat', webTitle: 'x' }), 'Investigate Cognito login redirect');
  assert.equal(resolveWindowTitle('Claude', 'Claude', claude, { bundleId: 'com.google.Chrome', webTitle: 'Other' }), 'Claude');
  assert.equal(resolveWindowTitle('Claude', 'Claude', claude, { bundleId: claude, webTitle: 'Claude' }), 'Claude');
  assert.equal(resolveWindowTitle('Claude', 'Claude', claude, undefined), 'Claude');
});

test('app-name suffixes and prefixes are trimmed with common separators', () => {
  for (const value of ['Plan – Claude', 'Plan | Claude', 'Plan · Claude', 'Claude - Plan', '  Plan   - claude ']) assert.equal(cleanWebTitle(value, 'Claude'), 'Plan');
  assert.equal(cleanWebTitle('Claude Code tips', 'Claude'), 'Claude Code tips');
});
