import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsbTranscriptRows } from '../electron/shared/usb-transcripts';

test('normalizes a USB transcript with deterministic source identity', () => {
  const [entry] = normalizeUsbTranscriptRows([{
    source_sha256: 'a'.repeat(64),
    device_uid: 'device-1',
    device_recording_id: '0000003b',
    captured_at: null,
    ingested_at: '2026-08-19T15:08:18-07:00',
    duration_seconds: 10.58,
    transcript: '  Synced transcript.  ',
  }]);

  assert.equal(entry?.id, `memo-device-${'a'.repeat(64)}`);
  assert.equal(entry?.processedText, 'Synced transcript.');
  assert.equal(entry?.context?.source, 'memo-device');
  assert.equal(entry?.context?.deviceRecordingId, '0000003b');
});

test('rejects blank or malformed USB transcript rows', () => {
  assert.deepEqual(normalizeUsbTranscriptRows([{ transcript: 'text' }]), []);
  assert.deepEqual(normalizeUsbTranscriptRows([{
    source_sha256: 'b'.repeat(64),
    device_uid: 'device-1',
    device_recording_id: '1',
    captured_at: null,
    ingested_at: '2026-08-19T15:08:18-07:00',
    duration_seconds: 1,
    transcript: '   ',
  }]), []);
});
