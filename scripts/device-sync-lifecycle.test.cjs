const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { transformSync } = require('esbuild');

function setup(options = {}) {
  const children = [];
  const entry = path.resolve('electron/main/services/DeviceSyncService.ts');
  const loaded = new Module(entry, module);
  const original = Module._load;
  const childProcess = require('node:child_process');
  Module._load = (request, parent, isMain) => {
    if (request === 'electron') return { app: { isPackaged: false, getPath: () => '/test-memo' } };
    if (request === 'node:fs') return { ...fs, existsSync: () => true };
    if (request === './AsrModelService') return { isWhisperModelInstalled: () => false, whisperModelPath: () => '/model' };
    if (request === './ModelPackService') return { resolveModelPackPath: () => '/test-conomo' };
    if (request === './FirmwareReleaseService') return { FirmwareReleaseService: class {} };
    if (request === './SettingsService') return { loadSettings: () => ({ asrModel: 'conomo' }) };
    if (request === '../utils/logger') return { logger: { info() {}, warn() {}, error() {} } };
    if (request === 'node:child_process') return { ...childProcess, spawn(_bin, args) {
      const child = new EventEmitter();
      child.args = args;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); };
      children.push(child);
      return child;
    } };
    return original(request, parent, isMain);
  };
  try { loaded._compile(transformSync(fs.readFileSync(entry, 'utf8'), { loader: 'ts', format: 'cjs' }).code, entry); }
  finally { Module._load = original; }
  const service = new loaded.exports.DeviceSyncService({ pauseDictation: async () => true, resumeDictation() {}, ...options });
  service.legacyOwnerIsLoaded = async () => false;
  return { service, children };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent starts spawn one parent-bound worker', async () => {
  const { service, children } = setup();
  await Promise.all([service.start(), service.start()]);
  assert.equal(children.length, 1);
  const index = children[0].args.indexOf('--parent-pid');
  assert.equal(children[0].args[index + 1], String(process.pid));
  await service.stop();
});

test('stopped worker output and delayed grants cannot target its replacement', async () => {
  let release;
  let resumes = 0;
  const { service, children } = setup({
    pauseDictation: () => new Promise(resolve => { release = resolve; }),
    resumeDictation: () => { resumes++; },
  });
  await service.start();
  children[0].stdout.write(JSON.stringify({ type: 'status', state: 'transcribing', batchId: 'old' }) + '\n');
  await service.stop();
  await service.start();
  let writes = '';
  children[1].stdin.on('data', chunk => { writes += chunk; });
  release(true);
  await tick();
  assert.equal(writes, '');
  assert.equal(resumes, 1);
  children[0].stdout.write(JSON.stringify({ type: 'status', state: 'complete', batchId: 'stale' }) + '\n');
  assert.notEqual(service.getStatus().batchId, 'stale');
  await service.stop();
});

test('lock conflicts retry when the competing app releases ownership', async () => {
  const { service, children } = setup();
  await service.start();
  children[0].exitCode = 2;
  children[0].emit('exit', 2, null);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(children.length, 2);
  await service.stop();
});

test('failed spawn close clears ownership even without an exit event', async () => {
  const { service, children } = setup();
  await service.start();
  children[0].emit('error', new Error('spawn denied'));
  children[0].emit('close', -2, null);
  assert.equal(service.getStatus().code, 'worker-start');
  await service.stop();
  await service.start();
  assert.equal(children.length, 2);
  await service.stop();
});

test('firmware updater shares sync lock and preserves owner-conflict diagnostics', async () => {
  const { service, children } = setup();
  const update = service.runFirmwareUpdater({ path: '/test.uf2', sha256: 'abc', firmwareVersion: '1.0' }, 'device');
  const child = children[0];
  assert.equal(child.args[child.args.indexOf('--lock') + 1], '/test-memo/device-sync.lock');
  assert.equal(child.args[child.args.indexOf('--parent-pid') + 1], String(process.pid));
  child.stdout.write(JSON.stringify({ state: 'update-error', error: 'Another Memo app is syncing' }) + '\n');
  child.exitCode = 1;
  child.emit('close', 1, null);
  await assert.rejects(update, /Another Memo app is syncing/);
});
