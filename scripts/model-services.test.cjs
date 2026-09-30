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

test('later model choice wins over a pending Whisper download', async () => {
  let settings = { asrModel: 'conomo' };
  const Service = load('AsrModelService', {
    electron: { app: { isPackaged: true, getPath: () => '/nonexistent' } },
    './SettingsService': { loadSettings: () => ({ ...settings }), saveSettings: next => { settings = next; } },
  });
  const service = new Service();
  let finish;
  service.downloadWhisper = () => new Promise(resolve => { finish = resolve; });
  let restarts = 0;
  const oldSelection = service.selectModel('whisper', () => { restarts++; });
  assert.equal((await service.selectModel('conomo', () => { restarts++; })).success, true);
  finish();
  assert.equal((await oldSelection).success, false);
  assert.equal(settings.asrModel, 'conomo');
  assert.equal(restarts, 0);
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
