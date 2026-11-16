export interface ProtectedVocabulary {
  text: string;
  restore(candidate: string): { ok: true; text: string } | { ok: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

let cachedVocabulary: string[] = [];
let cachedMatcher: ReturnType<typeof buildMatcher> | undefined;

function buildMatcher(vocabulary: string[]) {
  const canonicalTerms = new Map<string, string>();
  for (const value of vocabulary) {
    const term = value.trim();
    if (term && !canonicalTerms.has(term.toLocaleLowerCase())) {
      canonicalTerms.set(term.toLocaleLowerCase(), term);
    }
  }
  const terms = Array.from(canonicalTerms.values())
    .sort((left, right) => right.length - left.length);
  // Large Unicode regex alternations can take seconds to compile. Bound each
  // expression and cache the batches until the dictionary changes.
  const expressions: RegExp[] = [];
  for (let index = 0; index < terms.length; index += 128) {
    expressions.push(new RegExp(
      `(?<![\\p{L}\\p{N}])(?=(${terms.slice(index, index + 128).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}]))`,
      'giu',
    ));
  }
  return { canonicalTerms, expressions };
}

function replaceVocabularyMatches(
  text: string,
  vocabulary: string[],
  replace: (term: string) => string,
): string {
  // Keep only the current dictionary; compare contents because settings can
  // return a fresh array on each request or mutate an existing one.
  if (!cachedMatcher || vocabulary.length !== cachedVocabulary.length ||
      vocabulary.some((term, index) => term !== cachedVocabulary[index])) {
    cachedMatcher = buildMatcher(vocabulary);
    cachedVocabulary = [...vocabulary];
  }
  const { canonicalTerms, expressions } = cachedMatcher;
  const matches = expressions.flatMap(expression => Array.from(text.matchAll(expression)))
    .sort((left, right) => left.index! - right.index! || right[1]!.length - left[1]!.length);
  let offset = 0;
  let result = '';
  for (const match of matches) {
    const start = match.index!;
    const term = canonicalTerms.get(match[1]!.toLocaleLowerCase());
    if (start < offset || term === undefined) continue;
    result += text.slice(offset, start) + replace(term);
    offset = start + match[1]!.length;
  }
  return result + text.slice(offset);
}

/** Keep the user's spelling for vocabulary already present in the transcript. */
export function applyVocabularySpelling(text: string, vocabulary: string[]): string {
  return replaceVocabularyMatches(text, vocabulary, term => term);
}

/** Hide recognized vocabulary from cleanup until every placeholder is verified. */
export function protectVocabulary(text: string, vocabulary: string[]): ProtectedVocabulary {
  let nonce = 0;
  let markerPrefix = '';
  do {
    markerPrefix = `__MEMO_VOCAB_${nonce.toString(16).toUpperCase()}_`;
    nonce += 1;
  } while (text.includes(markerPrefix));

  const replacements: Array<{ marker: string; term: string }> = [];
  const protectedText = replaceVocabularyMatches(text, vocabulary, term => {
    const marker = `${markerPrefix}${replacements.length}__`;
    replacements.push({ marker, term });
    return marker;
  });

  return {
    text: protectedText,
    restore(candidate: string) {
      const markerExpression = new RegExp(
        `${escapeRegExp(markerPrefix)}\\d+__(?![\\p{L}\\p{N}_])`,
        'gu',
      );
      const presentMarkers = candidate.match(markerExpression) ?? [];
      if (presentMarkers.length !== replacements.length) return { ok: false };
      if (new Set(presentMarkers).size !== replacements.length) return { ok: false };
      let restored = candidate;
      for (const replacement of replacements) {
        if (occurrences(restored, replacement.marker) !== 1) return { ok: false };
        restored = restored.replace(replacement.marker, () => replacement.term);
      }
      if (markerExpression.test(restored)) return { ok: false };
      return { ok: true, text: restored };
    },
  };
}
