import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'sidecars', 'granite', 'main.swift'), 'utf8');
const service = fs.readFileSync(
  path.join(root, 'electron', 'main', 'services', 'MemoSttService.ts'),
  'utf8',
);
const audioPatch = fs.readFileSync(
  path.join(root, 'patches', 'memo-stt-0.1.1-audio-retention.patch'),
  'utf8',
);

test('Granite warms Core ML before advertising readiness', () => {
  const warmup = worker.indexOf('try runtime.warmup()');
  const ready = worker.indexOf('print("READY")');
  assert.ok(warmup >= 0 && ready > warmup);
});

test('Granite decodes Float16 logits through direct memory', () => {
  assert.match(worker, /logits\.dataType == \.float16/);
  assert.match(worker, /dataPointer\.bindMemory\(to: UInt16\.self/);
  assert.match(worker, /Float16\(bitPattern:/);
});

test('Granite transcribes completed windows during recording', () => {
  assert.match(worker, /while samples\.count >= maxSamples/);
  assert.match(worker, /runtime\.transcribeChunk\(Array\(samples\.prefix\(maxSamples\)\)\)/);
});

test('text emission never waits for an optional audio attachment', () => {
  assert.doesNotMatch(service, /setTimeout\(finish, 1_500\)/);
  assert.doesNotMatch(service, /audioWaiters/);
  assert.doesNotMatch(audioPatch, /\+\s+std::thread::spawn\(move \|\|/);
});
