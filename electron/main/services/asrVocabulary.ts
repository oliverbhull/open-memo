// Conomo's speech-context request accepts up to 256 phrases of 160 characters each.
export function asrVocabulary(words: string[] = []): string[] {
  return [...new Set(words.map(word => word.trim()).filter(
    word => word && !word.includes('\0') && Array.from(word).length <= 160,
  ))].slice(0, 256);
}
