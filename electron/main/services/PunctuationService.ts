import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import { resolveModelPackPath } from './ModelPackService';

const FORMAT_TIMEOUT_MS = 150;

interface WorkerResponse {
  id: string;
  text: string;
  error?: string | null;
}

interface PendingRequest {
  resolve: (text: string) => void;
  fallback: string;
  timer: NodeJS.Timeout;
}

interface WorkerLaunch {
  command: string;
  args: string[];
  label: string;
}

function punctuationWorkerLaunch(): WorkerLaunch {
  if (!process.env.MEMO_PNC_ENGINE || process.env.MEMO_PNC_ENGINE === 'distilbert') {
    const bundle = resolveModelPackPath('pnc');
    const compiled = path.join(bundle, 'compiled');
    const modelName = fs.readdirSync(compiled).find((name) => name.endsWith('.mlmodelc'));
    if (!modelName) throw new Error('compiled PnC model is missing');
    return {
      command: path.join(bundle, 'memo-pnc'),
      args: [
        '--model-path', path.join(compiled, modelName),
        '--vocabulary-path', path.join(bundle, 'tokenizer.vocab'),
        '--worker',
      ],
      label: 'DistilBERT',
    };
  }
  if (process.env.MEMO_PNC_ENGINE !== 'edge') {
    throw new Error(`unsupported PnC engine: ${process.env.MEMO_PNC_ENGINE}`);
  }
  const root = process.cwd();
  const bundle = process.env.MEMO_EDGE_PNC_DIR || path.join(root, '.build', 'edge-punct-casing');
  return {
    command: path.join(bundle, 'venv', 'bin', 'python'),
    args: [
      path.join(root, 'scripts', 'python', 'edge-punct-worker.py'),
      '--model-path', path.join(bundle, 'model', 'model.int8.onnx'),
      '--vocabulary-path', path.join(bundle, 'model', 'bpe.vocab'),
      '--worker',
    ],
    label: 'Edge-Punct-Casing',
  };
}

export class PunctuationService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private pending = new Map<string, PendingRequest>();

  start(): void {
    if (this.process) return;
    try {
      const launch = punctuationWorkerLaunch();
      this.process = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });

      const child = this.process;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => { if (this.process === child) this.handleLine(line, launch.label); });
      this.process.stderr.on('data', (chunk) => logger.debug(`[PunctuationService] ${String(chunk).trim()}`));
      child.stdin.on('error', (error) => { if (this.process === child) this.handleExit(error); });
      child.once('error', (error) => { if (this.process === child) this.handleExit(error); });
      child.once('exit', (code, signal) => {
        if (this.process === child) this.handleExit(new Error(`worker exited (${code ?? signal})`));
      });
    } catch (error) {
      logger.warn('[PunctuationService] Unavailable; using raw conomo text:', error);
      this.process = null;
    }
  }

  stop(): void {
    this.ready = false;
    this.process?.kill();
    this.process = null;
    this.resolvePending();
  }

  async format(text: string): Promise<string> {
    // NVIDIA's checkpoint expects lowercase English without sentence punctuation.
    // Preserve already-formatted output from Whisper or future cased ASR models.
    if (/\p{Lu}/u.test(text) || /[.!?](?:\s|$)/u.test(text)) return text;
    if (!text || !this.ready || !this.process?.stdin.writable) return text;
    const id = randomUUID();
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn(`[PunctuationService] Formatting exceeded ${FORMAT_TIMEOUT_MS} ms; using raw text`);
        resolve(text);
      }, FORMAT_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, fallback: text, timer });
      this.process!.stdin.write(`${JSON.stringify({ id, text })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(text);
      });
    });
  }

  private handleLine(line: string, label: string): void {
    if (line === 'READY') {
      this.ready = true;
      logger.info(`[PunctuationService] ${label} punctuation and capitalization ready`);
      return;
    }
    try {
      const response = JSON.parse(line) as WorkerResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) logger.warn(`[PunctuationService] Worker rejected transcript: ${response.error}`);
      pending.resolve(response.error || typeof response.text !== 'string' || !response.text.trim()
        ? pending.fallback : response.text);
    } catch (error) {
      logger.warn('[PunctuationService] Invalid worker response:', error);
    }
  }

  private handleExit(error: Error): void {
    if (this.process) logger.warn('[PunctuationService] Worker stopped; using raw text:', error);
    this.ready = false;
    const child = this.process;
    this.process = null;
    child?.kill();
    this.resolvePending();
  }

  private resolvePending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(pending.fallback);
    }
    this.pending.clear();
  }
}
