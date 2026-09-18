import type { TranscriptionData } from './electron-api';
import type { MemoEntry } from './memo-entry';
import { resolveTranscriptionText } from './transcription';

/** Persist the delivered text alongside recognition and cleanup provenance. */
export function createDictationEntry(
  data: TranscriptionData & { id: string; timestamp: number },
  deviceId: string,
): MemoEntry {
  return {
    id: data.id,
    deviceId,
    text: resolveTranscriptionText(data),
    createdAt: data.timestamp,
    updatedAt: data.timestamp,
    context: {
      ...data.context,
      source: 'desktop',
      rawTranscript: data.rawTranscript,
      wasProcessedByLLM: data.wasProcessedByLLM,
      appContext: data.appContext,
      audio: data.audio,
    },
  };
}
