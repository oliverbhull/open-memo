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
    external: ['electron', './SettingsService'], define: { 'process.platform': '"darwin"' }, write: false }).outputFiles[0].text;
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
    'node:fs': { readdirSync: () => ['test.mlmodelc'], existsSync: () => true },
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
    external: ['electron', './SettingsService', '../utils/logger'], define: { 'process.platform': '"darwin"' }, write: false }).outputFiles[0].text;
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

test('verified bundled models replace legacy copies without touching downloaded Cleaned', async t => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'memo-bundled-models-'));
  const oldResourcesPath = process.resourcesPath;
  process.resourcesPath = path.join(temporary, 'resources');
  t.after(() => {
    process.resourcesPath = oldResourcesPath;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const conomo = path.join(process.resourcesPath, 'conomo');
  for (const relative of ['conomo', 'model/weights.bin', 'runtime/worker.py', 'runtime/model_assets.py', 'MODEL-LICENSE', 'VERSIONS', 'device-runtime/bin/python3.12']) {
    const file = path.join(conomo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'good');
  }
  const contextualLauncher = path.join(conomo, 'conomo');
  fs.mkdirSync(path.dirname(contextualLauncher), { recursive: true });
  fs.writeFileSync(contextualLauncher, '#!/bin/sh\nprintf "READY\\n"\n');
  fs.chmodSync(contextualLauncher, 0o755);
  fs.writeFileSync(path.join(conomo, 'model-pack.json'), JSON.stringify(require('./model-pack-manifest.cjs').createManifest('conomo', conomo)));
  const entry = path.resolve('electron/main/services/ModelPackService.ts');
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { 'process.platform': '"darwin"' }, write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  const workerLaunches = [];
  Module._load = (id, ...args) => {
    if (id === 'electron') return { app: { isPackaged: true, getPath: () => temporary, getVersion: () => '1.0.1' } };
    // A Windows host cannot execute the Mac shell fixtures. Keep integrity checks
    // real and emulate only the worker process boundary, including READY output.
    if (process.platform === 'win32' && id === 'node:child_process') return {
      execFile(command, commandArgs, options, callback) {
        assert.match(fs.readFileSync(command, 'utf8'), /READY/);
        assert.ok(commandArgs.includes('--worker'));
        assert.equal(options.timeout, 120_000);
        workerLaunches.push(command);
        queueMicrotask(() => callback(null, 'READY\n', ''));
        return { stdin: { end() {} } };
      },
    };
    return original(id, ...args);
  };
  try { loaded._compile(compiled, entry); } finally { Module._load = original; }
  const service = loaded.exports;
  const legacyConomo = path.join(temporary, 'model-packs', 'conomo', '00000000000000000000');
  const legacyPnc = path.join(temporary, 'model-packs', 'pnc', '00000000000000000000');
  const downloadedCleaned = path.join(temporary, 'model-packs', 'cleanup', 'saved');
  fs.mkdirSync(legacyConomo, { recursive: true });
  fs.mkdirSync(legacyPnc, { recursive: true });
  fs.mkdirSync(downloadedCleaned, { recursive: true });
  fs.cpSync(conomo, legacyConomo, { recursive: true });
  fs.rmSync(path.join(legacyConomo, 'runtime'), { recursive: true, force: true });
  fs.mkdirSync(path.join(legacyConomo, 'runtime', 'conomo'), { recursive: true });
  fs.writeFileSync(path.join(legacyConomo, 'runtime', 'conomo', 'model-manifest.json'), 'legacy');
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
  if (process.platform === 'win32') assert.deepEqual(workerLaunches, [contextualLauncher, contextualLauncher, path.join(pnc, 'memo-pnc')]);
  assert.equal(service.resolveModelPackPath('conomo'), conomo);
  assert.equal(service.resolveModelPackPath('pnc'), pnc);
  await service.removeLegacyBundledModelPacks();
  assert.equal(fs.existsSync(legacyConomo), false);
  assert.equal(fs.existsSync(legacyPnc), false);
  assert.equal(fs.existsSync(downloadedCleaned), true);
});
