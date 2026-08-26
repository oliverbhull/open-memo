import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoEntry } from '../../shared/memo-entry';

const MAX_SQLITE_OUTPUT_BYTES = 50 * 1024 * 1024;
const LEGACY_IMPORT_KEY = 'legacy_indexeddb_import_v1';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=30000;
CREATE TABLE IF NOT EXISTS schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memo_entries(
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  context_json TEXT NOT NULL CHECK(json_valid(context_json))
);
CREATE INDEX IF NOT EXISTS memo_entries_active_updated_idx
  ON memo_entries(updated_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL;
INSERT OR IGNORE INTO schema_meta(key, value)
  VALUES('desktop_schema_version', '1');
`;

interface MemoDatabaseOptions {
  databasePath: string;
  sqlitePath?: string;
}

interface StoredMemoEntry extends MemoEntry {
  contextJson: string;
}

function sqliteText(value: string): string {
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer timestamp`);
  }
  return value;
}

function requiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function normalizeEntry(value: unknown): StoredMemoEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memo entry must be an object');
  }
  const candidate = value as Partial<MemoEntry>;
  const context = candidate.context ?? {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('Memo entry context must be an object');
  }
  let contextJson: string;
  try {
    contextJson = JSON.stringify(context);
  } catch {
    throw new Error('Memo entry context must be JSON serializable');
  }
  if (Buffer.byteLength(contextJson, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Memo entry context is too large');
  }
  return {
    id: requiredText(candidate.id, 'Memo entry ID', 1024),
    deviceId: requiredText(candidate.deviceId, 'Memo entry device ID', 1024),
    text: requiredText(candidate.text, 'Memo entry text', 10 * 1024 * 1024),
    createdAt: finiteTimestamp(candidate.createdAt, 'Memo entry createdAt'),
    updatedAt: finiteTimestamp(candidate.updatedAt, 'Memo entry updatedAt'),
    ...(candidate.deletedAt === undefined
      ? {}
      : { deletedAt: finiteTimestamp(candidate.deletedAt, 'Memo entry deletedAt') }),
    context,
    contextJson,
  };
}

function entryValues(entry: StoredMemoEntry): string {
  return [
    sqliteText(entry.id),
    sqliteText(entry.deviceId),
    sqliteText(entry.text),
    String(entry.createdAt),
    String(entry.updatedAt),
    entry.deletedAt === undefined ? 'NULL' : String(entry.deletedAt),
    sqliteText(entry.contextJson),
  ].join(',');
}

function parseEntry(row: Record<string, unknown>): MemoEntry {
  const context = typeof row.context_json === 'string'
    ? JSON.parse(row.context_json) as unknown
    : {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('Stored Memo entry context is invalid');
  }
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    text: String(row.text),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    ...(row.deleted_at_ms === null || row.deleted_at_ms === undefined
      ? {}
      : { deletedAt: Number(row.deleted_at_ms) }),
    context: context as Record<string, unknown>,
  };
}

export class MemoDatabaseService {
  private readonly databasePath: string;
  private readonly sqlitePath: string;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: MemoDatabaseOptions) {
    this.databasePath = options.databasePath;
    this.sqlitePath = options.sqlitePath ?? '/usr/bin/sqlite3';
  }

  async initialize(): Promise<{ legacyImportComplete: boolean }> {
    return this.serialized(async () => {
      await this.ensureSchema();
      return { legacyImportComplete: await this.legacyImportComplete() };
    });
  }

  async importLegacyEntries(values: unknown): Promise<{ imported: number }> {
    if (!Array.isArray(values) || values.length > 100_000) {
      throw new Error('Legacy Memo entry import is invalid');
    }
    const entries = values.map(normalizeEntry);
    return this.serialized(async () => {
      await this.ensureSchema();
      if (await this.legacyImportComplete()) return { imported: 0 };
      const statements = entries.map((entry) => `
INSERT OR IGNORE INTO memo_entries(
  id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
) VALUES(${entryValues(entry)});`).join('');
      const rows = await this.query(`
BEGIN IMMEDIATE;${statements}
SELECT total_changes() AS imported;
INSERT INTO schema_meta(key, value)
VALUES(${sqliteText(LEGACY_IMPORT_KEY)}, 'complete')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
COMMIT;
`);
      return { imported: Number(rows[0]?.imported ?? 0) };
    });
  }

  async saveEntry(value: unknown): Promise<void> {
    const entry = normalizeEntry(value);
    await this.serialized(async () => {
      await this.ensureSchema();
      await this.execute(`
INSERT INTO memo_entries(
  id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
) VALUES(${entryValues(entry)})
ON CONFLICT(id) DO UPDATE SET
  device_id=excluded.device_id,
  text=excluded.text,
  created_at_ms=excluded.created_at_ms,
  updated_at_ms=excluded.updated_at_ms,
  deleted_at_ms=excluded.deleted_at_ms,
  context_json=excluded.context_json
WHERE excluded.updated_at_ms >= memo_entries.updated_at_ms;
`);
    });
  }

  async getEntry(id: unknown): Promise<MemoEntry | null> {
    const normalizedId = requiredText(id, 'Memo entry ID', 1024);
    return this.serialized(async () => {
      await this.ensureSchema();
      const rows = await this.query(`
SELECT id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
FROM memo_entries WHERE id=${sqliteText(normalizedId)} LIMIT 1;
`);
      return rows[0] ? parseEntry(rows[0]) : null;
    });
  }

  async getEntries(limit: unknown, offset: unknown): Promise<MemoEntry[]> {
    const normalizedLimit = Number(limit);
    const normalizedOffset = Number(offset);
    if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 500) {
      throw new Error('Memo entry limit is invalid');
    }
    if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0) {
      throw new Error('Memo entry offset is invalid');
    }
    return this.serialized(async () => {
      await this.ensureSchema();
      const rows = await this.query(`
SELECT id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
FROM memo_entries
WHERE deleted_at_ms IS NULL
ORDER BY updated_at_ms DESC, id DESC
LIMIT ${normalizedLimit} OFFSET ${normalizedOffset};
`);
      return rows.map(parseEntry);
    });
  }

  async getAllActiveEntries(): Promise<MemoEntry[]> {
    return this.serialized(async () => {
      await this.ensureSchema();
      const rows = await this.query(`
SELECT id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
FROM memo_entries
WHERE deleted_at_ms IS NULL
ORDER BY updated_at_ms DESC, id DESC;
`);
      return rows.map(parseEntry);
    });
  }

  async getAllEntries(): Promise<MemoEntry[]> {
    return this.serialized(async () => {
      await this.ensureSchema();
      const rows = await this.query(`
SELECT id, device_id, text, created_at_ms, updated_at_ms, deleted_at_ms, context_json
FROM memo_entries
ORDER BY updated_at_ms DESC, id DESC;
`);
      return rows.map(parseEntry);
    });
  }

  async getTotalWordCount(): Promise<number> {
    const entries = await this.getAllActiveEntries();
    return entries.reduce((total, entry) => (
      total + entry.text.trim().split(/\s+/).filter(Boolean).length
    ), 0);
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
    const integrity = await this.query('PRAGMA quick_check(1);');
    const result = integrity[0] ? Object.values(integrity[0])[0] : undefined;
    if (result !== 'ok') {
      throw new Error(`Memo database integrity check failed: ${String(result ?? 'no result')}`);
    }
    await this.execute(SCHEMA);
    this.initialized = true;
  }

  private async legacyImportComplete(): Promise<boolean> {
    const rows = await this.query(`
SELECT value FROM schema_meta WHERE key=${sqliteText(LEGACY_IMPORT_KEY)} LIMIT 1;
`);
    return rows[0]?.value === 'complete';
  }

  private async query(sql: string): Promise<Array<Record<string, unknown>>> {
    const output = await this.execute(sql, true);
    if (!output.trim()) return [];
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Memo database returned invalid JSON');
    return parsed as Array<Record<string, unknown>>;
  }

  private execute(sql: string, json = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.sqlitePath, [...(json ? ['-json'] : []), this.databasePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_SQLITE_OUTPUT_BYTES) {
          child.kill();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (outputBytes > MAX_SQLITE_OUTPUT_BYTES) {
          reject(new Error('Memo database response exceeded the safety limit'));
        } else if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `sqlite3 exited ${code}`));
        } else {
          resolve(Buffer.concat(stdout).toString('utf8'));
        }
      });
      child.stdin.end(
        `.bail on\n.timeout 30000\nPRAGMA foreign_keys=ON;\nPRAGMA synchronous=FULL;\n${sql}\n`,
      );
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
