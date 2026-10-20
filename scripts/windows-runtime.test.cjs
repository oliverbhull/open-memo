const test = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const compiled = transformSync(fs.readFileSync(path.join(__dirname,
  '../electron/main/services/windowsRuntime.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function runtime(packaged, exists = () => true, profile, environment = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    process: { resourcesPath: '/installed/resources', cwd: () => '/development', env: environment },
    require(name) {
      if (name === 'electron') return { app: { isPackaged: packaged } };
      if (name === 'node:fs') return {
        existsSync: file => file.endsWith('local-profile.json') ? profile !== undefined : exists(file),
        readFileSync: () => JSON.stringify(profile),
      };
      return require(name);
    },
  });
  return module.exports;
}
test('Windows chooses the bundled q5_1 model and disables segment transcription', () => {
  for (const packaged of [true, false]) {
    const api = runtime(packaged); const env = {};
    api.configureWindowsSpeech(env, 'whisper-small.en-q5_1');
    assert.equal(env.MEMO_ASR_BACKEND, 'whisper');
    assert.equal(env.STREAMING_TRANSCRIBE, '0');
    assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-small.en-q5_1.bin');
    assert.equal(path.basename(env.MEMO_WHISPER_WORKER), 'memo-whisper-worker.exe');
    assert.equal(path.basename(api.windowsDictationPath()), 'memo-dictation.exe');
    assert.ok(env.MEMO_WHISPER_MODEL.startsWith(path.normalize(packaged ? '/installed/resources' : '/development')));
  }
});
test('missing Windows resources fail before starting capture', () => {
  assert.throws(() => runtime(true, file => !file.endsWith('.bin')).configureWindowsSpeech({}), /resource is missing/);
  assert.throws(() => runtime(true, file => !file.endsWith('memo-whisper-worker.exe')).configureWindowsSpeech({}), /resource is missing/);
});

test('local profile selects base; explicit model override takes precedence and is validated', () => {
  const api = runtime(true, undefined, { model: 'base.en-q5_1' }); const env = {};
  api.configureWindowsSpeech(env, api.windowsWhisperModelId());
  assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-base.en-q5_1.bin');
  assert.equal(api.windowsWhisperModelId(), 'whisper-base.en-q5_1');
  const override = path.join('C:', 'models', 'ggml-small.en-q5_1.bin');
  const configured = { MEMO_WHISPER_MODEL: override };
  api.configureWindowsSpeech(configured, 'whisper-custom');
  assert.equal(configured.MEMO_WHISPER_MODEL, override);
  assert.throws(() => runtime(true, file => !file.endsWith('missing.bin')).configureWindowsSpeech({ MEMO_WHISPER_MODEL: 'missing.bin' }, 'whisper-custom'), /resource is missing/);
  assert.throws(() => runtime(true, undefined, { model: 'untrusted' }).configureWindowsSpeech({}, 'whisper-custom'), /Invalid Windows speech model/);
});
test('Windows installer excludes every Apple-only model and helper', () => {
  const config = require('../config/electron-builder.windows.cjs');
  assert.deepEqual(config.extraResources.map(r => r.to), ['app-icon.ico', 'dictation', 'whisper', 'nemotron', 'pnc']);
  assert.ok(config.extraResources.find(r => r.to === 'whisper').filter.includes('memo-whisper-worker.exe'));
  assert.equal(config.afterPack, null);
  assert.equal(config.nsis.perMachine, false);
});

test('Nemotron selection enables streaming and retains bundled Base fallback', () => {
  const api = runtime(true, () => true, { model: 'small.en-q5_1' });
  const env = {};
  api.configureWindowsSpeech(env, 'nemotron-streaming');
  assert.equal(env.MEMO_ASR_BACKEND, 'nemotron');
  assert.equal(env.STREAMING_TRANSCRIBE, '1');
  assert.equal(path.basename(env.MEMO_NEMOTRON_WORKER), 'memo-nemotron-worker.exe');
  assert.equal(path.basename(env.MEMO_NEMOTRON_MODEL), 'nemotron-en-q8.gguf');
  assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-base.en-q5_1.bin');
});

test('explicit Base selection overrides a local Small profile', () => {
  const env = {};
  runtime(true, () => true, { model: 'small.en-q5_1' }).configureWindowsSpeech(env, 'whisper-base.en-q5_1');
  assert.equal(env.MEMO_ASR_BACKEND, 'whisper');
  assert.equal(env.STREAMING_TRANSCRIBE, '0');
  assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-base.en-q5_1.bin');
});


test('fresh Windows defaults to Nemotron and retains explicit Base preference', () => {
  const api = runtime(true);
  for (const preference of [null, undefined, 'conomo', 'unknown']) {
    assert.equal(api.resolveWindowsSpeechModel(preference), 'nemotron-streaming');
  }
  assert.equal(api.resolveWindowsSpeechModel('whisper-base.en-q5_1'), 'whisper-base.en-q5_1');
  assert.equal(api.resolveWindowsSpeechModel('nemotron-streaming'), 'nemotron-streaming');
  const env = {};
  api.configureWindowsSpeech(env);
  assert.equal(env.MEMO_ASR_BACKEND, 'nemotron');
  assert.equal(path.basename(env.MEMO_WHISPER_MODEL), 'ggml-base.en-q5_1.bin');
});
