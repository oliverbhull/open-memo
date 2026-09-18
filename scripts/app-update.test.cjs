const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const compiled = buildSync({ entryPoints: ['electron/main/services/AppUpdateService.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'electron-updater', '../utils/logger'] }).outputFiles[0].text;
function service(beforeInstall) {
  const updater = new EventEmitter();
  updater.quitAndInstall = () => {};
  const messages = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, setTimeout, setInterval, clearTimeout, clearInterval, require: name => {
    if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '1.0.0' }, dialog: { showMessageBox: async options => { messages.push(options); return { response: 0 }; } } };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === '../utils/logger') return { logger: { info() {}, warn() {} } };
    throw new Error(name);
  } });
  return { instance: new module.exports.AppUpdateService(() => null, beforeInstall), updater, messages };
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
  const { instance, updater } = service(() => new Promise(resolve => { finish = resolve; }));
  let installed = false;
  updater.quitAndInstall = () => { installed = true; };
  const prompt = instance.promptToRestart('2.0.0');
  await new Promise(setImmediate);
  assert.equal(installed, false);
  finish();
  await prompt;
  assert.equal(installed, true);
});
test('failed worker shutdown does not initiate install and reports recovery', async () => {
  const { instance, updater, messages } = service(async () => { throw new Error('shutdown failed'); });
  let installed = false;
  updater.quitAndInstall = () => { installed = true; };
  await instance.promptToRestart('2.0.0');
  assert.equal(installed, false);
  assert.equal(messages[1].message, 'Memo could not restart to install the update.');
  assert.equal(instance.updatePromptOpen, false);
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
