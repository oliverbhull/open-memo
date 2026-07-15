import type { TranscriptionExportDocument } from '../../../shared/electron-api';
import type { MemoEntry } from '../types/storage';

export function buildTranscriptionExport(
  entries: MemoEntry[],
  from?: number,
  to?: number,
  exportedAt = Date.now()
): TranscriptionExportDocument {
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error('Export start time must be before the end time');
  }

  const transcriptions = entries
    .filter((entry) => !entry.deletedAt)
    .filter((entry) => from === undefined || entry.createdAt >= from)
    .filter((entry) => to === undefined || entry.createdAt <= to)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      createdAtIso: new Date(entry.createdAt).toISOString(),
      updatedAt: entry.updatedAt,
      updatedAtIso: new Date(entry.updatedAt).toISOString(),
      context: entry.context ?? {},
    }));

  return {
    format: 'open-memo-transcriptions',
    version: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    range: {
      from: from === undefined ? null : new Date(from).toISOString(),
      to: to === undefined ? null : new Date(to).toISOString(),
    },
    count: transcriptions.length,
    transcriptions,
  };
}
