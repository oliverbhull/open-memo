import assert from 'node:assert/strict';
import test from 'node:test';
import { convertToFeedEntry, convertToMemoEntry, createValidEntry } from '../electron/renderer/src/utils/validation';

test('preserves a native application identity and linked audio attachment', () => {
  const id = '53c2bda5-4fd9-43d8-9be7-eab053a179c9';
  const entry = createValidEntry({
    processedText: 'A linked dictation',
    timestamp: 123,
    appContext: {
      appName: 'Safari',
      windowTitle: 'Example',
      bundleId: 'com.apple.Safari',
    },
    audio: {
      fileName: `${id}.wav`,
      mimeType: 'audio/wav',
      duration: 2.5,
    },
  }, id);

  assert.ok(entry);
  const stored = convertToMemoEntry(entry, 'device');
  const restored = convertToFeedEntry(stored);
  assert.deepEqual(restored.appContext, entry.appContext);
  assert.deepEqual(restored.audio, entry.audio);
});

test('rejects audio that is not named for its transcript ID', () => {
  const entry = createValidEntry({
    processedText: 'Mismatched audio',
    audio: { fileName: 'another-entry.wav', mimeType: 'audio/wav' },
  }, 'expected-entry');

  assert.equal(entry, null);
});

test('rejects a native-filtered transcription instead of restoring its raw artifact', () => {
  const entry = createValidEntry({
    rawTranscript: 'Thanks for watching.',
    processedText: '',
  }, 'filtered-entry');

  assert.equal(entry, null);
});

test('preserves Memo device provenance in entry context', () => {
  const entry = createValidEntry({
    id: 'memo-device-source',
    processedText: 'Synced from the recorder',
    timestamp: 456,
    context: {
      source: 'memo-device',
      deviceUid: 'device-1',
      deviceRecordingId: '0000003b',
    },
  }, 'memo-device-source');

  assert.ok(entry);
  const stored = convertToMemoEntry(entry, 'desktop-device');
  const restored = convertToFeedEntry(stored);
  assert.equal(restored.context?.source, 'memo-device');
  assert.equal(restored.context?.deviceRecordingId, '0000003b');
});
