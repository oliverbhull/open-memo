import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { MemoDatabaseService } from '../electron/main/services/MemoDatabaseService';
import type { MemoEntry } from '../electron/shared/memo-entry';

const execFileAsync = promisify(execFile);

async function withDatabase(
  run: (database: MemoDatabaseService, databasePath: string) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-database-test-'));
  const databasePath = path.join(directory, 'memo.sqlite3');
  try {
    await run(new MemoDatabaseService({ databasePath }), databasePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function entry(overrides: Partial<MemoEntry> = {}): MemoEntry {
  return {
    id: 'entry-1',
    deviceId: 'desktop-test',
    text: "Oliver's first memo",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    context: { source: 'desktop', note: 'Unicode: café' },
    ...overrides,
  };
}

test('stores desktop entries in the canonical SQLite database', async () => {
  await withDatabase(async (database) => {
    assert.deepEqual(await database.initialize(), { legacyImportComplete: false });
    await database.saveEntry(entry());
    await database.saveEntry(entry({
      id: 'entry-2',
      text: 'A newer memo with four words',
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    }));
    await database.saveEntry(entry({
      id: 'deleted-entry',
      text: 'Deleted memo',
      createdAt: 1_700_000_002_000,
      updatedAt: 1_700_000_002_000,
      deletedAt: 1_700_000_003_000,
    }));

    assert.deepEqual(await database.getEntry('entry-1'), entry());
    assert.deepEqual(
      (await database.getEntries(10, 0)).map((value) => value.id),
      ['entry-2', 'entry-1'],
    );
    assert.deepEqual(
      (await database.getAllEntries()).map((value) => value.id),
      ['deleted-entry', 'entry-2', 'entry-1'],
    );
    assert.equal(await database.getTotalWordCount(), 9);
  });
});

test('imports IndexedDB entries once without overwriting canonical rows', async () => {
  await withDatabase(async (database) => {
    const canonical = entry({ text: 'Canonical value', updatedAt: 1_700_000_002_000 });
    await database.saveEntry(canonical);

    const result = await database.importLegacyEntries([
      entry({ text: 'Stale legacy value' }),
      entry({ id: 'legacy-only', text: 'Legacy only' }),
    ]);
    assert.deepEqual(result, { imported: 1 });
    assert.deepEqual(await database.initialize(), { legacyImportComplete: true });
    assert.equal((await database.getEntry('entry-1'))?.text, 'Canonical value');
    assert.equal((await database.getEntry('legacy-only'))?.text, 'Legacy only');

    assert.deepEqual(await database.importLegacyEntries([
      entry({ id: 'later', text: 'Must not import after cutover' }),
    ]), { imported: 0 });
    assert.equal(await database.getEntry('later'), null);
  });
});

test('refuses to modify a malformed SQLite database', async () => {
  await withDatabase(async (database, databasePath) => {
    await fs.writeFile(databasePath, 'not a sqlite database');
    await assert.rejects(database.initialize(), /database|integrity|file is not a database/i);
    assert.equal(await fs.readFile(databasePath, 'utf8'), 'not a sqlite database');
  });
});

test('adds the entry schema without replacing recorder-owned tables', async () => {
  await withDatabase(async (database, databasePath) => {
    await execFileAsync('/usr/bin/sqlite3', [
      databasePath,
      'CREATE TABLE recordings(id TEXT PRIMARY KEY); INSERT INTO recordings(id) VALUES(\'recording-1\');',
    ]);
    await database.initialize();
    const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
      '-json',
      databasePath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('recordings','memo_entries') ORDER BY name;",
    ]);
    assert.deepEqual(JSON.parse(stdout), [{ name: 'memo_entries' }, { name: 'recordings' }]);
    const preserved = await execFileAsync('/usr/bin/sqlite3', [databasePath, 'SELECT id FROM recordings;']);
    assert.equal(preserved.stdout.trim(), 'recording-1');
  });
});
