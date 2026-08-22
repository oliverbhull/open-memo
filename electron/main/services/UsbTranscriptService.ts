import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TranscriptionData } from '../../shared/electron-api';
import { normalizeUsbTranscriptRows } from '../../shared/usb-transcripts';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

const TRANSCRIPT_QUERY = `
WITH ranked AS (
  SELECT
    r.source_sha256,
    d.device_uid,
    r.device_recording_id,
    r.captured_at,
    r.ingested_at,
    r.duration_seconds,
    t.text AS transcript,
    ROW_NUMBER() OVER (
      PARTITION BY r.source_sha256
      ORDER BY CASE WHEN d.device_uid = 'legacy-unknown-device' THEN 1 ELSE 0 END,
               r.ingested_at DESC,
               r.id DESC
    ) AS source_rank
  FROM recordings r
  JOIN devices d ON d.id = r.device_id
  JOIN transcripts t ON t.recording_id = r.id
    AND t.version = (
      SELECT MAX(t2.version) FROM transcripts t2 WHERE t2.recording_id = r.id
    )
  WHERE r.classification = 'audio' AND trim(t.text) <> ''
)
SELECT source_sha256, device_uid, device_recording_id, captured_at,
       ingested_at, duration_seconds, transcript
FROM ranked
WHERE source_rank = 1
ORDER BY COALESCE(captured_at, ingested_at), source_sha256;
`;

export class UsbTranscriptService {
  async list(): Promise<TranscriptionData[]> {
    const database = path.join(app.getPath('userData'), 'memo.sqlite3');
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/sqlite3',
        ['-json', database, TRANSCRIPT_QUERY],
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
      );
      return normalizeUsbTranscriptRows(stdout.trim() ? JSON.parse(stdout) : []);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (code !== 'ENOENT') {
        logger.warn('[UsbTranscriptService] Unable to read Memo USB transcripts:', error);
      }
      return [];
    }
  }
}
