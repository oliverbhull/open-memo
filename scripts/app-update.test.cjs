const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const compiled = buildSync({ entryPoints: ['electron/main/services/AppUpdateService.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'electron-updater', '../utils/logger', './MacUpdateInstaller'] }).outputFiles[0].text;
function service(beforeInstall, installer, dialogResponse = 0) {
  const updater = new EventEmitter();
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads++; return []; };
  const installs = [];
  const updateInstaller = installer || {
    prepare: async (file, version) => ({ install: () => installs.push({ file, version }) }),
  };
  const messages = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, setTimeout, setInterval, clearTimeout, clearInterval, require: name => {
    if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '1.0.0' }, dialog: { showMessageBox: async options => { messages.push(options); return { response: dialogResponse }; } } };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === '../utils/logger') return { logger: { info() {}, warn() {} } };
    if (name === './MacUpdateInstaller') return { MacUpdateInstaller: class {} };
    if (name.startsWith('node:')) return require(name);
    throw new Error(name);
  } });
  return {
    instance: new module.exports.AppUpdateService(() => null, beforeInstall, updateInstaller),
    updater,
    messages,
    installs,
    get downloads() { return downloads; },
  };
}
test('manual check observes download rejection and allows retry', async () => {
  const { instance, updater, messages } = service();
  updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error('offline')) });
  await instance.checkManually();
  assert.equal(messages[0].message, 'Memo could not download the update.');
  updater.checkForUpdates = async () => { updater.emit('update-not-available', { version: '1.0.0' }); return null; };
  await instance.checkManually();
  assert.equal(messages[1].message, 'Memo is up to date.');
});
test('automatic download errors are caught without a dialog', async () => {
  const { instance, updater, messages } = service();
  updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error('offline')) });
  await instance.check(false);
  assert.equal(messages.length, 0);
});
test('restart waits for worker shutdown', async () => {
  let finish;
  const { instance, installs } = service(() => new Promise(resolve => { finish = resolve; }));
  instance.downloadedUpdate = { version: '2.0.0', file: '/tmp/update.zip' };
  const prompt = instance.promptToRestart('2.0.0');
  await new Promise(setImmediate);
  assert.equal(installs.length, 0);
  finish();
  await prompt;
  assert.deepEqual(installs, [{ file: '/tmp/update.zip', version: '2.0.0' }]);
});
test('failed worker shutdown does not initiate install and reports recovery', async () => {
  let discarded = false;
  const { instance, messages, installs } = service(
    async () => { throw new Error('shutdown failed'); },
    { prepare: async () => ({ install: () => installs.push('installed'), discard: async () => { discarded = true; } }) },
  );
  instance.downloadedUpdate = { version: '2.0.0', file: '/tmp/update.zip' };
  await instance.promptToRestart('2.0.0');
  assert.equal(installs.length, 0);
  assert.equal(discarded, true);
  assert.equal(messages[1].message, 'Memo could not restart to install the update.');
  assert.equal(instance.updatePromptOpen, false);
});
test('large macOS updates bypass Squirrel installation', async () => {
  const { instance, updater, installs } = service();
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.disableDifferentialDownload, true);
  updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/large-update.zip' });
  await new Promise(setImmediate);
  assert.deepEqual(installs, [{ file: '/tmp/large-update.zip', version: '2.0.0' }]);
});
test('declining an update does not download it in the background', async () => {
  const setup = service(undefined, undefined, 1);
  setup.updater.emit('update-available', { version: '2.0.0', files: [{ url: 'Memo.zip', size: 1_350_000_000 }] });
  await new Promise(setImmediate);
  assert.equal(setup.downloads, 0);
  assert.match(setup.messages[0].detail, /1\.4 GB/);
  setup.updater.emit('update-available', { version: '2.0.0', files: [{ url: 'Memo.zip', size: 1_350_000_000 }] });
  await new Promise(setImmediate);
  assert.equal(setup.messages.length, 1);
});
test('accepting an update starts one download', async () => {
  const setup = service();
  setup.updater.emit('update-available', { version: '2.0.0', files: [{ url: 'Memo.zip', size: 1_350_000_000 }] });
  await new Promise(setImmediate);
  assert.equal(setup.downloads, 1);
});
test('one check remains active through download completion', async () => {
  const { instance, updater } = service();
  let finish;
  let calls = 0;
  updater.checkForUpdates = async () => {
    calls++;
    return { downloadPromise: new Promise(resolve => { finish = resolve; }) };
  };
  const check = instance.checkManually();
  await new Promise(setImmediate);
  await instance.checkManually();
  assert.equal(calls, 1);
  finish([]);
  await check;
});
