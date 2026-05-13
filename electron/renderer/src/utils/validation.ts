import { FeedEntryData, AppContext } from '../components/FeedEntry';
import { MemoEntry } from '../types/storage';
import { logger } from './logger';

/**
 * Validates that an object has the required properties of AppContext
 */
export function isValidAppContext(obj: any): obj is AppContext {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.appName === 'string' &&
    typeof obj.windowTitle === 'string' &&
    obj.appName.length > 0
  );
}

/**
 * Validates incoming transcription data from memo-stt
 */
export function validateTranscriptionData(data: any): data is {
  id?: string;
  rawTranscript?: string;
  processedText?: string;
  wasProcessedByLLM?: boolean;
  appContext?: AppContext;
  timestamp?: number;
} {
  if (!data || typeof data !== 'object') {
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

  return true;
}

/**
 * Validates a FeedEntryData object
 */
export function isValidEntry(entry: any): entry is FeedEntryData {
  return (
    entry &&
    typeof entry === 'object' &&
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
 * Creates a validated FeedEntryData from raw transcription data
 * Returns legacy format for backward compatibility with UI components
 */
export function createValidEntry(
  data: any,
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

  return {
    id,
    text: text.trim(),
    timestamp: data.timestamp || Date.now(),
    rawTranscript: data.rawTranscript,
    wasProcessedByLLM: data.wasProcessedByLLM,
    appContext: data.appContext,
  };
}

/**
 * Converts FeedEntryData to MemoEntry for storage
 */
export async function convertToMemoEntry(
  entry: FeedEntryData,
  deviceId: string
): Promise<MemoEntry> {
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
    context: context, // Include full context for accessing mobile location data
  };
}


