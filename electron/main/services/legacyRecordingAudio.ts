import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { audioDirectoryPath } from './AudioStorageService';

const execFileAsync = promisify(execFile);

export async function readLegacyRecordingAudio(entryId: string): Promise<Buffer | null> {
  const match = /^memo-device-([0-9a-f]{64})$/i.exec(entryId);
  if (!match?.[1]) return null;

  const userData = app.getPath('userData');
  const database = path.join(userData, 'memo.sqlite3');
  const libraries = [
    audioDirectoryPath(),
    // Keep recordings imported by older versions readable after the shared
    // audio directory replaces the legacy device-only directory.
    path.join(userData, 'device-recordings'),
  ];
  const sourceSha256 = match[1].toLowerCase();
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/sqlite3',
      ['-readonly', '-json', database, `SELECT audio_path FROM recordings WHERE lower(source_sha256)='${sourceSha256}' AND classification='audio' AND audio_path IS NOT NULL ORDER BY ingested_at DESC LIMIT 1;`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const rows = stdout.trim() ? JSON.parse(stdout) as Array<{ audio_path?: unknown }> : [];
    const audioPath = rows[0]?.audio_path;
    if (typeof audioPath !== 'string' || path.basename(audioPath) !== 'audio.wav') return null;

    const realAudioPath = await fs.realpath(audioPath);
    const isInRecordingLibrary = (await Promise.all(libraries.map(async library => {
      try {
        const realLibrary = await fs.realpath(library);
        const relative = path.relative(realLibrary, realAudioPath);
        return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }))).some(Boolean);
    if (!isInRecordingLibrary) return null;
    return await fs.readFile(realAudioPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[AudioStorage] Unable to read archived audio for ${entryId}:`, error);
    }
    return null;
  }
}
