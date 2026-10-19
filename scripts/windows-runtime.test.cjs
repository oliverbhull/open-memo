const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const path = require('node:path');
const compiled = buildSync({ entryPoints: ['electron/main/services/windowsRuntime.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text;
function runtime(packaged, exists = () => true) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    process: { resourcesPath: '/installed/resources', cwd: () => '/development' },
    require(name) {
      if (name === 'electron') return { app: { isPackaged: packaged } };
      if (name === 'node:fs') return { existsSync: exists };
      return require(name);
    },
  });
  return module.exports;
}
test('Windows chooses the bundled q5_1 model and disables segment transcription', () => {
  for (const packaged of [true, false]) {
    const api = runtime(packaged); const env = {};
    api.configureWindowsSpeech(env);
    assert.equal(env.MEMO_ASR_BACKEND, 'whisper');
    assert.equal(env.STREAMING_TRANSCRIBE, '0');
    assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-small.en-q5_1.bin');
    assert.equal(path.basename(env.MEMO_WHISPER_CLI), 'whisper-cli.exe');
    assert.equal(path.basename(api.windowsDictationPath()), 'memo-dictation.exe');
    assert.ok(env.MEMO_WHISPER_MODEL.startsWith(packaged ? '/installed/resources' : '/development'));
  }
});
test('missing Windows resources fail before starting capture', () => {
  assert.throws(() => runtime(true, file => !file.endsWith('.bin')).configureWindowsSpeech({}), /resource is missing/);
});
test('Windows installer excludes every Apple-only model and helper', () => {
  const config = require('../config/electron-builder.windows.cjs');
  assert.deepEqual(config.extraResources.map(r => r.to), ['dictation', 'whisper']);
  assert.equal(config.afterPack, null);
  assert.equal(config.nsis.perMachine, false);
});
