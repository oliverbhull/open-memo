const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');

function load(relative, mocks = {}) {
  const entry = path.resolve(relative);
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (name, ...args) => name in mocks ? mocks[name] : original(name, ...args);
  try { loaded._compile(compiled, entry); } finally { Module._load = original; }
  return loaded.exports;
}

test('main-owned history survives reopening with delivered text and original provenance', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { MemoDatabaseService } = load('electron/main/services/MemoDatabaseService.ts');
  const { createDictationEntry } = load('electron/shared/dictationEntry.ts');
  const options = { databasePath: path.join(directory, 'history.sqlite3') };
  const database = new MemoDatabaseService(options);
  const entry = createDictationEntry({ id: 'dictation-1', timestamp: 1000,
    processedText: 'Send the message.', rawTranscript: 'send the message enter',
    wasProcessedByLLM: true,
    audio: { fileName: 'dictation-1.wav', mimeType: 'audio/wav' },
    context: { cleanup: { status: 'accepted', selected: 'Send the message. enter' }, delivery: 'target_changed' },
  }, 'desktop-test');
  await database.saveEntry(entry);
  const reopened = new MemoDatabaseService(options);
  const stored = await reopened.getEntry(entry.id);
  assert.equal(stored.text, 'Send the message.');
  assert.equal(stored.context.rawTranscript, 'send the message enter');
  assert.equal(stored.context.cleanup.status, 'accepted');
  assert.equal(stored.context.delivery, 'target_changed');
  assert.equal(stored.context.audio.fileName, 'dictation-1.wav');
  // A later legacy renderer import must not overwrite the main-owned record.
  await reopened.importLegacyEntries([{ ...entry, text: 'stale legacy text' }]);
  assert.equal((await reopened.getEntry(entry.id)).text, entry.text);
});

test('renderer displays a main-persisted entry once and never resurrects a tombstone', async () => {
  let existing;
  const { EntryService } = load('electron/renderer/src/services/EntryService.ts', {
    './StorageService': { storageService: { init: async () => {}, getEntries: async () => [],
      getEntry: async () => existing, saveEntry: async () => assert.fail('already persisted') } },
    './DeviceIdService': { getDeviceId: async () => 'desktop-test' },
    '../utils/logger': { logger: { warn() {}, error() {} } },
  });
  const service = new EntryService();
  await service.init();
  const events = [];
  service.on('entryAdded', entry => events.push(entry));
  existing = { id: 'saved', deviceId: 'desktop-test', text: 'Saved.', createdAt: 1000, updatedAt: 1000 };
  await service.addEntry({ id: 'saved', processedText: 'Saved.' });
  await service.addEntry({ id: 'saved', processedText: 'Saved.' });
  assert.equal(events.length, 1);
  assert.equal(service.getRecentEntries().length, 1);
  existing = { ...existing, id: 'deleted', deletedAt: 2000 };
  assert.equal(await service.addEntry({ id: 'deleted', processedText: 'Deleted.' }), null);
  assert.equal(events.length, 1);
});

test('reconciled supermicrophone recordings retain chronological feed order', async () => {
  const stored = new Map([
    ['new-desktop', { id: 'new-desktop', deviceId: 'desktop-test', text: 'New.', createdAt: 3000, updatedAt: 3000, context: { source: 'desktop' } }],
    ['old-device', { id: 'old-device', deviceId: 'desktop-test', text: 'Old.', createdAt: 1000, updatedAt: 1000, context: { source: 'memo-device' } }],
  ]);
  const { EntryService } = load('electron/renderer/src/services/EntryService.ts', {
    './StorageService': { storageService: { init: async () => {},
      getEntries: async () => [stored.get('new-desktop')],
      getEntry: async id => stored.get(id), saveEntry: async () => assert.fail('already persisted') } },
    './DeviceIdService': { getDeviceId: async () => 'desktop-test' },
    '../utils/logger': { logger: { warn() {}, error() {} } },
  });
  const service = new EntryService();
  await service.init();
  await service.addEntry({ id: 'old-device', processedText: 'Old.', timestamp: 1000 });
  assert.deepEqual(service.getRecentEntries().map(entry => entry.id), ['new-desktop', 'old-device']);
});

test('database history is ordered by creation time rather than later updates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { MemoDatabaseService } = load('electron/main/services/MemoDatabaseService.ts');
  const database = new MemoDatabaseService({ databasePath: path.join(directory, 'history.sqlite3') });
  await database.saveEntry({ id: 'new', deviceId: 'test', text: 'New.', createdAt: 3000, updatedAt: 3000, context: {} });
  await database.saveEntry({ id: 'old-edited', deviceId: 'test', text: 'Old.', createdAt: 1000, updatedAt: 4000, context: {} });
  assert.deepEqual((await database.getEntries(10, 0)).map(entry => entry.id), ['new', 'old-edited']);
});

test('application metadata does not block dictation on a shell lookup', () => {
  const { ApplicationIconService } = load('electron/main/services/ApplicationIconService.ts', {
    electron: { app: { isPackaged: true }, nativeImage: {} },
    'node:child_process': { execFileSync: () => assert.fail('must resolve icons lazily') },
  });
  const service = new ApplicationIconService();
  const context = { appName: 'Example', windowTitle: '', bundleId: 'com.example.app' };
  assert.deepEqual(service.enrichContext(context), context);
});
