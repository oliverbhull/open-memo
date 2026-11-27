const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');

const settingsBundle = buildSync({
  entryPoints: ['electron/main/services/SettingsService.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron', 'electron-store'],
}).outputFiles[0].text;
const trayCode = transformSync(fs.readFileSync('electron/main/services/TrayService.ts', 'utf8'), {
  loader: 'ts', format: 'cjs',
}).code;

async function harness({ platform = 'darwin', groq = false } = {}) {
  const settingsModule = { exports: {} };
  vm.runInNewContext(settingsBundle, {
    module: settingsModule, exports: settingsModule.exports, process: { platform },
    require(name) {
      if (name === 'electron') return { app: {} };
      if (name === 'electron-store') return class {
        constructor({ defaults }) { this.values = { ...defaults }; }
        get(key, fallback) { return this.values[key] ?? fallback; }
        set(key, value) { this.values[key] = value; }
      };
      return require(name);
    },
  });
  const settings = settingsModule.exports;
  const events = [];
  const errors = [];
  let menu;
  let rebuilds = 0;
  let restarts = 0;
  let restart = async () => {};
  const image = { isEmpty: () => false, addRepresentation() {}, setTemplateImage() {} };
  const module = { exports: {} };
  vm.runInNewContext(trayCode, {
    module, exports: module.exports, process: { platform }, console, setTimeout,
    require(name) {
      if (name === 'electron') return {
        app: { getAppPath: () => '/unused' },
        nativeImage: { createFromPath: () => image },
        Tray: class {
          setToolTip() {} setImage() {}
          setContextMenu(next) { menu = next; rebuilds++; }
        },
        Menu: { buildFromTemplate(items) { return Object.assign(new EventEmitter(), { items }); } },
        dialog: { showErrorBox: (...args) => errors.push(args) },
      };
      if (name.includes('SettingsService')) return settings;
      if (name.includes('GroqService')) return { isGroqCleanupEnabled: () => groq };
      if (name.includes('recordingHotkey')) return { recordingHotkeyLabel: () => 'Fn' };
      if (name.includes('AudioInputService')) return { audioInputService: {
        getDevices: () => [], getDefaultDevice: () => null, refresh: async () => [],
      } };
      return require(name);
    },
  });
  const api = module.exports;
  api.setMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } });
  api.setMemoSttService({ restart: async () => { restarts++; await restart(); } });
  api.createTray();
  await api.refreshAudioInputDevices();
  return {
    api, settings, events, errors,
    menu: () => menu,
    rebuilds: () => rebuilds,
    restarts: () => restarts,
    setRestart: callback => { restart = callback; },
    item: label => [...menu.items, ...menu.items.find(item => item.label === 'Options').submenu]
      .find(item => item.label?.startsWith(label)),
  };
}

test('Options submenu contains the four persisted checkboxes, with email dependent on Groq and platform', async () => {
  const h = await harness();
  assert.equal(h.menu().items.filter(item => item.label === 'Options').length, 1);
  assert.equal(h.menu().items.some(item => item.type === 'checkbox'), false);
  assert.equal(h.item('Options').submenu.length, 4);
  for (const label of ['Hands free', 'Send immediately', 'Say “ENTER” to submit', 'Email formatting']) {
    assert.equal(h.item(label).type, 'checkbox');
    assert.equal(h.item(label).checked, false);
  }
  assert.equal(h.item('Email formatting').enabled, false);
  assert.match(h.item('Email formatting').label, /requires Groq cleanup/);
  assert.equal((await harness({ groq: true })).item('Email formatting').enabled, true);
  assert.equal((await harness({ platform: 'win32' })).item('Email formatting'), undefined);
});

test('tray clicks persist and notify Settings; API changes refresh tray checks', async () => {
  const h = await harness({ groq: true });
  h.item('Send immediately').click({ checked: true });
  assert.equal(h.settings.loadSettings().sendImmediately, true);
  assert.equal(h.item('Send immediately').checked, true);
  for (const key of ['sayEnterToPressEnter', 'experimentalEmailFormatting', 'handsFreeMode']) {
    await h.api.setDictationSetting(key, true);
  }
  assert.equal(h.restarts(), 1);
  const event = h.events.filter(([channel]) => channel === 'settings:dictation-changed').at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(event[1])), {
    handsFreeMode: true, sendImmediately: true, sayEnterToPressEnter: true, experimentalEmailFormatting: true,
  });
  assert.equal(h.item('Speak to dictate').enabled, false);
  await h.api.setDictationSetting('handsFreeMode', true);
  assert.equal(h.restarts(), 1);
  await assert.rejects(h.api.setDictationSetting('sendImmediately', 'true'), /boolean/);
});

test('changing hands free cannot interrupt dictation, and failed restart restores its setting', async () => {
  const h = await harness();
  for (const state of ['setRecordingState', 'setProcessingState']) {
    h.api[state](true);
    assert.equal(h.item('Hands free').enabled, false);
    await assert.rejects(h.api.setDictationSetting('handsFreeMode', true), /Finish your dictation/);
    h.api[state](false);
  }
  assert.equal(h.restarts(), 0);
  h.setRestart(async () => {
    if (h.restarts() === 1) throw new Error('Recorder unavailable');
  });
  await assert.rejects(h.api.setDictationSetting('handsFreeMode', true), /Recorder unavailable/);
  assert.equal(h.settings.loadSettings().handsFreeMode, false);
  assert.equal(h.item('Hands free').checked, false);
  assert.equal(h.restarts(), 2);
  assert.equal(h.events.at(-1)[1].handsFreeMode, false);
});

test('menu rebuild waits for close, and concurrent hands-free changes cannot race a restart', async () => {
  const h = await harness();
  const menu = h.menu();
  const count = h.rebuilds();
  menu.emit('menu-will-show');
  let finishRestart;
  h.setRestart(() => new Promise(resolve => { finishRestart = resolve; }));
  const change = h.api.setDictationSetting('handsFreeMode', true);
  await assert.rejects(h.api.setDictationSetting('handsFreeMode', false), /finish changing/);
  await h.api.setDictationSetting('sendImmediately', true);
  finishRestart();
  await change;
  assert.equal(h.rebuilds(), count);
  menu.emit('menu-will-close');
  await delay(70);
  assert.equal(h.item('Hands free').checked, true);
  assert.equal(h.item('Send immediately').checked, true);
  assert.ok(h.rebuilds() > count);
});
