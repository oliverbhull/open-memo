const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PassThrough } = require('node:stream');
const { buildSync } = require('esbuild');
const { separateModelAssets } = require('./model-assets.cjs');
const { verifyUpdateAssets } = require('./verify-update-assets.cjs');
const compiled = buildSync({ entryPoints: ['electron/main/services/ModelAssets.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], define: { 'process.platform': '"darwin"' }, write: false }).outputFiles[0].text;

function fixture(t, corruptDownload = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-model-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = path.join(root, 'full');
  const slim = path.join(root, 'slim');
  const archives = path.join(root, 'archives');
  for (const relative of ['conomo/model/weights.bin', 'conomo/model/config.json', 'pnc/compiled/Model.mlmodelc/weights.bin']) {
    fs.mkdirSync(path.dirname(path.join(full, relative)), { recursive: true });
    fs.writeFileSync(path.join(full, relative), `fixture ${relative}`);
  }
  fs.cpSync(full, slim, { recursive: true });
  separateModelAssets(slim, archives, '1.2.3');
  const contract = JSON.parse(fs.readFileSync(path.join(slim, 'model-assets.json')));
  let downloads = 0;
  const loaded = new Module(path.resolve('model-assets-fixture.cjs'), module);
  const original = Module._load;
  const oldResources = process.resourcesPath;
  process.resourcesPath = slim;
  t.after(() => { process.resourcesPath = oldResources; });
  Module._load = (id, ...args) => {
    if (id === 'electron') return { app: { isPackaged: true, getPath: () => path.join(root, 'user') } };
    if (id === 'node:https') return { get(url, callback) {
      downloads++;
      const stream = new PassThrough();
      stream.statusCode = 200;
      stream.setTimeout = () => {};
      queueMicrotask(() => {
        callback(stream);
        stream.end(corruptDownload ? Buffer.from('corrupt') : fs.readFileSync(path.join(archives, path.basename(url.pathname))));
      });
      return { setTimeout() {}, on() {} };
    } };
    return original(id, ...args);
  };
  try { loaded._compile(compiled, path.resolve('model-assets-fixture.cjs')); } finally { Module._load = original; }
  return { root, full, slim, archives, contract, service: loaded.exports, get downloads() { return downloads; } };
}
const macTar = { skip: !fs.existsSync('/usr/bin/tar') };
test('lightweight artifacts omit weights and match the offline installer', macTar, t => {
  const f = fixture(t);
  verifyUpdateAssets(f.slim, f.full, f.archives);
  assert.equal(fs.existsSync(path.join(f.slim, 'conomo', 'model')), false);
  assert.equal(fs.existsSync(path.join(f.slim, 'pnc', 'compiled')), false);
});
test('first upgrade copies installed models and later upgrades reuse them offline', macTar, async t => {
  const f = fixture(t);
  await f.service.prepareModelAssets(f.slim, [f.full]);
  assert.equal(f.downloads, 0);
  const speech = f.service.resolveModelAssetPath('conomo', '/unused-runtime');
  assert.equal(fs.readFileSync(path.join(speech, 'weights.bin'), 'utf8'), 'fixture conomo/model/weights.bin');
  fs.rmSync(f.full, { recursive: true });
  await f.service.prepareModelAssets(f.slim);
  assert.equal(f.downloads, 0);
});
test('missing models download independently and a damaged model is repaired alone', macTar, async t => {
  const f = fixture(t);
  await f.service.prepareModelAssets(f.slim);
  assert.equal(f.downloads, 2);
  fs.writeFileSync(path.join(f.service.resolveModelAssetPath('conomo', ''), 'weights.bin'), 'damage');
  await f.service.prepareModelAssets(f.slim);
  assert.equal(f.downloads, 3);
  await f.service.prepareModelAssets(f.slim);
  assert.equal(f.downloads, 3);
});
test('corrupt model downloads never activate or leave partial archives', macTar, async t => {
  const f = fixture(t, true);
  await assert.rejects(f.service.prepareModelAssets(f.slim), /integrity/);
  const directory = path.join(f.root, 'user', 'model-assets', 'conomo');
  assert.deepEqual(fs.readdirSync(directory), []);
});
test('invalid model contracts are rejected before any download', macTar, async t => {
  const f = fixture(t);
  f.contract.assets.conomo.files['../escape'] = { bytes: 1, sha256: 'a'.repeat(64) };
  fs.writeFileSync(path.join(f.slim, 'model-assets.json'), JSON.stringify(f.contract));
  await assert.rejects(f.service.prepareModelAssets(f.slim), /Invalid model assets file/);
  assert.equal(f.downloads, 0);
});
test('a full installer resolves its own models without downloading', macTar, async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.slim, 'model-assets.json'));
  await f.service.prepareModelAssets(f.slim);
  assert.equal(f.service.resolveModelAssetPath('conomo', f.full), path.join(f.full, 'model'));
  assert.equal(f.downloads, 0);
});
