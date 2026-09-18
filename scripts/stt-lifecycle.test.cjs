const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const { transformSync } = require('esbuild');
const compiled = transformSync(fs.readFileSync('electron/main/services/MemoSttService.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function harness() {
  const children = [];
  const module = { exports: {} };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const spawn = () => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, killed: false });
    child.stdin = new EventEmitter(); child.stdin.write = () => true;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true;
    children.push(child); return child;
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, process,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 500 ? 0 : ms), clearTimeout,
    require: name => {
      if (name === 'child_process') return { spawn, spawnSync: () => ({ status: 0 }) };
      if (name === 'fs') return { existsSync: () => true };
      if (name === 'electron') return { app: { isPackaged: false } };
      if (name === '../utils/logger') return { logger };
      if (name === './SettingsService') return { loadSettings: () => ({ vocabWords: [] }), store: { get() {} } };
      if (name === './AsrModelService') return { isWhisperModelInstalled: () => false };
      if (name === './ModelPackService') return { resolveModelPackPath: () => '/test-conomo' };
      if (name.includes('transcription') || name.includes('textProcessing')) return {};
      return require(name);
    } });
  const service = new module.exports.MemoSttService();
  service.on('error', () => {});
  const lines = [];
  service.processLine = async line => { lines.push(line); };
  return { service, children, lines };
}
test('stop drains split output after exit and restart waits for stream close', async () => {
  const { service, children, lines } = harness();
  await service.start();
  const first = children[0];
  first.stdout.emit('data', Buffer.from('completed '));
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  const restart = service.start();
  first.exitCode = 0; first.emit('exit', 0, null);
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  assert.equal(children.length, 1);
  first.stdout.emit('data', Buffer.from('dictation\npartial'));
  assert.deepEqual(lines, ['completed dictation']);
  first.emit('close', 0, null);
  await stop; await restart;
  assert.equal(children.length, 2);
  assert.equal(service.buffer, '');
  first.stdin.emit('close');
  first.stdout.emit('data', Buffer.from('stale\n'));
  first.stderr.emit('data', Buffer.from('Error: Audio too short'));
  assert.equal(service.stdinClosed, false);
  assert.deepEqual(lines, ['completed dictation']);
  const finalStop = service.stop(); children[1].emit('close', 0, null); await finalStop;
});
test('failed spawn settles stop on close even without an exit event', async () => {
  const { service, children } = harness();
  await service.start();
  const child = children[0];
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  const stop = service.stop();
  child.emit('close', -2, null);
  await stop;
  await service.stop();
  assert.equal(service.process, null);
});
test('already closed child does not leave a pending stop', async () => {
  const { service, children } = harness();
  await service.start();
  children[0].emit('close', 0, null);
  await service.stop();
  assert.equal(service.process, null);
});
