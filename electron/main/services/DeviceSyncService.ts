import { app } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { DeviceSyncStatus, TranscriptionData } from '../../shared/electron-api';
import { normalizeUsbTranscriptRows } from '../../shared/usb-transcripts';
import { isWhisperModelInstalled, whisperModelPath } from './AsrModelService';
import {
  FirmwareReleaseService,
  type FirmwareUpdateArtifact,
} from './FirmwareReleaseService';
import { loadSettings } from './SettingsService';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

interface DeviceSyncOptions {
  pauseDictation: () => Promise<boolean>;
  resumeDictation: () => Promise<void> | void;
  firmwareReleases?: FirmwareReleaseService;
}

interface WorkerStatusMessage extends Partial<DeviceSyncStatus> {
  type: 'status';
  state: DeviceSyncStatus['state'];
}

interface WorkerRecordingMessage {
  type: 'recording';
  recording: unknown;
}

export class DeviceSyncService extends EventEmitter {
  private child: ChildProcess | null = null;
  private updateChild: ChildProcess | null = null;
  private stopPromise: Promise<void> | null = null;
  private firmwareUpdatePromise: Promise<void> | null = null;
  private lastFirmwareCheckKey: string | null = null;
  private generation = 0;
  private stopped = true;
  private restartTimer: NodeJS.Timeout | null = null;
  private dictationPaused = false;
  private transcriptionGrant: Promise<void> | null = null;
  private grantedBatchId: string | null = null;
  private status: DeviceSyncStatus = { state: 'disconnected', completed: 0, total: 0 };
  private readonly options: DeviceSyncOptions;
  private readonly firmwareReleases: FirmwareReleaseService;

  constructor(options: DeviceSyncOptions) {
    super();
    this.options = options;
    this.firmwareReleases = options.firmwareReleases ?? new FirmwareReleaseService({
      cacheDirectory: path.join(app.getPath('userData'), 'firmware-cache'),
    });
  }

  getStatus(): DeviceSyncStatus {
    return { ...this.status };
  }

  isTranscribing(): boolean {
    return this.status.state === 'transcribing';
  }

  async start(): Promise<void> {
    const generation = this.generation;
    if (this.stopPromise) await this.stopPromise;
    if (generation !== this.generation) return;
    if (this.child) return;
    this.stopped = false;
    if (await this.legacyOwnerIsLoaded()) {
      this.publishStatus({
        state: 'error', completed: 0, total: 0, code: 'legacy-owner',
        error: 'The legacy Memo USB sync service is still running. Quit it before desktop sync can start.',
      });
      return;
    }
    if (generation !== this.generation) return;

    const resources = this.resolveResources();
    for (const [label, resource] of Object.entries(resources)) {
      if (!fs.existsSync(resource)) {
        this.publishStatus({ state: 'error', completed: 0, total: 0, code: 'missing-resource', error: `Memo device sync ${label} is missing: ${resource}` });
        return;
      }
    }

    const requestedModel = loadSettings().asrModel;
    const actualModel = requestedModel === 'whisper' && isWhisperModelInstalled() ? 'whisper' : 'nemotron';
    const fallbackReason = requestedModel === 'whisper' && actualModel === 'nemotron'
      ? 'selected Whisper model was not installed'
      : '';
    const userData = app.getPath('userData');
    const args = [
      '-B', resources.helper,
      '--database', path.join(userData, 'memo.sqlite3'),
      '--library', path.join(userData, 'device-recordings'),
      '--batch-directory', path.join(userData, 'batches'),
      '--journal', path.join(userData, 'device-sync-journal.json'),
      '--lock', path.join(userData, 'device-sync.lock'),
      '--stt-bin', resources.stt,
      '--nemotron-root', resources.nemotron,
      '--whisper-model', whisperModelPath(),
      '--requested-model', requestedModel,
      '--actual-model', actualModel,
    ];
    if (fallbackReason) args.push('--fallback-reason', fallbackReason);

    logger.info(`[DeviceSyncService] Starting bundled worker (${requestedModel} -> ${actualModel})`);
    const child = spawn(resources.python, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      detached: process.platform !== 'win32',
    });
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.handleLine(line));
    child.stderr!.on('data', (data: Buffer) => logger.info(`[device-sync] ${data.toString().trim()}`));
    child.on('error', (error) => this.publishStatus({ state: 'error', completed: 0, total: 0, code: 'worker-start', error: error.message }));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.restoreDictation();
      if (code === 2) {
        this.stopped = true;
        return;
      }
      if (!this.stopped) {
        logger.warn(`[DeviceSyncService] Worker exited (${code ?? signal}); restarting`);
        this.restartTimer = setTimeout(() => void this.start(), 2_000);
      }
    });
  }

  async stop(options: { restoreDictation?: boolean } = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.generation++;
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.transcriptionGrant = null;
    this.grantedBatchId = null;
    const child = this.child;
    const updateChild = this.updateChild;
    this.child = null;
    this.updateChild = null;
    const activeChildren = [child, updateChild].filter(
      (candidate): candidate is ChildProcess => Boolean(
        candidate && candidate.exitCode === null && candidate.signalCode === null,
      ),
    );
    if (activeChildren.length > 0) {
      this.stopPromise = Promise.all(
        activeChildren.map((candidate) => this.terminateChild(candidate)),
      ).then(() => undefined).finally(() => {
        this.stopPromise = null;
      });
      await this.stopPromise;
    }
    if (options.restoreDictation !== false) this.restoreDictation();
  }

  async restart(): Promise<void> {
    if (this.updateChild) {
      logger.info('[DeviceSyncService] Firmware update is active; the worker will restart afterward');
      return;
    }
    await this.stop({ restoreDictation: false });
    this.stopped = false;
    await this.start();
  }

  recordingsDirectory(): string {
    return path.join(app.getPath('userData'), 'device-recordings');
  }

  private resolveResources(): {
    python: string;
    helper: string;
    updater: string;
    stt: string;
    nemotron: string;
  } {
    const dev = !app.isPackaged;
    const nemotron = dev ? path.join(process.cwd(), '.build', 'nemotron') : path.join(process.resourcesPath, 'nemotron');
    return {
      python: path.join(nemotron, 'runtime', 'bin', 'python3.12'),
      helper: dev ? path.join(process.cwd(), 'sidecars', 'device-sync', 'device_sync.py') : path.join(process.resourcesPath, 'device-sync', 'device_sync.py'),
      updater: dev ? path.join(process.cwd(), 'sidecars', 'device-sync', 'firmware_update.py') : path.join(process.resourcesPath, 'device-sync', 'firmware_update.py'),
      stt: dev ? path.join(process.cwd(), '.build', 'stt', 'memo-stt') : path.join(process.resourcesPath, 'sttbin', 'memo-stt'),
      nemotron,
    };
  }

  private async legacyOwnerIsLoaded(): Promise<boolean> {
    if (process.platform !== 'darwin' || process.env.MEMO_ALLOW_LEGACY_USB_OWNER === '1') return false;
    try {
      await execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid?.() ?? 0}/com.memo.usb-sync`]);
      return true;
    } catch {
      return false;
    }
  }

  private handleLine(line: string): void {
    let message: WorkerStatusMessage | WorkerRecordingMessage;
    try {
      message = JSON.parse(line) as WorkerStatusMessage | WorkerRecordingMessage;
    } catch {
      logger.warn(`[DeviceSyncService] Ignored non-JSON worker output: ${line}`);
      return;
    }
    if (message.type === 'recording') {
      const [transcription] = normalizeUsbTranscriptRows([message.recording]);
      if (transcription) this.emit('transcription', transcription satisfies TranscriptionData);
      return;
    }
    if (message.type !== 'status') return;
    const next: DeviceSyncStatus = {
      state: message.state,
      completed: typeof message.completed === 'number' ? message.completed : 0,
      total: typeof message.total === 'number' ? message.total : 0,
      ...(typeof message.batchId === 'string' ? { batchId: message.batchId } : {}),
      ...(typeof message.deviceUid === 'string' ? { deviceUid: message.deviceUid } : {}),
      ...(typeof message.firmwareVersion === 'string' ? { firmwareVersion: message.firmwareVersion } : {}),
      ...(typeof message.protocolVersion === 'number' ? { protocolVersion: message.protocolVersion } : {}),
      ...(typeof message.port === 'string' ? { port: message.port } : {}),
      ...(typeof message.requestedModel === 'string' ? { requestedModel: message.requestedModel } : {}),
      ...(typeof message.actualModel === 'string' ? { actualModel: message.actualModel } : {}),
      ...(typeof message.error === 'string' ? { error: message.error } : {}),
      ...(typeof message.code === 'string' ? { code: message.code } : {}),
    };
    this.publishStatus(next);
    if (next.state === 'connected') this.scheduleFirmwareCheck(next);
    if (next.state === 'transcribing' && this.grantedBatchId !== (next.batchId ?? 'unknown')) {
      void this.grantTranscriptionSlot(next.batchId ?? 'unknown');
    }
  }

  private publishStatus(status: DeviceSyncStatus): void {
    if (['complete', 'error', 'disconnected', 'connected', 'firmware-updated', 'update-error'].includes(status.state)) {
      this.restoreDictation();
      this.grantedBatchId = null;
    }
    if (status.state === 'disconnected') this.lastFirmwareCheckKey = null;
    this.status = status;
    this.emit('status', status);
  }

  private restoreDictation(): void {
    if (!this.dictationPaused) return;
    this.dictationPaused = false;
    void this.options.resumeDictation();
  }

  private async grantTranscriptionSlot(batchId: string): Promise<void> {
    if (this.transcriptionGrant) return this.transcriptionGrant;
    this.transcriptionGrant = (async () => {
      if (!this.dictationPaused) this.dictationPaused = await this.options.pauseDictation();
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        throw new Error('device sync worker closed before batch transcription was granted');
      }
      stdin.write('CONTINUE\n');
      this.grantedBatchId = batchId;
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await this.stop({ restoreDictation: false });
      this.publishStatus({ state: 'error', completed: 0, total: 0, code: 'stt-owner', error: message });
    }).finally(() => {
      this.transcriptionGrant = null;
    });
    return this.transcriptionGrant;
  }

  private scheduleFirmwareCheck(status: DeviceSyncStatus): void {
    if (
      status.protocolVersion !== 2
      || !status.deviceUid
      || !status.firmwareVersion
      || this.firmwareUpdatePromise
    ) return;
    const checkKey = `${status.deviceUid}:${status.firmwareVersion}`;
    if (this.lastFirmwareCheckKey === checkKey) return;
    this.lastFirmwareCheckKey = checkKey;
    this.firmwareUpdatePromise = this.checkAndApplyFirmware(status)
      .catch((error) => logger.error('[DeviceSyncService] Firmware update orchestration failed:', error))
      .finally(() => {
        this.firmwareUpdatePromise = null;
      });
  }

  private async checkAndApplyFirmware(connected: DeviceSyncStatus): Promise<void> {
    const initialGeneration = this.generation;
    const baseStatus = {
      completed: 0,
      total: 0,
      deviceUid: connected.deviceUid,
      firmwareVersion: connected.firmwareVersion,
      protocolVersion: connected.protocolVersion,
      port: connected.port,
    };
    this.publishStatus({ state: 'checking-update', ...baseStatus });

    let workerStopped = false;
    let updateGeneration = initialGeneration;
    try {
      const artifact = await this.firmwareReleases.findUpdate(connected.firmwareVersion!);
      if (this.generation !== initialGeneration || this.stopped) {
        this.lastFirmwareCheckKey = null;
        return;
      }
      if (!artifact) {
        this.publishStatus({ state: 'connected', ...baseStatus });
        return;
      }

      await this.stop({ restoreDictation: false });
      workerStopped = true;
      updateGeneration = this.generation;
      this.publishStatus({
        state: 'updating-firmware',
        ...baseStatus,
        targetFirmwareVersion: artifact.firmwareVersion,
      });
      await this.runFirmwareUpdater(artifact, connected.deviceUid!);
      if (this.generation !== updateGeneration) return;
      this.publishStatus({
        state: 'firmware-updated',
        ...baseStatus,
        firmwareVersion: artifact.firmwareVersion,
        targetFirmwareVersion: artifact.firmwareVersion,
      });
    } catch (error) {
      if (workerStopped && this.generation !== updateGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[DeviceSyncService] Firmware update skipped: ${message}`);
      this.publishStatus({
        state: 'update-error',
        ...baseStatus,
        code: 'firmware-update',
        error: message,
      });
    } finally {
      if (workerStopped && this.generation === updateGeneration) {
        this.stopped = false;
        await this.start();
      }
    }
  }

  private async runFirmwareUpdater(
    artifact: FirmwareUpdateArtifact,
    deviceUid: string,
  ): Promise<void> {
    const resources = this.resolveResources();
    const child = spawn(resources.python, [
      '-B', resources.updater,
      '--uf2', artifact.path,
      '--expected-sha256', artifact.sha256,
      '--expected-version', artifact.firmwareVersion,
      '--device-uid', deviceUid,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      detached: process.platform !== 'win32',
    });
    this.updateChild = child;
    await new Promise<void>((resolve, reject) => {
      let diagnostics = '';
      let spawnError: Error | null = null;
      child.stdout!.on('data', (data: Buffer) => {
        logger.info(`[firmware-update] ${data.toString().trim()}`);
      });
      child.stderr!.on('data', (data: Buffer) => {
        diagnostics = `${diagnostics}${data.toString()}`.slice(-4_096);
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code, signal) => {
        if (this.updateChild === child) this.updateChild = null;
        if (code === 0) resolve();
        else reject(new Error(
          spawnError?.message
          || diagnostics.trim()
          || `firmware updater exited with ${code ?? signal ?? 'an unknown status'}`,
        ));
      });
    });
  }

  private terminateChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKill);
        resolve();
      };
      const forceKill = setTimeout(() => this.signalProcessGroup(child, 'SIGKILL'), 2_000);
      child.once('exit', finish);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      this.signalProcessGroup(child, 'SIGTERM');
    });
  }

  private signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(`[DeviceSyncService] Could not send ${signal}:`, error);
      }
    }
  }
}
