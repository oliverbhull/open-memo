const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const filename = path.resolve(__dirname, '../electron/main/services/MemoDatabaseService.ts');
const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const moduleFixture = { exports: {} };
vm.runInNewContext(code, { module: moduleFixture, exports: moduleFixture.exports, require,
  process: { platform: 'win32' }, Buffer, console }, { filename });
const { MemoDatabaseService } = moduleFixture.exports;

test('Windows history saves and reopens without a system sqlite executable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-native-sqlite-'));
  const databasePath = path.join(directory, 'history.sqlite3');
  let database = new MemoDatabaseService({ databasePath });
  try {
    assert.equal((await database.initialize()).legacyImportComplete, false);
    const entry = { id: 'test-1', deviceId: 'desktop-test', text: "It's working — café.",
      createdAt: 1000, updatedAt: 1000, context: { delivery: 'pasted' } };
    await database.saveEntry(entry);
    assert.equal((await database.getEntry(entry.id)).text, entry.text);
    const legacy = { ...entry, id: 'legacy-1', createdAt: 900, updatedAt: 900 };
    assert.equal((await database.importLegacyEntries([entry, legacy])).imported, 1);
    assert.equal((await database.importLegacyEntries([legacy])).imported, 0);
    await database.close();
    database = new MemoDatabaseService({ databasePath });
    assert.equal((await database.initialize()).legacyImportComplete, true);
    assert.equal((await database.getEntries(50, 0)).length, 2);
    assert.equal((await database.getEntry(entry.id)).context.delivery, 'pasted');
    await database.saveEntry({ ...entry, updatedAt: 2000, deletedAt: 2000 });
    assert.equal((await database.getAllActiveEntries()).length, 1);
    assert.equal((await database.getAllEntries()).length, 2);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});