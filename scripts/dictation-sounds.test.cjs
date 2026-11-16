const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const compile = relative => transformSync(read(relative), { loader: 'ts', format: 'cjs' }).code;
const SAMPLE_RATE = 44_100;

function loadService(settings) {
  const created = [];
  class WebContentsView {
    constructor() {
      this.webContents = {
        scripts: [],
        destroyed: false,
        crashed: false,
        isDestroyed() { return this.destroyed; },
        isCrashed() { return this.crashed; },
        close() { this.destroyed = true; },
        loadURL: async () => {},
        async executeJavaScript(script) { this.scripts.push(script); },
      };
      created.push(this.webContents);
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(compile('electron/main/services/DictationSoundService.ts'), {
    module, exports: module.exports, Buffer,
    require(name) {
      if (name === 'electron') return { WebContentsView };
      if (name === './SettingsService') return { loadSettings: () => settings };
      if (name === '../utils/logger') return { logger: { warn() {} } };
      return require(name);
    },
  });
  return { service: module.exports, created };
}

const playScripts = contents => contents.scripts.filter(script => script.includes('.play()'));

function pcm(sound) {
  const wav = loadService({}).service.dictationSoundWav(sound);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16, '16-bit');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  return Array.from({ length: (wav.length - 44) / 2 }, (_, index) => wav.readInt16LE(44 + index * 2));
}

function frequency(samples) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1] < 0 && samples[index] >= 0) crossings += 1;
  }
  return crossings / (samples.length / SAMPLE_RATE);
}

test('sounds are short, quiet and free of clicks at either end', () => {
  for (const sound of ['start', 'stop']) {
    const samples = pcm(sound);
    const duration = samples.length / SAMPLE_RATE;
    const peak = Math.max(...samples.map(Math.abs)) / 32_768;
    assert.ok(duration > 0.15 && duration < 0.3, `${sound} lasts ${duration}s`);
    assert.ok(20 * Math.log10(peak) < -15, `${sound} peaks at ${peak}`);
    assert.ok(Math.abs(samples[0]) < 100, `${sound} starts at ${samples[0]}`);
    assert.ok(Math.abs(samples[samples.length - 1]) < 100, `${sound} ends at ${samples[samples.length - 1]}`);
  }
});

test('the start sound rises and the stop sound falls', () => {
  const secondNote = Math.round(0.08 * SAMPLE_RATE);
  const [startFirst, startSecond] = [pcm('start').slice(0, secondNote), pcm('start').slice(secondNote)];
  const [stopFirst, stopSecond] = [pcm('stop').slice(0, secondNote), pcm('stop').slice(secondNote)];
  assert.ok(frequency(startSecond) > frequency(startFirst));
  assert.ok(frequency(stopSecond) < frequency(stopFirst));
});

test('sounds play when enabled and reuse one prepared player', () => {
  const { service, created } = loadService({ dictationSounds: true, handsFreeMode: false });
  service.prepareDictationSounds();
  service.playDictationSound('start');
  service.playDictationSound('stop');
  assert.equal(created.length, 1);
  assert.deepEqual(playScripts(created[0]).map(script => script.match(/sounds\.(\w+)\.play/)[1]), ['start', 'stop']);
});

test('the setting and Hands free both silence sounds and skip the player', () => {
  for (const settings of [
    { dictationSounds: false, handsFreeMode: false },
    { dictationSounds: true, handsFreeMode: true },
  ]) {
    const { service, created } = loadService(settings);
    service.prepareDictationSounds();
    service.playDictationSound('start');
    assert.equal(created.length, 0);
  }
});

test('a crashed player is replaced on the next sound', () => {
  const { service, created } = loadService({ dictationSounds: true, handsFreeMode: false });
  service.playDictationSound('start');
  created[0].crashed = true;
  service.playDictationSound('stop');
  assert.equal(created.length, 2);
  assert.equal(created[0].destroyed, true);
  assert.equal(playScripts(created[1]).length, 1);
});

test('sounds default to on and turning them off survives other settings saves', () => {
  const module = { exports: {} };
  vm.runInNewContext(compile('electron/main/services/SettingsService.ts'), {
    module, exports: module.exports, process: { platform: 'darwin' },
    require(name) {
      if (name === 'electron') return { app: {} };
      if (name === 'electron-store') return class Store {
        constructor() { this.values = {}; }
        get(key, fallback) { return this.values[key] ?? fallback; }
        set(key, value) { this.values[key] = value; }
      };
      if (name === './windowsRuntime') return { resolveWindowsSpeechModel: choice => choice };
      if (name === './StoreSchema') return { storeDefaults: {} };
      if (name === './phraseReplacement') return { clampPhraseReplacementRulesFromInput: rules => rules ?? [] };
      if (name.includes('recordingHotkey')) return { DEFAULT_RECORDING_HOTKEY: 'function', normalizeRecordingHotkey: value => value };
      return require(name);
    },
  });
  const { loadSettings, saveSettings } = module.exports;
  assert.equal(loadSettings().dictationSounds, true);
  saveSettings({ ...loadSettings(), dictationSounds: false });
  saveSettings({ ...loadSettings(), saveAudio: true });
  assert.equal(loadSettings().dictationSounds, false);
  saveSettings({ ...loadSettings(), dictationSounds: true });
  assert.equal(loadSettings().dictationSounds, true);
});

test('recording transitions play the sounds, and abnormal endings do not', () => {
  const main = read('electron/main/index.ts');
  assert.match(main, /on\('recordingStarted'[\s\S]{0,300}playDictationSound\('start'\)/);
  assert.match(main, /on\('recordingStopped'[\s\S]{0,300}playDictationSound\('stop'\)/);
  assert.equal(main.match(/playDictationSound\(/g).length, 2);
});
