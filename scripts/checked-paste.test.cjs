const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');

function load(run) {
  const entry = path.resolve('electron/main/services/checkedPaste.ts');
  const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module), original = Module._load;
  Module._load = (name, ...args) => name === 'node:child_process' ? { execFileSync: run } : original(name, ...args);
  try { loaded._compile(js, entry); } finally { Module._load = original; }
  return loaded.exports;
}

test('paste targets the control focused at delivery time', () => {
  const { pasteIntoFocusedTarget, FOCUSED_PASTE_SCRIPT } = load((command, args, options) => {
    assert.equal(command, 'osascript');
    assert.equal(args[1], FOCUSED_PASTE_SCRIPT);
    assert.equal(args[2], 'true');
    assert.equal(args.length, 3);
    assert.match(args[1], /first application process whose frontmost is true/);
    assert.doesNotMatch(args[1], /expectedApp|target_changed/);
    assert.equal(options.timeout, 1500);
    return 'pasted\x1eSafari\x1eInbox - Gmail\x1ecom.apple.Safari\n';
  });
  assert.deepEqual(pasteIntoFocusedTarget(true), {
    status: 'pasted',
    appContext: { appName: 'Safari', windowTitle: 'Inbox - Gmail', bundleId: 'com.apple.Safari' },
  });
});

test('dictation text never enters the AppleScript arguments', () => {
  const { pasteIntoFocusedTarget } = load((command, args, options) => {
    assert.equal(command, 'osascript');
    assert.equal(args[2], 'false');
    assert.equal(args.length, 3);
    assert.equal(options.timeout, 1500);
    return 'pasted\x1eSafari\x1eInbox - Gmail\x1ecom.apple.Safari\n';
  });
  assert.equal(pasteIntoFocusedTarget(false).status, 'pasted');
});

test('only explicit paste confirmation is reported as pasted', () => {
  for (const [response, expected] of [['pasted\n', 'pasted'], ['target_unavailable', 'target_unavailable'], ['unexpected', 'target_unavailable']]) {
    const { pasteIntoFocusedTarget } = load(() => response);
    assert.equal(pasteIntoFocusedTarget(false).status, expected);
  }
});

test('Granite final does not mark an asynchronous cleanup as completed', async () => {
  const entry = path.resolve('electron/main/services/MemoSttService.ts');
  const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron', './SettingsService', './AsrModelService'] }).outputFiles[0].text;
  const loaded = new Module(entry, module), original = Module._load;
  Module._load = (name, ...args) => {
    if (name === 'electron') return { app: { isPackaged: false } };
    if (name === './SettingsService') return { loadSettings: () => ({ writingMode: 'clean', saveAudio: false, vocabWords: [] }) };
    if (name === './AsrModelService') return {};
    return original(name, ...args);
  };
  try { loaded._compile(js, entry); } finally { Module._load = original; }
  const service = new loaded.exports.MemoSttService();
  const events = []; let finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  service.on('transcription', async () => { events.push('received'); await cleanup; events.push('delivered'); });
  service.on('processingCompleted', () => events.push('completed'));
  await service.processLine('FINAL: {"rawTranscript":"Hello.","processedText":"Hello."}');
  assert.deepEqual(events, ['received']);
  finish(); await cleanup;
  assert.deepEqual(events, ['received', 'delivered']);
  await service.processLine('📝 (no speech detected)');
  assert.deepEqual(events, ['received', 'delivered', 'completed']);
});
