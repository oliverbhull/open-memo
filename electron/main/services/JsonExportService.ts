import { app, BrowserWindow, dialog } from 'electron';
import type { SaveDialogOptions } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptionExportDocument } from '../../shared/electron-api';

const MAX_EXPORT_ENTRIES = 100_000;
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDocument(value: unknown): TranscriptionExportDocument {
  if (!isRecord(value) || value.format !== 'open-memo-transcriptions' || value.version !== 1) {
    throw new Error('Invalid transcription export');
  }
  if (!Array.isArray(value.transcriptions) || value.transcriptions.length > MAX_EXPORT_ENTRIES) {
    throw new Error('Invalid transcription export entry count');
  }
  if (value.count !== value.transcriptions.length || typeof value.exportedAt !== 'string') {
    throw new Error('Invalid transcription export metadata');
  }
  for (const entry of value.transcriptions) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.text !== 'string' ||
      typeof entry.createdAt !== 'number' ||
      typeof entry.updatedAt !== 'number'
    ) {
      throw new Error('Invalid transcription export entry');
    }
  }
  return value as unknown as TranscriptionExportDocument;
}

export async function saveJsonExport(
  parent: BrowserWindow | null,
  value: unknown
): Promise<{ success: boolean; canceled?: boolean; error?: string }> {
  const document = validateDocument(value);
  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_EXPORT_BYTES) {
    throw new Error('Transcription export exceeds the 100 MiB limit');
  }

  const date = new Date().toISOString().slice(0, 10);
  const options: SaveDialogOptions = {
    title: 'Export transcriptions as JSON',
    defaultPath: path.join(app.getPath('downloads'), `memo-transcriptions-${date}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  const temporaryPath = `${result.filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, json, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, result.filePath);
    return { success: true };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
