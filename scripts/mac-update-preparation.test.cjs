const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['electron/main/services/MacUpdateInstaller.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron', './ModelAssets'], write: false }).outputFiles[0].text;
function fixture(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'Memo.app');
  fs.mkdirSync(target);
  const zip = path.join(root, 'update.zip');
  fs.writeFileSync(zip, 'fixture');
  const events = [];
  function execFile() { throw new Error('Expected promisified execution'); }
  execFile[promisify.custom] = async (command, args) => {
    events.push(path.basename(command));
    if (command.endsWith('/ditto')) {
      fs.mkdirSync(path.join(args[3], 'Memo.app', 'Contents', 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(args[3], 'Memo.app', 'Contents', 'MacOS', 'Memo'), 'fixture');
    }
    if (command.endsWith('/defaults')) return { stdout: '2.0.0\n', stderr: '' };
    if (command.endsWith('/codesign') && args[0] === '--verify' && failure === 'signature') throw new Error('Invalid signature');
    if (command.endsWith('/codesign') && args[0] === '--display') return { stdout: '', stderr: `TeamIdentifier=${failure === 'team' && args.at(-1).includes('extracted') ? 'OTHER' : 'MEMO'}\nIdentifier=com.memo.desktop\nCDHash=fixture\n` };
    return { stdout: '', stderr: '' };
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, process: { platform: 'darwin', execPath: '/Applications/Memo.app/Contents/MacOS/Memo', pid: process.pid, kill: process.kill }, require(name) {
    if (name === 'electron') return { app: { getPath: () => root, quit() { events.push('quit'); } } };
    if (name === './ModelAssets') return { prepareModelAssets: async () => {
      events.push('models');
      if (failure === 'models') throw new Error('Model download failed');
    } };
    if (name === 'node:child_process') return { execFile, spawn: () => { events.push('helper'); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } };
    return require(name);
  } });
  return { root, zip, events, installer: new module.exports.MacUpdateInstaller(target) };
}
test('preparation verifies signing before models and does not restart the app', async t => {
  const f = fixture(t);
  const update = await f.installer.prepare(f.zip, '2.0.0');
  assert.ok(f.events.indexOf('codesign') < f.events.indexOf('models'));
  assert.ok(f.events.indexOf('spctl') < f.events.indexOf('models'));
  assert.equal(f.events.includes('helper'), false);
  await update.install();
  assert.deepEqual(f.events.slice(-2), ['helper', 'quit']);
});
for (const failure of ['signature', 'team', 'models']) test(`failed ${failure} retains the installed app and removes staging`, async t => {
  const f = fixture(t, failure);
  await assert.rejects(f.installer.prepare(f.zip, '2.0.0'));
  assert.equal(f.events.includes('helper'), false);
  assert.equal(f.events.includes('quit'), false);
  if (failure !== 'models') assert.equal(f.events.includes('models'), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('prepared-update-')), false);
});
test('pruning keeps live preparations and rollback copies', async t => {
  const f = fixture(t);
  for (const [name, pid] of [['dead', 2147483647], ['live', process.pid], ['rollback', 2147483647]]) {
    const directory = path.join(f.root, `prepared-update-${name}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid }));
    if (name === 'rollback') fs.mkdirSync(path.join(directory, 'Previous Memo.app'));
  }
  await f.installer.prune();
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-update-dead')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-update-live')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'prepared-update-rollback')), true);
});
