import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './utils/logger';

const EXPORT_JS = `
(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('memo-web-db');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const entries = await new Promise((res, rej) => {
    const tx = db.transaction('entries', 'readonly');
    const req = tx.objectStore('entries').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return entries;
})()
`;

interface ExportEntry {
  id: string;
  deviceId?: string;
  text?: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
  context?: Record<string, unknown>;
}

function findHtmlPath(): string {
  const htmlPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
  if (fs.existsSync(htmlPath)) return htmlPath;
  throw new Error(`No renderer build found at ${htmlPath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntries(value: unknown): ExportEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('IndexedDB returned an invalid entries payload');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`IndexedDB entry ${index} has no valid id`);
    }
    if (entry.text !== undefined && typeof entry.text !== 'string') {
      throw new Error(`IndexedDB entry ${entry.id} has invalid text`);
    }
    return entry as unknown as ExportEntry;
  });
}

function formatEntry(entry: ExportEntry) {
  const ctx = (entry.context ?? {}) as Record<string, unknown>;
  const appContext = (ctx.appContext ?? {}) as Record<string, unknown>;
  const text = entry.text ?? '';
  return {
    id: entry.id,
    deviceId: entry.deviceId ?? null,
    text,
    wordCount: text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0,
    createdAt: entry.createdAt ?? null,
    createdAtHuman: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
    updatedAt: entry.updatedAt ?? null,
    updatedAtHuman: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
    deletedAt: entry.deletedAt ?? null,
    deletedAtHuman: entry.deletedAt ? new Date(entry.deletedAt).toISOString() : null,
    context: {
      source: ctx.source ?? null,
      rawTranscript: ctx.rawTranscript ?? null,
      wasProcessedByLLM: ctx.wasProcessedByLLM ?? null,
      appName: appContext.appName ?? null,
      windowTitle: appContext.windowTitle ?? null,
      bundleId: appContext.bundleId ?? null,
      audio: ctx.audio ?? null,
      ...Object.fromEntries(
        Object.entries(ctx).filter(([k]) =>
          !['source', 'rawTranscript', 'wasProcessedByLLM', 'appContext', 'audio'].includes(k)
        )
      ),
    },
  };
}

function hasContextField(entry: ExportEntry, key: string): boolean {
  if (!isRecord(entry.context)) return false;
  if (key === 'appName' || key === 'windowTitle' || key === 'bundleId') {
    const appContext = entry.context.appContext;
    return isRecord(appContext) && typeof appContext[key] === 'string' && appContext[key] !== '';
  }
  return entry.context[key] !== undefined && entry.context[key] !== null;
}

async function readIndexedDb(htmlPath: string): Promise<ExportEntry[]> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedUrl = pathToFileURL(htmlPath).toString();
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== allowedUrl) event.preventDefault();
  });

  try {
    await win.loadFile(htmlPath);
    const entries: unknown = await win.webContents.executeJavaScript(EXPORT_JS);
    return parseEntries(entries);
  } finally {
    win.destroy();
  }
}

export async function runMemoExport(): Promise<void> {
  const outPath =
    process.env.MEMO_EXPORT_OUT ??
    path.join(os.homedir(), 'Desktop', 'memo-full-export.json');

  const htmlPath = findHtmlPath();
  logger.info(`[Export] userData: ${app.getPath('userData')}`);
  logger.info(`[Export] html origin: ${htmlPath}`);

  let entries: ExportEntry[];
  try {
    entries = await readIndexedDb(htmlPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Memo storage. Quit Memo and run the export again. ${detail}`);
  }
  const sources = [{ label: 'Memo', userDataPath: app.getPath('userData'), count: entries.length }];
  logger.info(`[Export] Read ${entries.length} entries`);

  const active = entries.filter((entry) => !entry.deletedAt);
  const deleted = entries.filter((entry) => entry.deletedAt);

  const formatted = entries
    .map(formatEntry)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const totalWords = active.reduce(
    (n, e) => n + (e.text?.trim().split(/\s+/).filter(Boolean).length ?? 0),
    0
  );
  const dates = active.map((e) => e.createdAt).filter(Boolean).sort((a, b) => a! - b!) as number[];
  const oldestDate = dates[0];
  const newestDate = dates.at(-1);

  const exportDoc = {
    exportedAt: new Date().toISOString(),
    htmlOrigin: htmlPath,
    sources,
    summary: {
      totalEntries: entries.length,
      activeEntries: active.length,
      deletedEntries: deleted.length,
      totalWordsActive: totalWords,
      oldestMemo: oldestDate === undefined ? null : new Date(oldestDate).toISOString(),
      newestMemo: newestDate === undefined ? null : new Date(newestDate).toISOString(),
      withAppName: active.filter((entry) => hasContextField(entry, 'appName')).length,
      withWindowTitle: active.filter((entry) => hasContextField(entry, 'windowTitle')).length,
      withApplicationBundleId: active.filter((entry) => hasContextField(entry, 'bundleId')).length,
      withAudio: active.filter((entry) => hasContextField(entry, 'audio')).length,
      withRawTranscript: active.filter((entry) => hasContextField(entry, 'rawTranscript')).length,
    },
    entries: formatted,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const temporaryPath = `${outPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(exportDoc, null, 2), 'utf8');
    fs.renameSync(temporaryPath, outPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  console.log('\nMemo export complete');
  console.log(`  Output:       ${outPath}`);
  console.log(`  Total:        ${exportDoc.summary.totalEntries} entries`);
  console.log(`  Active:       ${exportDoc.summary.activeEntries}`);
  console.log(`  Deleted:      ${exportDoc.summary.deletedEntries}`);
  console.log(`  Words:        ${exportDoc.summary.totalWordsActive.toLocaleString()}`);
  console.log(
    `  Date range:   ${exportDoc.summary.oldestMemo?.slice(0, 10) ?? '?'} → ${exportDoc.summary.newestMemo?.slice(0, 10) ?? '?'}`
  );
  console.log(`  With app:     ${exportDoc.summary.withAppName}`);
  console.log(`  With window:  ${exportDoc.summary.withWindowTitle}`);
}
