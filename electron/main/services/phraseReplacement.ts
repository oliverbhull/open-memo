import { randomUUID } from 'node:crypto';
import type { PhraseReplacementRule } from './SettingsService';

export const MAX_PHRASE_REPLACEMENT_RULES = 50;

/** Word-like tokens: letters (with optional inner apostrophe) or digit runs. */
const TOKEN_RE = /[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*|\p{N}+/gu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenizeFind(find: string): string[] {
  const m = find.match(TOKEN_RE);
  return m ?? [];
}

function buildMatcherRegex(tokens: string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const body = tokens.map(escapeRegex).join('[^\\p{L}\\p{N}]*');
  return new RegExp(body, 'iu');
}

/**
 * Apply ordered phrase rules: case-insensitive, ignores punctuation/spacing between tokens.
 * Each rule replaces every non-overlapping occurrence (left-to-right, repeat until no match).
 */
export function applyPhraseReplacements(
  text: string,
  rules: PhraseReplacementRule[] | undefined
): string {
  if (!text || !rules?.length) return text;
  let out = text;
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const find = rule.find.trim();
    if (!find) continue;
    const tokens = tokenizeFind(find);
    if (tokens.length === 0) continue;
    const re = buildMatcherRegex(tokens);
    if (!re) continue;
    const replace = rule.replace;
    let guard = 0;
    while (guard++ < 1000) {
      re.lastIndex = 0;
      const m = re.exec(out);
      if (!m) break;
      const full = m[0];
      const idx = m.index;
      if (full === replace) break;
      out = out.slice(0, idx) + replace + out.slice(idx + full.length);
    }
  }
  return out;
}

/** Validate and cap rules from IPC / renderer before save. */
export function clampPhraseReplacementRulesFromInput(raw: unknown): PhraseReplacementRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PhraseReplacementRule[] = [];
  for (let i = 0; i < raw.length && out.length < MAX_PHRASE_REPLACEMENT_RULES; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const find = typeof r.find === 'string' ? r.find.trim() : '';
    if (!find) continue;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : randomUUID();
    const replace = typeof r.replace === 'string' ? r.replace : '';
    const enabled = r.enabled === false ? false : true;
    out.push({ id, find, replace, enabled });
  }
  return out;
}
