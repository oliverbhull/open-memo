import { resolveTranscriptionText, type TranscriptionTextFields } from '../../shared/transcription';
import { detectEmailTarget, formatEmailLineBreaks, preserveEmailOpening } from './emailFormatting';
import { captureGroqCleanupConsent, cleanupWithGroq, type CleanupResult } from './GroqService';
import { applyPhraseReplacements } from './phraseReplacement';
import type { Settings } from './SettingsService';
import { formatDictationForPaste, normalizeTranscriptionText, stripLeadingDashSpace, stripTrailingEnter } from './textProcessing';
import { applyVocabularySpelling } from './vocabularyProtection';

/** Start destination detection before the delivery waits in the queue. */
export function captureDictationCleanup(emailEnabled: boolean) {
  const consent = captureGroqCleanupConsent();
  if (!consent) return undefined;
  return {
    consent,
    emailTarget: emailEnabled ? detectEmailTarget().catch(() => false) : Promise.resolve(false),
  };
}

export async function formatRecordedDictation(
  data: TranscriptionTextFields,
  settings: Pick<Settings, 'sayEnterToPressEnter' | 'vocabWords' | 'phraseReplacements'>,
  cleanup: ReturnType<typeof captureDictationCleanup>,
  senderName: string | undefined,
  formatLocally: (text: string) => Promise<string>,
) {
  const normalized = normalizeTranscriptionText(stripLeadingDashSpace(resolveTranscriptionText(data)));
  const asSpoken = data.rawTranscript?.trim() ? data.rawTranscript : normalized;
  let provenance: (Omit<CleanupResult, 'text' | 'candidateText'> & {
    asSpoken: string;
    cleanupInput: string;
    candidate?: string;
    selected: string;
  }) | undefined;

  const result = await formatDictationForPaste(normalized, settings.sayEnterToPressEnter, async input => {
    if (!input) return input;
    let formatted: string | undefined;
    let signEmail = false;
    if (cleanup && !cleanup.consent.aborted) {
      const email = await cleanup.emailTarget;
      // Keep a spoken email closing that the native ordinary dictation path may strip.
      const cleanupInput = email
        ? stripTrailingEnter(stripLeadingDashSpace(asSpoken), settings.sayEnterToPressEnter).textToPaste
        : input;
      const { text, candidateText, ...metadata } = await cleanupWithGroq(
        cleanupInput, settings.vocabWords, email ? 'email' : 'plain', cleanup.consent,
      );
      if (metadata.status === 'accepted') {
        signEmail = email;
        formatted = email ? preserveEmailOpening(formatEmailLineBreaks(text), cleanupInput) : text;
      }
      provenance = { ...metadata, asSpoken, cleanupInput, candidate: candidateText, selected: formatted ?? text };
    }
    const spelled = applyVocabularySpelling(formatted ?? await formatLocally(input), settings.vocabWords);
    const signed = signEmail ? formatEmailLineBreaks(spelled, senderName) : spelled;
    if (provenance?.status === 'accepted') provenance.selected = signed;
    return applyPhraseReplacements(signed, settings.phraseReplacements);
  });

  return { ...result, asSpoken, provenance };
}
