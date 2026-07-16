import { execFile } from 'node:child_process';
import { logger } from '../utils/logger';
import { parseAudioInputDevices, type AudioInputDevice } from './audioInputParser';

export type { AudioInputDevice } from './audioInputParser';

function runSystemProfiler(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/system_profiler',
      ['SPAudioDataType', '-json'],
      { timeout: 5_000, maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export class AudioInputService {
  private devices: AudioInputDevice[] = [];
  private refreshPromise: Promise<AudioInputDevice[]> | null = null;

  getDevices(): AudioInputDevice[] {
    return this.devices.map((device) => ({ ...device }));
  }

  getDefaultDevice(): AudioInputDevice | null {
    const device = this.devices.find((candidate) => candidate.isDefault);
    return device ? { ...device } : null;
  }

  async refresh(): Promise<AudioInputDevice[]> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const devices = parseAudioInputDevices(await runSystemProfiler());
        this.devices = devices;
        return this.getDevices();
      } catch (error) {
        logger.warn('[AudioInputService] Could not refresh macOS audio inputs:', error);
        return this.getDevices();
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }
}

export const audioInputService = new AudioInputService();
