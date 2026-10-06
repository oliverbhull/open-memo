const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve('electron/main/services/UpdaterCache.ts');
const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(entry, module);
loaded._compile(compiled, entry);
const { pruneUpdaterCache } = loaded.exports;

test('removes duplicate ZIP and installed update while keeping a future pending update', async t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-updater-cache-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const pending = path.join(cache, 'pending');
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(cache, 'update.zip'), 'duplicate');
  fs.writeFileSync(path.join(pending, 'Open-Memo-0.8.19-arm64.zip'), 'old update');
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: 'Open-Memo-0.8.19-arm64.zip' }));
  await pruneUpdaterCache(cache, '0.8.20');
  assert.equal(fs.existsSync(path.join(cache, 'update.zip')), false);
  assert.equal(fs.existsSync(pending), false);

  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'Open-Memo-0.8.21-arm64.zip'), 'future update');
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: 'Open-Memo-0.8.21-arm64.zip' }));
  await pruneUpdaterCache(cache, '0.8.20');
  assert.equal(fs.existsSync(path.join(pending, 'Open-Memo-0.8.21-arm64.zip')), true);
});
