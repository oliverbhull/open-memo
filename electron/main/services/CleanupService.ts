import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CleanupState } from '../../shared/electron-api';
import { logger } from '../utils/logger';

/** A deadline, not a delay: completed text is delivered immediately. */
export function cleanupTimeoutMs(text: string): number {
  const words = text.trim().split(/\s+/u).length;
  return Math.min(5000, Math.max(750, 350 + words * 12));
}

type CleanupStatus = 'accepted' | 'fallback';

interface WorkerResponse {
  id: string;
  text: string;
  candidate_text?: string;
  error_detail?: string;
  status: CleanupStatus;
  reason?: string;
  latency_ms?: number;
  stage_ms?: Record<string, number>;
}

export interface CleanupResult {
  text: string;
  status: CleanupStatus;
  reason?: string;
  candidateText?: string;
  model?: string;
  contract?: string;
  latencyMs?: number;
  stageMs?: Record<string, number>;
}

interface PendingRequest {
  resolve: (result: CleanupResult) => void;
  fallback: string;
  deadline: number;
  timer: NodeJS.Timeout;
}

interface CleanupPaths {
  python: string;
  worker: string;
  model: string;
  adapter?: string;
  checkpoint?: string;
}

function cleanupPaths(): CleanupPaths {
  if (app.isPackaged) {
    const bundle = path.join(process.resourcesPath, 'cleanup');
    return {
      python: path.join(bundle, 'runtime', 'bin', 'python'),
      worker: path.join(bundle, 'worker', 'transcript-cleanup-worker.py'),
      model: path.join(bundle, 'model'),
    };
  }
  const root = process.cwd();
  const fusedModel = process.env.MEMO_CLEANUP_FUSED_MODEL || path.join(
    root,
    '.build',
    'transcript-cleanup-dataset',
    'experiments',
    'lfm2.5-1.2b-lora-v1',
    'hybrid-v5',
    'fused-step-1024-6bit',
  );
  const useFused = process.env.MEMO_CLEANUP_USE_UNFUSED !== '1' &&
    fs.existsSync(path.join(fusedModel, 'model.safetensors'));
  const adapter = process.env.MEMO_CLEANUP_ADAPTER || path.join(
    root,
    '.build',
    'transcript-cleanup-dataset',
    'experiments',
    'lfm2.5-1.2b-lora-v1',
    'hybrid-v5',
    'adapter-bf16',
  );
  return {
    python: process.env.MEMO_CLEANUP_PYTHON || path.join(
      root,
      '.build',
      'cleanup-runtime',
      'bin',
      'python',
    ),
    worker: path.join(root, 'scripts', 'python', 'transcript-cleanup-worker.py'),
    model: useFused ? fusedModel : process.env.MEMO_CLEANUP_MODEL || path.join(
      root,
      '.build',
      'models',
      'LFM2.5-1.2B-Instruct-MLX-8bit',
    ),
    adapter: useFused ? undefined : adapter,
    checkpoint: useFused ? undefined : process.env.MEMO_CLEANUP_CHECKPOINT || path.join(
      adapter,
      '0001024_adapters.safetensors',
    ),
  };
}

export class CleanupService extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private state: CleanupState = { available: false, status: 'disabled' };
  private pending = new Map<string, PendingRequest>();
  private stopping = false;
  private startupTimer?: NodeJS.Timeout;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();

  isEnabled(): boolean { return process.platform === 'darwin'; }

  getState(): CleanupState {
    return { ...this.state };
  }

  start(): void {
    if (this.process || !this.isEnabled()) return;
    const paths = cleanupPaths();
    const required = [
      paths.python,
      paths.worker,
      path.join(paths.model, 'model.safetensors'),
      path.join(paths.model, 'memo-cleanup-model.json'),
      ...(paths.adapter && paths.checkpoint
        ? [path.join(paths.adapter, 'adapter_config.json'), paths.checkpoint]
        : []),
    ];
    if (!required.every((item) => fs.existsSync(item))) {
      this.setState({
        available: false,
        status: 'unavailable',
        detail: 'Cleanup model files are missing.',
      });
      logger.warn('[CleanupService] Cleanup assets are incomplete; retaining original speech');
      return;
    }

    this.stopping = false;
    this.setState({ available: true, status: 'loading' });
    const workerArgs = [
      '-B',
      paths.worker,
      '--model', paths.model,
    ];
    if (paths.adapter && paths.checkpoint) {
      workerArgs.push('--adapter', paths.adapter, '--adapter-file', paths.checkpoint);
    }
    this.process = spawn(paths.python, workerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });

    const worker = this.process;
    this.startupTimer = setTimeout(() => {
      if (this.process === worker) this.handleExit(new Error('worker startup timed out'));
    }, 30_000);
    this.startupTimer.unref();
    let buffer = Buffer.alloc(0);
    worker.stdout.on('data', (chunk: Buffer) => {
      if (this.process !== worker) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 262_144) {
        this.handleExit(new Error('worker response exceeded frame bound'));
        return;
      }
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        this.handleLine(line);
        if (this.process !== worker) return;
      }
    });
    this.process.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) logger.debug(`[CleanupService] ${message}`);
    });
    worker.once('error', (error) => { if (this.process === worker) this.handleExit(error); });
    worker.stdin.on('error', (error) => { if (this.process === worker) this.handleExit(error); });
    worker.once('exit', (code, signal) => {
      if (this.process !== worker) return;
      this.handleExit(new Error(`worker exited (${code ?? signal})`));
    });
  }

  stop(): void {
    clearTimeout(this.startupTimer);
    this.generation += 1;
    this.stopping = true;
    const worker = this.process;
    this.process = null;
    worker?.kill();
    this.resolvePending('worker_stopped');
    this.setState({ available: false, status: 'disabled' });
  }

  async format(text: string, vocabulary: string[]): Promise<CleanupResult> {
    const generation = this.generation;
    const job = this.queue.then(async (): Promise<CleanupResult> => {
      if (!this.isEnabled()) return { text, status: 'fallback', reason: 'candidate_unavailable' };
      if (generation !== this.generation) return { text, status: 'fallback', reason: 'worker_stopped' };
      if (!text.trim() || text.length > 20_000 || vocabulary.length > 500 ||
          vocabulary.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) return { text, status: 'fallback', reason: 'input_bounds' };
      this.start();
      const result = await this.formatOne(text, vocabulary);
      return { ...result, model: cleanupPaths().model, contract: 'memo-lfm-hybrid-v3-plain-text' };
    });
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }

  private async formatOne(text: string, vocabulary: string[]): Promise<CleanupResult> {
    if (!text || this.state.status !== 'ready' || !this.process?.stdin.writable) {
      return { text, status: 'fallback', reason: 'not_ready' };
    }
    const id = randomUUID();
    const timeoutMs = cleanupTimeoutMs(text);
    logger.debug(`[CleanupService] input_words=${text.trim().split(/\s+/u).length} deadline_ms=${timeoutMs}`);
    return new Promise<CleanupResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn(`[CleanupService] Formatting exceeded ${timeoutMs} ms; retaining original speech`);
        const expired = this.process;
        this.process = null;
        expired?.kill('SIGKILL');
        this.setState({ available: false, status: 'unavailable', detail: 'Cleanup timed out; original speech was retained.' });
        resolve({ text, status: 'fallback', reason: 'timeout' });
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, fallback: text, deadline: performance.now() + timeoutMs, timer });
      this.process!.stdin.write(`${JSON.stringify({ id, text, vocabulary })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ text, status: 'fallback', reason: 'write_failed' });
      });
    });
  }

  private handleLine(line: string): void {
    try {
      const response = JSON.parse(line) as WorkerResponse & { type?: string };
      if (!response || typeof response !== 'object') throw new Error('invalid response');
      if (response.type === 'ready' && this.state.status === 'loading') {
        clearTimeout(this.startupTimer);
        this.setState({ available: true, status: 'ready' });
        logger.info('[CleanupService] LFM cleanup ready');
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (performance.now() > pending.deadline) {
        pending.resolve({ text: pending.fallback, status: 'fallback', reason: 'timeout' });
        this.handleExit(new Error('worker response arrived after deadline'));
        return;
      }
      if (response.status !== 'accepted' || typeof response.text !== 'string' || !response.text.trim() || response.text.length > Math.max(pending.fallback.length * 2, 256)) {
        logger.info(`[CleanupService] Candidate rejected (${response.reason || 'unknown'}); retaining original speech`);
        if (response.error_detail) logger.debug(`[CleanupService] Failure detail: ${JSON.stringify(response.error_detail)}`);
        pending.resolve({
          text: pending.fallback,
          status: 'fallback',
          reason: response.reason || 'rejected',
          candidateText: typeof response.candidate_text === 'string' && response.candidate_text.length <= 40_000 ? response.candidate_text : undefined,
          latencyMs: response.latency_ms,
          stageMs: response.stage_ms,
        });
        return;
      }
      pending.resolve({
        text: response.text,
        status: 'accepted',
        candidateText: typeof response.candidate_text === 'string' && response.candidate_text.length <= 40_000 ? response.candidate_text : undefined,
        latencyMs: response.latency_ms,
        stageMs: response.stage_ms,
      });
    } catch {
      logger.warn('[CleanupService] Ignored an invalid worker response');
    }
  }

  private handleExit(error: Error): void {
    if (!this.process && this.stopping) return;
    clearTimeout(this.startupTimer);
    const worker = this.process;
    this.process = null;
    worker?.kill('SIGKILL');
    this.resolvePending('worker_exited');
    this.setState({
      available: false,
      status: 'unavailable',
      detail: 'The local cleanup process stopped.',
    });
    logger.warn('[CleanupService] Worker unavailable; retaining original speech:', error);
  }

  private resolvePending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ text: pending.fallback, status: 'fallback', reason });
    }
    this.pending.clear();
  }

  private setState(state: CleanupState): void {
    this.state = state;
    this.emit('state-changed', this.getState());
  }
}
