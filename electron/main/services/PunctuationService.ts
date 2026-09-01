import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';

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

export class PunctuationService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private pending = new Map<string, PendingRequest>();

  start(): void {
    if (this.process) return;
    try {
      const bundle = app.isPackaged
        ? path.join(process.resourcesPath, 'pnc')
        : path.join(process.cwd(), '.build', 'pnc');
      const compiled = path.join(bundle, 'compiled');
      const modelName = fs.readdirSync(compiled).find((name) => name.endsWith('.mlmodelc'));
      if (!modelName) throw new Error('compiled PnC model is missing');
      const worker = path.join(bundle, 'memo-pnc');
      const vocabulary = path.join(bundle, 'tokenizer.vocab');
      this.process = spawn(worker, [
        '--model-path', path.join(compiled, modelName),
        '--vocabulary-path', vocabulary,
        '--worker',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      const lines = readline.createInterface({ input: this.process.stdout });
      lines.on('line', (line) => this.handleLine(line));
      this.process.stderr.on('data', (chunk) => logger.debug(`[PunctuationService] ${String(chunk).trim()}`));
      this.process.once('error', (error) => this.handleExit(error));
      this.process.once('exit', (code, signal) => this.handleExit(new Error(`worker exited (${code ?? signal})`)));
    } catch (error) {
      logger.warn('[PunctuationService] Unavailable; using raw Granite text:', error);
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

  private handleLine(line: string): void {
    if (line === 'READY') {
      this.ready = true;
      logger.info('[PunctuationService] DistilBERT punctuation and capitalization ready');
      return;
    }
    try {
      const response = JSON.parse(line) as WorkerResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) logger.warn(`[PunctuationService] Worker rejected transcript: ${response.error}`);
      pending.resolve(response.error || !response.text ? pending.fallback : response.text);
    } catch (error) {
      logger.warn('[PunctuationService] Invalid worker response:', error);
    }
  }

  private handleExit(error: Error): void {
    if (this.process) logger.warn('[PunctuationService] Worker stopped; using raw text:', error);
    this.ready = false;
    this.process = null;
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
