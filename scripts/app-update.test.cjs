const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const compiled = buildSync({ entryPoints: ['electron/main/services/AppUpdateService.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'electron-updater', '../utils/logger', './MacUpdateInstaller'] }).outputFiles[0].text;
function service(beforeInstall, installer, dialogResponse = 0, platform = 'darwin', argv = []) {
  const updater = new EventEmitter();
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads++; return []; };
  const installs = [];
  const updateInstaller = installer || {
    prepare: async (file, version) => ({ install: () => installs.push({ file, version }) }),
  };
  const messages = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, { process: { platform, argv }, module, exports: module.exports, setInterval, clearInterval, require: name => {
    if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '1.0.0' }, dialog: { showMessageBox: async options => { messages.push(options); return { response: dialogResponse }; } } };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === '../utils/logger') return { logger: { info() {}, warn() {} } };
    if (name === './MacUpdateInstaller') return { MacUpdateInstaller: class {} };
    if (name === 'node:os') return { homedir: () => '/nonexistent-memo-test-home' };
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
test('starting Memo checks automatically and begins downloading without a dialog', async (t) => {
  const { instance, updater, messages } = service();
  t.after(() => instance.stop());
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '2.0.0', files: [] });
    return null;
  };
  instance.start();
  await instance.cacheMaintenance;
  assert.equal(instance.getStatus().state, 'downloading');
  assert.equal(updater.autoDownload, true);
  assert.equal(messages.length, 0);
});
test('relaunch from a failed installation explains why the old version is open', async (t) => {
  const { instance, updater, messages } = service(undefined, undefined, 0, 'darwin', ['--memo-update-failed']);
  t.after(() => instance.stop());
  updater.checkForUpdates = async () => null;
  instance.start();
  assert.match(messages[0].message, /reopened the previous version/);
  await instance.cacheMaintenance;
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
  const { instance, updater, installs, messages } = service();
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.channel, 'app');
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableDifferentialDownload, true);
  updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/large-update.zip' });
  await new Promise(setImmediate);
  assert.equal(messages.length, 0);
  assert.equal(installs.length, 0);
  await instance.openUpdate();
  assert.deepEqual(installs, [{ file: '/tmp/large-update.zip', version: '2.0.0' }]);
});
test('automatic checks download and prepare updates without a dialog', async () => {
  let prepared = 0;
  let finish;
  const setup = service(undefined, { prepare: async () => {
    prepared++;
    await new Promise(resolve => { finish = resolve; });
    return { install() {} };
  } });
  setup.updater.checkForUpdates = async () => {
    setup.updater.emit('update-available', { version: '2.0.0', files: [] });
    return { downloadPromise: (async () => {
      setup.updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/update.zip' });
      return [];
    })() };
  };
  const check = setup.instance.check(false);
  await new Promise(setImmediate);
  assert.equal(setup.instance.getStatus().state, 'downloading');
  assert.equal(prepared, 1);
  assert.equal(setup.messages.length, 0);
  finish();
  await check;
  assert.equal(setup.instance.getStatus().state, 'downloaded');
  assert.equal(setup.installs.length, 0);
  assert.equal(setup.messages.length, 0);
});
test('background preparation failures leave a retry and do not interrupt the user', async () => {
  const setup = service(undefined, { prepare: async () => { throw new Error('model offline'); } });
  setup.updater.checkForUpdates = async () => {
    setup.updater.emit('update-available', { version: '2.0.0', files: [] });
    setup.updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/update.zip' });
    return { downloadPromise: Promise.resolve([]) };
  };
  await setup.instance.check(false);
  assert.equal(setup.instance.getStatus().state, 'available');
  assert.equal(setup.messages.length, 0);
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
test('failed automatic download can retry from the header without a download prompt', async () => {
  const { instance, updater, messages } = service();
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '2.0.0', files: [] });
    return { downloadPromise: Promise.reject(new Error('offline')) };
  };
  await instance.check(false);
  assert.equal(instance.getStatus().state, 'available');
  assert.equal(messages.length, 0);
  updater.downloadUpdate = async () => {
    updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/update.zip' });
    return [];
  };
  await instance.openUpdate();
  assert.equal(instance.getStatus().state, 'downloaded');
  assert.equal(messages.length, 0);
});
test('restart reuses the prepared app and Later keeps it ready', async () => {
  let preparations = 0;
  let installs = 0;
  const setup = service(undefined, { prepare: async () => { preparations++; return { install() { installs++; } }; } }, 1);
  setup.updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/update.zip' });
  await new Promise(setImmediate);
  await setup.instance.openUpdate();
  assert.equal(setup.instance.getStatus().state, 'downloaded');
  assert.equal(preparations, 1);
  assert.equal(installs, 0);
});

 test('Windows never starts the Mac updater and explains manual downloads', async () => {
  const { instance, updater, messages, installs } = service(undefined, undefined, 0, 'win32');
  updater.checkForUpdates = () => { throw new Error('Windows updater must stay disabled'); };
  instance.start();
  await instance.checkManually();
  assert.equal(messages.length, 1);
  assert.match(messages[0].detail, /Download for Windows/);
  assert.deepEqual(installs, []);
});
