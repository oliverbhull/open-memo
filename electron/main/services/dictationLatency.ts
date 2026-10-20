import fs from 'node:fs';
import path from 'node:path';

export interface DictationLatency {
  recordingId: string;
  backend: string;
  releaseToTextMs: number;
  releaseToFinalMs: number;
  finalToTextMs: number;
  audioDurationMs: number;
  fallbackUsed: boolean;
  origin: 'native-release';
  delivery: string;
  recordedAt: string;
}

/** Sum durations from separate monotonic clocks; never subtract process timestamps.
 * Native stdout transit is omitted, normally milliseconds. Paste means paste was
 * dispatched, not acknowledgement that another application rendered the text.
 */
export function calculateDictationLatency(
  context: Record<string, unknown> | undefined,
  receivedAt: number | undefined,
  deliveredAt: number,
  delivery: string,
): DictationLatency | null {
  const timing = context?.dictationTiming as Record<string, unknown> | undefined;
  if (!timing || !Number.isFinite(receivedAt) || !Number.isFinite(deliveredAt)) return null;
  const { recordingId, backend, releaseToFinalMs, audioDurationMs } = timing;
  if (typeof recordingId !== 'string' || typeof backend !== 'string' ||
      typeof releaseToFinalMs !== 'number' || !Number.isFinite(releaseToFinalMs) || releaseToFinalMs < 0 ||
      typeof audioDurationMs !== 'number' || !Number.isFinite(audioDurationMs) || audioDurationMs < 0 ||
      deliveredAt < receivedAt!) return null;
  const finalToTextMs = deliveredAt - receivedAt!;
  return {
    recordingId, backend, releaseToFinalMs, audioDurationMs, finalToTextMs,
    releaseToTextMs: releaseToFinalMs + finalToTextMs,
    fallbackUsed: timing.fallbackUsed === true,
    origin: 'native-release', delivery, recordedAt: new Date().toISOString(),
  };
}

/** Bounded timing-only log. No transcript, microphone samples, or app names. */
export function saveDictationLatency(directory: string, record: DictationLatency): void {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'dictation-latency.jsonl');
  if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
    fs.renameSync(file, path.join(directory, 'dictation-latency.previous.jsonl'));
  }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}
