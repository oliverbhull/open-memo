const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path').posix;
const test = require('node:test');
const { promisify } = require('node:util');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const compiled = buildSync({
  entryPoints: ['electron/main/services/MacUpdateInstaller.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['electron'],
}).outputFiles[0].text;
const systemApp = '/Applications/Memo.app';
const personalApp = '/Users/test/Applications/Memo.app';
const translocatedApp = '/private/var/folders/ab/AppTranslocation/example/d/Memo.app';
const workRoot = '/Users/test/Library/Application Support/Memo/prepared-update-x';
const stagedApp = path.join(workRoot, 'extracted', 'Memo.app');
const updateZip = '/Users/test/Downloads/update.zip';

function installer({ running = translocatedApp, apps = {}, readOnly = [], spawnError } = {}) {
  const module = { exports: {} };
  const launches = [];
  let quits = 0;
  let extractions = 0;
  const fileSystem = {
    constants: { W_OK: 2, X_OK: 1 },
    existsSync: file => [updateZip, path.join(stagedApp, 'Contents', 'MacOS', 'Memo')].includes(file),
    promises: {
      realpath: async file => {
        if (file === running || apps[file]) return file;
        throw new Error('ENOENT');
      },
      access: async file => {
        if (readOnly.includes(file)) throw new Error('EROFS');
      },
      mkdtemp: async () => workRoot,
      mkdir: async () => {},
      writeFile: async () => {},
      open: async () => ({ fd: 3, close: async () => {} }),
    },
  };
  function execFile() {}
  execFile[promisify.custom] = async (command, args) => {
    if (command === '/usr/bin/ditto') extractions++;
    if (command === '/usr/bin/defaults') return { stdout: '2.0.0' };
    if (command === '/usr/bin/codesign' && args[0] === '--display') {
      const file = args.at(-1);
      const hash = file === running ? 'current' : file === stagedApp ? 'update' : apps[file];
      return { stdout: '', stderr: `Identifier=com.memo.desktop\nTeamIdentifier=TEAM\nCDHash=${hash}\n` };
    }
  };
  const app = {
    getPath: key => key === 'home' ? '/Users/test' : path.dirname(workRoot),
    quit: () => { quits++; },
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    process: { platform: 'darwin', pid: 42 },
    require: name => {
      if (name === 'electron') return { app };
      if (name === 'node:fs') return fileSystem;
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return {
        execFile,
        spawn: (_command, args) => {
          launches.push(args);
          const child = new EventEmitter();
          child.unref = () => {};
          queueMicrotask(() => spawnError ? child.emit('error', spawnError) : child.emit('spawn'));
          return child;
        },
      };
      return require(name);
    },
  });
  return {
    instance: new module.exports.MacUpdateInstaller(running),
    launches,
    get extractions() { return extractions; },
    get quits() { return quits; },
  };
}

test('translocated launch updates the single installed copy with a matching signature', async () => {
  const setup = installer({ apps: { [systemApp]: 'current', [personalApp]: 'other' } });
  const update = await setup.instance.prepare(updateZip, '2.0.0');
  await update.install();
  assert.equal(setup.launches[0][3], systemApp);
  assert.equal(setup.quits, 1);
});

test('missing or ambiguous installed copy leaves the running app open', async () => {
  for (const apps of [{ [personalApp]: 'other' }, { [systemApp]: 'current', [personalApp]: 'current' }]) {
    const setup = installer({ apps });
    await assert.rejects(setup.instance.prepare(updateZip, '2.0.0'), /installed copy of Memo/);
    assert.equal(setup.extractions, 0);
    assert.equal(setup.quits, 0);
  }
});

test('read-only disk image is detected before extracting the update', async () => {
  const running = '/Volumes/Memo/Memo.app';
  const setup = installer({ running, readOnly: [path.dirname(running)] });
  await assert.rejects(setup.instance.prepare(updateZip, '2.0.0'), /EROFS/);
  assert.equal(setup.extractions, 0);
  assert.equal(setup.quits, 0);
});

test('Memo stays open if the installer helper cannot start', async () => {
  const setup = installer({ running: systemApp, spawnError: new Error('spawn failed') });
  const update = await setup.instance.prepare(updateZip, '2.0.0');
  await assert.rejects(update.install(), /spawn failed/);
  assert.equal(setup.quits, 0);
});
