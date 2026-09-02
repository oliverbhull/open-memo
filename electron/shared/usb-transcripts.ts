import type { TranscriptionData } from './electron-api';

export interface UsbTranscriptRow {
  source_sha256: string;
  device_uid: string;
  device_recording_id: string;
  captured_at: string | null;
  ingested_at: string;
  duration_seconds: number | null;
  audio_path: string | null;
  transcript: string;
}

export function normalizeUsbTranscriptRows(value: unknown): TranscriptionData[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const row = candidate as Partial<UsbTranscriptRow>;
    if (
      typeof row.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(row.source_sha256) ||
      typeof row.device_uid !== 'string' ||
      typeof row.device_recording_id !== 'string' ||
      typeof row.ingested_at !== 'string' ||
      typeof row.transcript !== 'string' || !row.transcript.trim()
    ) return [];

    const observedAt = row.captured_at || row.ingested_at;
    const timestamp = Date.parse(observedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return [];

    return [{
      id: `memo-device-${row.source_sha256.toLowerCase()}`,
      processedText: row.transcript.trim(),
      timestamp,
      ...(typeof row.audio_path === 'string' && row.audio_path.trim()
        ? {
            audio: {
              fileName: 'audio.wav',
              mimeType: 'audio/wav' as const,
              ...(typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)
                ? { duration: row.duration_seconds }
                : {}),
            },
          }
        : {}),
      context: {
        source: 'memo-device',
        deviceUid: row.device_uid,
        deviceRecordingId: row.device_recording_id,
        capturedAt: row.captured_at,
        ingestedAt: row.ingested_at,
        durationSeconds: typeof row.duration_seconds === 'number' ? row.duration_seconds : undefined,
      },
    }];
  });
}
