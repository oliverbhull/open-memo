import { app } from 'electron';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import type { AsrModelId, AsrSelectionResult, AsrState } from '../../shared/electron-api';
import { loadSettings, saveSettings } from './SettingsService';
import { logger } from '../utils/logger';

const WHISPER_MODEL_NAME = 'ggml-small.en-q5_1.bin';
const WHISPER_MODEL_BYTES = 190_098_681;
const WHISPER_MODEL_SHA256 = 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30';
const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.en-q5_1.bin?download=true';

export function whisperModelPath(): string {
  if (!app.isPackaged) {
    const override = process.env.MEMO_WHISPER_MODEL_PATH?.trim();
    if (override) return path.resolve(override);
  }
  return path.join(app.getPath('userData'), 'models', 'whisper', WHISPER_MODEL_NAME);
}

export function isWhisperModelInstalled(): boolean {
  try {
    return fs.statSync(whisperModelPath()).size === WHISPER_MODEL_BYTES;
  } catch {
    return false;
  }
}

function downloadResponse(url: URL, redirectsRemaining = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `Open-Memo/${app.getVersion()}` },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining === 0) {
          reject(new Error('Whisper download redirected too many times.'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url);
        if (nextUrl.protocol !== 'https:') {
          reject(new Error('Whisper download was redirected to an insecure URL.'));
          return;
        }
        downloadResponse(nextUrl, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Whisper download failed with HTTP ${status}.`));
        return;
      }
      response.setTimeout(60_000, () => response.destroy(new Error('Whisper download timed out.')));
      resolve(response);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Whisper download connection timed out.')));
    request.on('error', reject);
  });
}

export class AsrModelService extends EventEmitter {
  private downloadedBytes = 0;
  private totalBytes = WHISPER_MODEL_BYTES;
  private downloadError: string | null = null;
  private downloadPromise: Promise<void> | null = null;
  private lastProgressEmitAt = 0;

  getState(): AsrState {
    const installed = isWhisperModelInstalled();
    const downloading = this.downloadPromise !== null;
    const selectedModel = loadSettings().asrModel;
    return {
      selectedModel,
      models: {
        granite: {
          id: 'granite',
          name: 'Granite Speech 5.0',
          installState: 'included',
          downloadedBytes: 0,
          totalBytes: 0,
        },
        whisper: {
          id: 'whisper',
          name: 'Whisper (small.en)',
          installState: installed
            ? 'downloaded'
            : downloading
              ? 'downloading'
              : this.downloadError
                ? 'error'
                : 'not-downloaded',
          downloadedBytes: installed ? WHISPER_MODEL_BYTES : this.downloadedBytes,
          totalBytes: this.totalBytes,
          ...(this.downloadError && !installed ? { error: this.downloadError } : {}),
        },
      },
    };
  }

  async selectModel(model: AsrModelId, restartStt: () => void): Promise<AsrSelectionResult> {
    if (model !== 'granite' && model !== 'whisper') {
      return { success: false, state: this.getState(), error: `Unsupported speech model: ${String(model)}` };
    }

    const previous = loadSettings().asrModel;
    try {
      if (model === 'whisper' && !isWhisperModelInstalled()) {
        await this.downloadWhisper();
      }

      if (previous !== model) {
        const settings = loadSettings();
        settings.asrModel = model;
        saveSettings(settings);
        restartStt();
      }
      this.emitState();
      return { success: true, state: this.getState() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.downloadError = message;
      logger.error('[AsrModelService] Whisper model setup failed:', error);
      this.emitState();
      return { success: false, state: this.getState(), error: message };
    }
  }

  private async downloadWhisper(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise;

    this.downloadError = null;
    this.downloadedBytes = 0;
    this.totalBytes = WHISPER_MODEL_BYTES;
    this.downloadPromise = this.performWhisperDownload();
    this.emitState();
    try {
      await this.downloadPromise;
    } finally {
      this.downloadPromise = null;
    }
  }

  private async performWhisperDownload(): Promise<void> {
    const destination = whisperModelPath();
    const partial = `${destination}.part`;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.rm(partial, { force: true });

    try {
      const response = await downloadResponse(new URL(WHISPER_MODEL_URL));
      const responseBytes = Number(response.headers['content-length']);
      if (Number.isFinite(responseBytes) && responseBytes > 0) this.totalBytes = responseBytes;

      const hash = createHash('sha256');
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk);
          this.downloadedBytes += chunk.length;
          const now = Date.now();
          if (now - this.lastProgressEmitAt >= 150) {
            this.lastProgressEmitAt = now;
            this.emitState();
          }
          callback(null, chunk);
        },
      });
      await pipeline(response, meter, fs.createWriteStream(partial, { flags: 'wx' }));

      if (this.downloadedBytes !== WHISPER_MODEL_BYTES) {
        throw new Error(
          `Whisper download was incomplete (received ${this.downloadedBytes.toLocaleString()} of ${WHISPER_MODEL_BYTES.toLocaleString()} bytes).`,
        );
      }
      const digest = hash.digest('hex');
      if (digest !== WHISPER_MODEL_SHA256) {
        throw new Error('Whisper download failed its integrity check.');
      }

      await fs.promises.rename(partial, destination);
      this.totalBytes = WHISPER_MODEL_BYTES;
      this.downloadedBytes = WHISPER_MODEL_BYTES;
      this.downloadError = null;
      logger.info(`[AsrModelService] Whisper model installed at ${destination}`);
    } catch (error) {
      await fs.promises.rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emitState(): void {
    this.emit('state-changed', this.getState());
  }
}
