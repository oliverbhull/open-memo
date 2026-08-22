export interface TranscriptionTextFields {
  rawTranscript?: string;
  processedText?: string;
}

/**
 * Prefer the native pipeline's processed text whenever it is present.
 *
 * An explicitly empty processed value is meaningful: the native Whisper
 * cleanup uses it to suppress transcripts made up only of known artifacts
 * such as "Thank you" or "Thanks for watching". Falling back on truthiness
 * would resurrect the raw artifact.
 */
export function resolveTranscriptionText(data: TranscriptionTextFields): string {
  return typeof data.processedText === 'string'
    ? data.processedText
    : (data.rawTranscript ?? '');
}
