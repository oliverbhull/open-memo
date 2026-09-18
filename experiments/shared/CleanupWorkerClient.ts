import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 262144;
export interface CleanupResult {
  text: string;
  status: 'accepted' | 'fallback';
  reason?: string;
  candidateText?: string;
  latencyMs?: number;
  model?: string;
  contract?: string;
}

/** One active generation. Dead workers cannot mutate a replacement worker's state. */
export class CleanupWorkerClient extends EventEmitter {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private model: string | null = null;
  private startup?: NodeJS.Timeout;
  private pending?: { id: string; raw: string; started: number; deadline: number; timer: NodeJS.Timeout; resolve: (r: CleanupResult) => void };
  constructor(private readonly command: string, private readonly args: string[], private readonly timeoutMs = 750, private readonly startupMs = 30000, private readonly contract = 'memo-clean-v1') { super(); }

  start(): void {
    if (this.worker) return;
    const worker = spawn(this.command, this.args, { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    this.worker = worker;
    this.emit('state', 'loading');
    this.startup = setTimeout(() => this.fail(worker, 'startup_timeout'), this.startupMs);
    let buffer = Buffer.alloc(0);
    worker.stdout.on('data', (chunk: Buffer) => {
      if (this.worker !== worker) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) { this.fail(worker, 'frame_bounds'); return; }
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        this.receive(worker, line);
        if (this.worker !== worker) return;
      }
    });
    worker.stderr.resume(); // No raw transcript/model stderr in application logs.
    worker.stdin.on('error', () => this.fail(worker, 'write_failed'));
    worker.once('error', () => this.fail(worker, 'worker_error'));
    worker.once('exit', () => this.fail(worker, 'worker_exited'));
  }

  stop(): void {
    if (this.worker) this.fail(this.worker, 'worker_stopped');
  }

  format(text: string, vocabulary: string[]): Promise<CleanupResult> {
    const fallback = (reason: string): Promise<CleanupResult> => Promise.resolve({ text, status: 'fallback', reason });
    if (!text || text.length > 20000 || vocabulary.length > 500 || vocabulary.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) return fallback('input_bounds');
    if (this.pending) return fallback('busy');
    if (!this.worker || !this.model) {
      this.start(); // Prewarmed normally; this request does not wait for a restart.
      return fallback('not_ready');
    }
    const worker = this.worker;
    const id = randomUUID();
    const frame = JSON.stringify({ protocol: 1, id, text, vocabulary, deadline_unix_ms: Date.now() + this.timeoutMs }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) return fallback('frame_bounds');
    return new Promise(resolve => {
      const started = performance.now();
      this.pending = { id, raw: text, started, deadline: started + this.timeoutMs, resolve,
        timer: setTimeout(() => this.fail(worker, 'timeout'), this.timeoutMs) };
      worker.stdin.write(frame, error => { if (error) this.fail(worker, 'write_failed'); });
    });
  }

  private receive(worker: ChildProcessWithoutNullStreams, line: string): void {
    try {
      const r = JSON.parse(line);
      if (!r || typeof r !== 'object' || r.protocol !== 1 || r.contract !== this.contract) throw new Error();
      if (!this.model) {
        if (r.type !== 'ready' || typeof r.model !== 'string' || !r.model) throw new Error();
        this.model = r.model;
        clearTimeout(this.startup);
        this.emit('state', 'ready');
        return;
      }
      const pending = this.pending;
      if (!pending || r.id !== pending.id || r.model !== this.model) throw new Error();
      if (performance.now() > pending.deadline) { this.fail(worker, 'timeout'); return; }
      if (r.status !== 'accepted' && r.status !== 'fallback') throw new Error();
      if (r.status === 'accepted' && (r.raw !== pending.raw || typeof r.selected !== 'string' || !r.selected.trim() || r.selected.length > 24000)) throw new Error();
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ text: r.status === 'accepted' ? r.selected : pending.raw,
        status: r.status, reason: typeof r.reason === 'string' ? r.reason : 'worker_fallback',
        candidateText: typeof r.candidate === 'string' && r.candidate.length <= 24000 ? r.candidate : undefined,
        latencyMs: performance.now() - pending.started, model: this.model, contract: this.contract });
    } catch { this.fail(worker, 'invalid_response'); }
  }

  private fail(worker: ChildProcessWithoutNullStreams, reason: string): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.model = null;
    clearTimeout(this.startup);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ text: pending.raw, status: 'fallback', reason });
    }
    // Kill the native annotation child too; expired work must not leave an orphan.
    try {
      if (process.platform !== 'win32' && worker.pid) process.kill(-worker.pid, 'SIGKILL');
      else worker.kill('SIGKILL');
    } catch { /* Already exited. */ }
    this.emit('state', 'unavailable', reason);
  }
}
