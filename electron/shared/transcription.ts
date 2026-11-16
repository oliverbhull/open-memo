export interface TranscriptionTextFields {
  rawTranscript?: string;
  processedText?: string;
}

/**
 * Prefer the native pipeline's processed text whenever it is present.
 *
 * An explicitly empty processed value is meaningful: the native pipeline can
 * suppress a no-speech artifact. Falling back on truthiness would resurrect
 * the raw artifact.
 */
export function resolveTranscriptionText(data: TranscriptionTextFields): string {
  return typeof data.processedText === 'string'
    ? data.processedText
    : (data.rawTranscript ?? '');
}
