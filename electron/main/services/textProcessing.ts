/** Remove a transcription model's occasional leading dash marker. */
export function stripLeadingDashSpace(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('-') ? trimmed.slice(1).trimStart() : trimmed;
}

/** Convert a trailing spoken "enter" into an explicit keypress instruction. */
export function stripTrailingEnter(
  text: string,
  enabled: boolean
): { textToPaste: string; pressEnter: boolean } {
  const trimmed = text.trim();
  if (!enabled || !trimmed) return { textToPaste: trimmed, pressEnter: false };

  const match = trimmed.match(/\s+enter\s*[,.]?\s*$/i);
  if (!match) return { textToPaste: trimmed, pressEnter: false };

  return {
    textToPaste: trimmed.slice(0, -match[0].length).trimEnd(),
    pressEnter: true,
  };
}
