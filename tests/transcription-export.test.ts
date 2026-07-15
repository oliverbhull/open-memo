import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTranscriptionExport } from '../electron/renderer/src/services/transcriptionExport';
import type { MemoEntry } from '../electron/renderer/src/types/storage';

const entries: MemoEntry[] = [
  { id: 'old', deviceId: 'device', text: 'Older text', createdAt: 100, updatedAt: 100 },
  { id: 'new', deviceId: 'device', text: 'Newer text', createdAt: 300, updatedAt: 310 },
  { id: 'deleted', deviceId: 'device', text: 'Deleted text', createdAt: 200, updatedAt: 200, deletedAt: 250 },
];

test('exports active transcriptions in newest-first order', () => {
  const document = buildTranscriptionExport(entries, undefined, undefined, 1_000);
  assert.equal(document.format, 'open-memo-transcriptions');
  assert.equal(document.count, 2);
  assert.deepEqual(document.transcriptions.map((entry) => entry.id), ['new', 'old']);
  assert.deepEqual(document.range, { from: null, to: null });
});

test('exports an inclusive transcription time range', () => {
  const document = buildTranscriptionExport(entries, 300, 300, 1_000);
  assert.equal(document.count, 1);
  assert.equal(document.transcriptions[0]?.id, 'new');
  assert.equal(document.range.from, new Date(300).toISOString());
  assert.equal(document.range.to, new Date(300).toISOString());
});

test('rejects an inverted export range', () => {
  assert.throws(() => buildTranscriptionExport(entries, 400, 100), /start time/);
});
