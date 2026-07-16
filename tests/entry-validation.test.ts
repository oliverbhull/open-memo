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
