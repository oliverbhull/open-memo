import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLegacyMemoEntries } from '../electron/renderer/src/services/StorageService';

test('normalizes old and current IndexedDB records without changing their source data', () => {
  const entries = normalizeLegacyMemoEntries([
    {
      id: 'old',
      text: 'Old schema',
      timestamp: 100,
      rawTranscript: 'raw',
      wasProcessedByLLM: false,
      appContext: { appName: 'Notes', windowTitle: 'Draft' },
    },
    {
      id: 'current',
      deviceId: 'original-device',
      text: 'Current schema',
      createdAt: 200,
      updatedAt: 250,
      deletedAt: 300,
      context: { source: 'memo-device', recordingId: 'recording-1' },
    },
  ], 'fallback-device', 999);

  assert.deepEqual(entries, [
    {
      id: 'old',
      deviceId: 'fallback-device',
      text: 'Old schema',
      createdAt: 100,
      updatedAt: 100,
      context: {
        source: 'desktop',
        rawTranscript: 'raw',
        wasProcessedByLLM: false,
        appContext: { appName: 'Notes', windowTitle: 'Draft' },
      },
    },
    {
      id: 'current',
      deviceId: 'original-device',
      text: 'Current schema',
      createdAt: 200,
      updatedAt: 250,
      deletedAt: 300,
      context: { source: 'memo-device', recordingId: 'recording-1' },
    },
  ]);

  assert.throws(
    () => normalizeLegacyMemoEntries([{ id: '', text: 'malformed' }], 'fallback-device', 999),
    /entry 0 is malformed/,
  );
});
