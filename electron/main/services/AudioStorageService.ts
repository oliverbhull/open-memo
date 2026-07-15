import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AudioAttachment } from '../../shared/electron-api';

const ENTRY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function assertEntryId(entryId: string): void {
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error('Invalid memo entry ID');
  }
}

export class AudioStorageService {
  private get audioDirectory(): string {
    return path.join(app.getPath('userData'), 'audio');
  }

  private audioPath(entryId: string): string {
    assertEntryId(entryId);
    return path.join(this.audioDirectory, `${entryId}.wav`);
  }

  async save(entryId: string, wavData: Buffer, duration?: number): Promise<AudioAttachment> {
    if (wavData.length < 44 || wavData.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('Recorder returned invalid WAV audio');
    }

    await fs.mkdir(this.audioDirectory, { recursive: true });
    const targetPath = this.audioPath(entryId);
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporaryPath, wavData, { mode: 0o600 });
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }

    return {
      fileName: path.basename(targetPath),
      mimeType: 'audio/wav',
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? { duration }
        : {}),
    };
  }

  async read(entryId: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.audioPath(entryId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(entryId: string): Promise<void> {
    try {
      await fs.unlink(this.audioPath(entryId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async openDirectory(): Promise<string> {
    await fs.mkdir(this.audioDirectory, { recursive: true });
    return this.audioDirectory;
  }
}

export const audioStorageService = new AudioStorageService();
