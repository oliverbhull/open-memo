import { FeedEntryData, AppContext } from '../components/FeedEntry';
import { MemoEntry } from '../types/storage';
import { logger } from './logger';
import type { AudioAttachment } from '../../../shared/electron-api';

interface ValidTranscriptionData {
  id?: string;
  rawTranscript?: string;
  processedText?: string;
  wasProcessedByLLM?: boolean;
  appContext?: AppContext;
  timestamp?: number;
  audio?: AudioAttachment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that an object has the required properties of AppContext
 */
export function isValidAppContext(obj: unknown): obj is AppContext {
  return (
    isRecord(obj) &&
    typeof obj.appName === 'string' &&
    typeof obj.windowTitle === 'string' &&
    obj.appName.length > 0 &&
    (obj.bundleId === undefined || typeof obj.bundleId === 'string')
  );
}

/**
 * Validates incoming transcription data from memo-stt
 */
export function validateTranscriptionData(data: unknown): data is ValidTranscriptionData {
  if (!isRecord(data)) {
    return false;
  }

  // Must have at least one text field
  if (!data.processedText && !data.rawTranscript) {
    return false;
  }

  // If appContext is provided, it must be valid
  if (data.appContext && !isValidAppContext(data.appContext)) {
    return false;
  }

  if (data.audio && !(
    isRecord(data.audio) &&
    typeof data.audio.fileName === 'string' &&
    data.audio.mimeType === 'audio/wav' &&
    (data.audio.duration === undefined || (
      typeof data.audio.duration === 'number' &&
      Number.isFinite(data.audio.duration) &&
      data.audio.duration >= 0
    ))
  )) return false;

  return true;
}

/**
 * Validates a FeedEntryData object
 */
export function isValidEntry(entry: unknown): entry is FeedEntryData {
  return (
    isRecord(entry) &&
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.text === 'string' &&
    entry.text.length > 0 &&
    typeof entry.timestamp === 'number' &&
    entry.timestamp > 0 &&
    (!entry.appContext || isValidAppContext(entry.appContext))
  );
}

/**
 * Creates a validated FeedEntryData from raw transcription data.
 */
export function createValidEntry(
  data: unknown,
  id: string
): FeedEntryData | null {
  if (!validateTranscriptionData(data)) {
    logger.warn('Invalid transcription data:', data);
    return null;
  }

  const text = data.processedText || data.rawTranscript || '';
  if (!text.trim()) {
    logger.warn('Empty transcription text');
    return null;
  }

  if (data.audio && data.audio.fileName !== `${id}.wav`) {
    return null;
  }

  return {
    id,
    text: text.trim(),
    timestamp: data.timestamp || Date.now(),
    rawTranscript: data.rawTranscript,
    wasProcessedByLLM: data.wasProcessedByLLM,
    appContext: data.appContext,
    audio: data.audio,
  };
}

/**
 * Converts FeedEntryData to MemoEntry for storage
 */
export function convertToMemoEntry(
  entry: FeedEntryData,
  deviceId: string
): MemoEntry {
  const now = Date.now();
  return {
    id: entry.id,
    deviceId,
    text: entry.text,
    createdAt: entry.timestamp || now,
    updatedAt: entry.timestamp || now,
    deletedAt: undefined,
    context: {
      source: 'desktop',
      rawTranscript: entry.rawTranscript,
      wasProcessedByLLM: entry.wasProcessedByLLM,
      appContext: entry.appContext,
      audio: entry.audio,
    },
  };
}

/**
 * Converts MemoEntry to FeedEntryData for UI
 */
export function convertToFeedEntry(entry: MemoEntry): FeedEntryData {
  const context = entry.context || {};
  return {
    id: entry.id,
    text: entry.text,
    timestamp: entry.createdAt,
    createdAt: entry.createdAt, // Include createdAt for compatibility
    rawTranscript: context.rawTranscript as string | undefined,
    wasProcessedByLLM: context.wasProcessedByLLM as boolean | undefined,
    appContext: context.appContext as AppContext | undefined,
    audio: context.audio as AudioAttachment | undefined,
    context: context, // Include full context for accessing mobile location data
  };
}
