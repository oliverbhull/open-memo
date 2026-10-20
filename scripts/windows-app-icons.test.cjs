const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const entry = path.resolve('electron/main/services/ApplicationIconService.ts');
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, define: { 'process.platform': '"win32"' }, external: ['electron', '../utils/logger'] }).outputFiles[0].text;
function load(fixture) {
  const calls = [], artwork = [], loaded = new Module(entry, module), original = Module._load;
  Module._load = (name, ...args) => {
    if (name === 'electron') return { app: { getFileIcon: async file => { calls.push(file); return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,icon' }; } }, nativeImage: { createFromPath: file => { artwork.push(file); return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,package' }; } } };
    if (name === 'node:fs') return { existsSync: file => fixture ? Object.hasOwn(fixture, file) : !file.includes('missing'), statSync: () => ({ size: 1000 }), readFileSync: file => fixture[file] };
    if (name === '../utils/logger') return { logger: { warn() {}, debug() {} } };
    return original(name, ...args);
  };
  try { loaded._compile(code, entry); } finally { Module._load = original; }
  return { service: new loaded.exports.ApplicationIconService(), calls, artwork };
}
test('Windows loads and caches actual executable icons without shell commands', async () => {
  const { service, calls } = load();
  const exe = 'C:\\Apps\\東京\\Editor.exe';
  for (let i = 0; i < 2; i++) assert.equal(await service.getIconDataUrl('Editor', undefined, undefined, exe), 'data:image/png;base64,icon');
  assert.deepEqual(calls, [exe]);
  assert.equal(service.enrichContext({ appName: 'Editor', windowTitle: 'Notes', appPath: exe }).appPath, exe);
  assert.equal(await service.getIconDataUrl('Editor'), 'data:image/png;base64,icon');
  assert.equal(calls.length, 1);
});
test('Windows rejects network paths, nonexecutables, and missing files gracefully', async () => {
  const { service, calls } = load();
  for (const file of ['\\\\server\\share\\Editor.exe', 'relative.exe', 'C:\\Apps\\document.txt', 'C:\\missing.exe']) {
    assert.equal(await service.getIconDataUrl('Editor', undefined, undefined, file), null);
  }
  assert.equal(calls.length, 0);
});
test('Store apps use artwork for the exact executable rather than a generic shell icon', async () => {
  const root = 'C:\\Program Files\\WindowsApps\\Example_1';
  const exe = root + '\\app\\Editor.exe';
  const asset = root + '\\assets\\Editor.targetsize-64_altform-unplated.png';
  const fixture = { [exe]: '', [asset]: '', [root + '\\AppxManifest.xml']: '<Applications><Application Executable="other.exe"><uap:VisualElements Square44x44Logo="assets/Wrong.png" /></Application><Application Executable="app/Editor.exe"><uap:VisualElements Square44x44Logo="assets/Editor.png" /></Application></Applications>' };
  const { service, calls, artwork } = load(fixture);
  assert.equal(await service.getIconDataUrl('Editor', undefined, undefined, exe), 'data:image/png;base64,package');
  assert.deepEqual(artwork, [asset]);
  assert.deepEqual(calls, []);
});
