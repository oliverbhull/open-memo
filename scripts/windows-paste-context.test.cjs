const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');
const entry = path.resolve('electron/main/services/checkedPaste.ts');
const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text;
const loaded = new Module(entry, module), original = Module._load;
Module._load = (name, ...args) => name === 'electron' ? { app: { isPackaged: false } } : original(name, ...args);
try { loaded._compile(js, entry); } finally { Module._load = original; }
const { parseWindowsPasteResult } = loaded.exports;

test('Windows delivery preserves Unicode app and window titles without delimiter ambiguity', () => {
  const appContext = { appName: 'Notepad', windowTitle: 'Résumé – 東京\nNotes\u001eTitle', appPath: 'C:\\Apps\\東京\\Notepad.exe' };
  assert.deepEqual(parseWindowsPasteResult(JSON.stringify({ status: 'pasted', appContext })), { status: 'pasted', appContext });
});
test('Windows missing or malformed context never invents target identity or paste success', () => {
  assert.deepEqual(parseWindowsPasteResult('pasted'), { status: 'pasted' });
  assert.deepEqual(parseWindowsPasteResult('{"status":"pasted","appContext":{"appName":42}}'), { status: 'pasted' });
  for (const raw of ['garbage', '{}', '{"status":"target_unavailable","appContext":{"appName":"Stale"}}']) {
    assert.deepEqual(parseWindowsPasteResult(raw), { status: 'target_unavailable' });
  }
});
test('Windows metadata is bounded before reaching history', () => {
  const result = parseWindowsPasteResult(JSON.stringify({ status: 'pasted', appContext: { appName: 'a'.repeat(500), windowTitle: 't'.repeat(2000) } }));
  assert.equal(result.appContext.appName.length, 200);
  assert.equal(result.appContext.windowTitle.length, 1000);
});
