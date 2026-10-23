const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../electron/main/services/SettingsService.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function settings(platform, preference = null) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, process: { platform },
    require(name) {
      if (name === 'electron') return { app: {} };
      if (name === 'electron-store') return class Store {
        constructor() { this.values = { windowsSpeechModel: preference }; }
        get(key, fallback) { return this.values[key] ?? fallback; }
        set(key, value) { this.values[key] = value; }
      };
      if (name === './windowsRuntime') return { resolveWindowsSpeechModel: choice => choice === 'whisper-base.en-q5_1' ? choice : 'nemotron-streaming' };
      if (name === './StoreSchema') return { storeDefaults: {} };
      if (name === './phraseReplacement') return { clampPhraseReplacementRulesFromInput: rules => rules ?? [] };
      if (name.includes('recordingHotkey')) return { DEFAULT_RECORDING_HOTKEY: 'function', normalizeRecordingHotkey: value => value };
      return require(name);
    },
  });
  return module.exports;
}
test('fresh Windows uses Nemotron; explicit Base survives unrelated settings save', () => {
  assert.equal(settings('win32').loadSettings().asrModel, 'nemotron-streaming');
  const existing = settings('win32', 'whisper-base.en-q5_1');
  existing.saveSettings({ ...existing.loadSettings(), saveAudio: true });
  assert.equal(existing.loadSettings().asrModel, 'whisper-base.en-q5_1');
  assert.equal(existing.loadSettings().saveAudio, true);
});
test('Windows preference never changes Mac ASR or enables Windows cleanup', () => {
  assert.equal(settings('darwin', 'nemotron-streaming').loadSettings().asrModel, 'conomo');
  const windows = settings('win32');
  windows.store.set('writingMode', 'clean');
  assert.equal(windows.loadSettings().writingMode, 'as-spoken');
});
