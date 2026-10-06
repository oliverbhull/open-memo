const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { buildSync } = require('esbuild');
const fs = require('node:fs');

function load(name, mocks) {
  const entry = path.resolve(`electron/main/services/${name}.ts`);
  const source = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', './SettingsService'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (id, ...args) => Object.hasOwn(mocks, id) ? mocks[id] : original(id, ...args);
  try { loaded._compile(source, entry); } finally { Module._load = original; }
  return loaded.exports[name];
}

test('old punctuation worker exit cannot disable replacement; pipe errors retain original', async () => {
  const workers = [];
  const Service = load('PunctuationService', {
    electron: { app: { isPackaged: false } },
    'node:fs': { readdirSync: () => ['test.mlmodelc'] },
    'node:child_process': { spawn: () => {
      const worker = new EventEmitter();
      worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.stdin = new PassThrough();
      worker.kill = () => true; workers.push(worker); return worker;
    } },
  });
  const service = new Service();
  try {
    service.start(); service.stop(); service.start();
    workers[1].stdout.write('READY\n');
    workers[0].emit('exit', 0, null);
    const pending = service.format('hello there');
    const request = JSON.parse(workers[1].stdin.read().toString());
    workers[1].stdout.write(JSON.stringify({ id: request.id, text: 'Hello there.' }) + '\n');
    assert.equal(await pending, 'Hello there.');
    const failed = service.format('another phrase');
    workers[1].stdin.emit('error', new Error('EPIPE'));
    assert.equal(await failed, 'another phrase');
  } finally { service.stop(); }
});

test('upgrade resets Whisper selection and removes its downloads without touching other models', async t => {
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'memo-whisper-migration-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const whisperDirectory = path.join(userData, 'models', 'whisper');
  const otherModel = path.join(userData, 'models', 'other', 'keep.bin');
  fs.mkdirSync(whisperDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(otherModel), { recursive: true });
  fs.writeFileSync(path.join(whisperDirectory, 'ggml-small.en-q5_1.bin'), 'old model');
  fs.writeFileSync(path.join(whisperDirectory, 'ggml-small.en-q5_1.bin.part'), 'partial download');
  fs.writeFileSync(otherModel, 'keep');
  let selection = 'whisper';
  const entry = path.resolve('electron/main/services/LegacyWhisperCleanup.ts');
  const source = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', './SettingsService', '../utils/logger'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (id, ...args) => {
    if (id === 'electron') return { app: { getPath: () => userData } };
    if (id === './SettingsService') return { store: { get: () => selection, set: (_key, value) => { selection = value; } } };
    if (id === '../utils/logger') return { logger: { info() {} } };
    return original(id, ...args);
  };
  try { loaded._compile(source, entry); } finally { Module._load = original; }
  await loaded.exports.removeLegacyWhisperModel();
  await loaded.exports.removeLegacyWhisperModel();
  assert.equal(selection, 'conomo');
  assert.equal(fs.existsSync(whisperDirectory), false);
  assert.equal(fs.readFileSync(otherModel, 'utf8'), 'keep');
});

test('removing Cleaned leaves included model packs in place', async t => {
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'memo-cleaned-removal-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const root = path.join(userData, 'model-packs');
  fs.mkdirSync(path.join(root, 'cleanup', 'pack'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conomo', 'pack'), { recursive: true });
  const entry = path.resolve('electron/main/services/ModelPackService.ts');
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (id, ...args) => id === 'electron'
    ? { app: { getPath: () => userData } }
    : original(id, ...args);
  try { loaded._compile(compiled, entry); } finally { Module._load = original; }
  await loaded.exports.removeCleanupModelPack();
  assert.equal(fs.existsSync(path.join(root, 'cleanup')), false);
  assert.equal(fs.existsSync(path.join(root, 'conomo')), true);
});

test('verified bundled models replace legacy copies without touching downloaded Cleaned', async t => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'memo-bundled-models-'));
  const oldResourcesPath = process.resourcesPath;
  process.resourcesPath = path.join(temporary, 'resources');
  t.after(() => {
    process.resourcesPath = oldResourcesPath;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const conomo = path.join(process.resourcesPath, 'conomo');
  for (const relative of ['conomo', 'compiled/Model.mlmodelc/weights.bin', 'tokenizer.json', 'manifest.json', 'VERSIONS', 'device-runtime/bin/python3.12']) {
    const file = path.join(conomo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'good');
  }
  fs.writeFileSync(path.join(conomo, 'model-pack.json'), JSON.stringify(require('./model-pack-manifest.cjs').createManifest('conomo', conomo)));
  const contextualLauncher = path.join(process.resourcesPath, 'dictation', 'run-contextual-conomo');
  fs.mkdirSync(path.dirname(contextualLauncher), { recursive: true });
  fs.writeFileSync(contextualLauncher, '#!/bin/sh\nprintf "READY\\n"\n', { mode: 0o755 });
  const entry = path.resolve('electron/main/services/ModelPackService.ts');
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (id, ...args) => id === 'electron'
    ? { app: { isPackaged: true, getPath: () => temporary, getVersion: () => '1.0.1' } }
    : original(id, ...args);
  try { loaded._compile(compiled, entry); } finally { Module._load = original; }
  const service = loaded.exports;
  const legacyConomo = path.join(temporary, 'model-packs', 'conomo', '00000000000000000000');
  const legacyPnc = path.join(temporary, 'model-packs', 'pnc', '00000000000000000000');
  const downloadedCleaned = path.join(temporary, 'model-packs', 'cleanup', 'saved');
  fs.mkdirSync(legacyConomo, { recursive: true });
  fs.mkdirSync(legacyPnc, { recursive: true });
  fs.mkdirSync(downloadedCleaned, { recursive: true });
  fs.cpSync(conomo, legacyConomo, { recursive: true });
  fs.writeFileSync(path.join(temporary, 'model-packs', 'conomo', 'active.json'), JSON.stringify({ schemaVersion: 1, name: 'conomo', version: '00000000000000000000' }));
  assert.equal(service.resolveModelPackPath('conomo'), legacyConomo);
  await assert.rejects(service.verifyBundledModelPacks());
  await service.removeLegacyBundledModelPacks();
  assert.equal(fs.existsSync(legacyConomo), true);
  const pnc = path.join(process.resourcesPath, 'pnc');
  for (const relative of ['memo-pnc', 'compiled/Model.mlmodelc/weights.bin', 'tokenizer.vocab', 'manifest.json', 'VERSIONS']) {
    const file = path.join(pnc, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'good');
  }
  fs.writeFileSync(path.join(pnc, 'memo-pnc'), '#!/bin/sh\nprintf "READY\\n"\n', { mode: 0o755 });
  fs.chmodSync(path.join(pnc, 'memo-pnc'), 0o755);
  fs.writeFileSync(path.join(pnc, 'model-pack.json'), JSON.stringify(require('./model-pack-manifest.cjs').createManifest('pnc', pnc)));
  await service.verifyBundledModelPacks();
  assert.equal(service.resolveModelPackPath('conomo'), conomo);
  assert.equal(service.resolveModelPackPath('pnc'), pnc);
  await service.removeLegacyBundledModelPacks();
  assert.equal(fs.existsSync(legacyConomo), false);
  assert.equal(fs.existsSync(legacyPnc), false);
  assert.equal(fs.existsSync(downloadedCleaned), true);
});

test('cleanup download is immutable, verified, and absent from packaged resources', () => {
  const service = fs.readFileSync(path.resolve('electron/main/services/ModelPackService.ts'), 'utf8');
  const packageJson = require('../package.json');
  assert.match(service, /cleanup-model-v1\/open-memo-cleanup-v1\.tar\.gz/);
  assert.match(service, /CLEANUP_PACK_BYTES = 1_034_639_401/);
  assert.match(service, /CLEANUP_PACK_SHA256 = '932c010ad09edf1331486a134c59b0fc5b850d78a2f15db839d79c1a5f6530c0'/);
  assert.match(service, /downloadedBytes !== CLEANUP_PACK_BYTES \|\| hash\.digest\('hex'\) !== CLEANUP_PACK_SHA256/);
  assert.match(service, /Downloaded Cleaned package is incomplete/);
  assert.equal(packageJson.build.extraResources.some(resource => resource?.to === 'cleanup'), false);
});
