const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../electron/main/services/PunctuationService.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function fixture(exists = true) {
  const workers = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, setTimeout, clearTimeout,
    process: { platform: 'win32', env: {}, resourcesPath: 'C:/Memo/resources', cwd: () => 'C:/dev' },
    require(name) {
      if (name === 'electron') return { app: { isPackaged: true } };
      if (name === './ModelPackService') return { resolveModelPackPath() { throw new Error('Mac path used'); } };
      if (name === '../utils/logger') return { logger: { debug() {}, warn() {}, info() {} } };
      if (name === 'node:fs') return { existsSync: () => exists };
      if (name === 'node:child_process') return { spawn(command, args, options) {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.kill = () => { child.killed = true; return true; };
        Object.assign(child, { command, args, options }); workers.push(child); return child;
      } };
      return require(name);
    },
  });
  return { service: new module.exports.PunctuationService(), workers };
}
test('Windows launches persistent hidden edge worker and preserves formatted Whisper output', async () => {
  const { service, workers } = fixture();
  try {
    service.start(); service.start();
    assert.equal(workers.length, 1);
    const worker = workers[0];
    assert.equal(worker.command, path.join('C:/Memo/resources', 'pnc', 'python', 'python.exe'));
    assert.equal(worker.options.windowsHide, true);
    assert.ok(worker.args.includes(path.join('C:/Memo/resources', 'pnc', 'model.int8.onnx')));
    assert.equal(await service.format('hello there'), 'hello there');
    worker.stdout.write('READY\n');
    assert.equal(await service.format('Hello there.'), 'Hello there.');
    assert.equal(worker.stdin.read(), null);
    const pending = service.format('hello there');
    const request = JSON.parse(worker.stdin.read().toString());
    worker.stdout.write(JSON.stringify({ id: request.id, text: 'Hello there.' }) + '\n');
    assert.equal(await pending, 'Hello there.');
  } finally { service.stop(); }
});
test('missing Windows resources and rejected worker output retain original words', async () => {
  const missing = fixture(false); missing.service.start();
  assert.equal(missing.workers.length, 0);
  assert.equal(await missing.service.format('keep every word'), 'keep every word');
  const { service, workers } = fixture();
  try {
    service.start(); workers[0].stdout.write('READY\n');
    const pending = service.format('keep every word');
    const request = JSON.parse(workers[0].stdin.read().toString());
    workers[0].stdout.write(JSON.stringify({ id: request.id, text: 'Changed words.', error: 'word_sequence_changed' }) + '\n');
    assert.equal(await pending, 'keep every word');
    const interrupted = service.format('pending words');
    service.stop();
    assert.equal(await interrupted, 'pending words');
  } finally { service.stop(); }
});
