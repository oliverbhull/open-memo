const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const sharedModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync('electron/shared/recordingHotkey.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: sharedModule, exports: sharedModule.exports });
const { RECORDING_KEYS, DEFAULT_RECORDING_HOTKEY, normalizeRecordingHotkey, recordingHotkeyLabel, recordingLockModifier } = sharedModule.exports;

function harness({ recording = false, processing = false, status = 'running', fail = false } = {}) {
  const calls = [];
  let saved = 'function';
  let savedLock = 'function+controlleft';
  let restarts = 0;
  let handler;
  const source = fs.readFileSync('electron/main/index.ts', 'utf8');
  const begin = source.indexOf("async function changeRecordingShortcut(");
  const end = source.indexOf("ipcMain.handle('settings:setRecordingHotkey'", begin);
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    normalizeRecordingHotkey, DEFAULT_RECORDING_HOTKEY,
    changingRecordingHotkey: false, isRecording: recording, isDictationProcessing: processing,
    loadUserSettings: () => ({ hotkey: saved, lockHotkey: savedLock }),
    saveUserSettings: ({ hotkey, lockHotkey }) => { calls.push('save:' + hotkey); saved = hotkey; savedLock = lockHotkey; },
    updateMenuState: () => calls.push('menu'),
    logger: { error() {} },
    memoSttService: {
      updateHotkeys: async (recording, lock) => {
        calls.push('keys:' + recording + '|' + lock);
        if (fail && recording !== 'function') throw new Error('listener failed');
      },
    },
  };
  vm.runInNewContext(transformSync(source.slice(begin, end), { loader: 'ts', format: 'cjs' }).code + '\nhandler = changeRecordingShortcut;', Object.assign(context, { handler: null }));
  handler = context.handler;
  return { change: (key, kind = 'hotkey') => handler(key, kind), calls, context, saved: () => saved, restarts: () => restarts };
}

test('shortcut options match native keys and legacy aliases stay compatible', () => {
  const parser = fs.readFileSync('sidecars/dictation/src/recording_hotkey.rs', 'utf8');
  for (const { value } of RECORDING_KEYS) {
    assert.ok(parser.includes('"' + value + '"'), value);
    assert.equal(normalizeRecordingHotkey(value), value);
  }
  assert.equal(normalizeRecordingHotkey(' FN '), 'function');
  assert.equal(normalizeRecordingHotkey('CMD'), 'metaleft');
  assert.equal(normalizeRecordingHotkey('altright'), 'altright');
  assert.equal(normalizeRecordingHotkey('cmd + shift + space'), 'shiftleft+metaleft+space');
  for (const raw of [null, {}, 1, '', 'constructor', '__proto__', 'a+b', 'f13']) {
    assert.equal(normalizeRecordingHotkey(raw), null);
  }
  assert.equal(recordingHotkeyLabel(null), 'Fn');
  assert.equal(recordingHotkeyLabel('metaright'), 'Right Command');
  assert.equal(recordingLockModifier('controlleft'), 'Right Control');
  assert.equal(recordingLockModifier('controlright'), 'Left Control');
});

test('changing a shortcut applies it before persisting and refreshing hints', async () => {
  const h = harness();
  assert.equal(await h.change('F8'), 'f8');
  assert.deepEqual(h.calls, ['keys:f8|function+controlleft', 'save:f8', 'menu']);
  assert.equal(h.saved(), 'f8');
  await h.change('f8');
  assert.equal(h.calls.length, 3);
  assert.equal(h.context.changingRecordingHotkey, false);
});

test('recording, processing, concurrent edits, and unsupported keys cannot restart capture', async () => {
  for (const state of [{ recording: true }, { processing: true }]) {
    const h = harness(state);
    await assert.rejects(h.change('f8'), /Finish your dictation/);
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  await assert.rejects(h.change('Control+Space'), /supported recording shortcut/);
  h.context.changingRecordingHotkey = true;
  await assert.rejects(h.change('f8'), /finish changing/);
  assert.deepEqual(h.calls, []);
});

test('a failed listener restores the previous key without saving the failed change', async () => {
  const h = harness({ fail: true });
  await assert.rejects(h.change('f8'), /listener failed/);
  assert.deepEqual(h.calls, ['keys:f8|function+controlleft', 'keys:function|function+controlleft']);
  assert.equal(h.saved(), 'function');
  assert.equal(h.context.changingRecordingHotkey, false);
});

test('a stopped recorder saves the choice for its next start without starting capture', async () => {
  const h = harness({ status: 'stopped' });
  await h.change('metaright');
  assert.deepEqual(h.calls, ['keys:metaright|function+controlleft', 'save:metaright', 'menu']);
});

test('recording lock is saved independently and duplicate actions are rejected', async () => {
  const h = harness();
  assert.equal(await h.change('cmd+shift+space', 'lockHotkey'), 'shiftleft+metaleft+space');
  assert.deepEqual(h.calls, ['keys:function|shiftleft+metaleft+space', 'save:function', 'menu']);
  await assert.rejects(h.change('function', 'lockHotkey'), /different shortcuts/);
});
