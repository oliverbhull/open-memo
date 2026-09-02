import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const main = fs.readFileSync(path.join(root, 'electron', 'main', 'index.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'PunctuationService.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'sidecars', 'pnc', 'main.swift'), 'utf8');

test('punctuation formatting runs before user phrase replacements', () => {
  const formatting = main.indexOf('await punctuationService.format(normalized)');
  const phrases = main.indexOf('applyPhraseReplacements(formatted');
  assert.ok(formatting >= 0 && phrases > formatting);
});

test('punctuation formatting fails open within a bounded time', () => {
  assert.match(service, /const FORMAT_TIMEOUT_MS = 150/);
  assert.match(service, /pending\.resolve\(pending\.fallback\)/);
  assert.match(service, /if \(!text \|\| !this\.ready/);
});

test('already formatted ASR output bypasses the lowercase-only model', () => {
  assert.match(service, /\\p\{Lu\}/);
  assert.match(service, /\[\.!\?\]/);
});

test('worker warms Core ML before advertising readiness', () => {
  const warmup = worker.indexOf('_ = try runtime.format("memo is ready")');
  const ready = worker.indexOf('print("READY")');
  assert.ok(warmup >= 0 && ready > warmup);
});

test('worker only changes capitalization and trailing punctuation', () => {
  assert.match(worker, /word\.replaceSubrange/);
  assert.match(worker, /word \+= mark/);
});
