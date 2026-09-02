import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const adapter = fs.readFileSync(
  path.join(root, 'sidecars', 'conomo-adapter', 'transcription_engine.rs'),
  'utf8',
);
const service = fs.readFileSync(
  path.join(root, 'electron', 'main', 'services', 'MemoSttService.ts'),
  'utf8',
);
const audioPatch = fs.readFileSync(
  path.join(root, 'patches', 'memo-stt-0.1.1-audio-retention.patch'),
  'utf8',
);

test('conomo is launched through the generic worker contract', () => {
  assert.match(adapter, /required_path\("MEMO_ASR_WORKER"\)/);
  assert.match(adapter, /\.arg\("--worker"\)/);
  assert.doesNotMatch(adapter, /MEMO_ASR_MODEL_PATH|MEMO_ASR_TOKENIZER_PATH/);
});

test('the application treats conomo as one opaque executable', () => {
  assert.match(service, /path\.join\(conomoRoot, 'conomo'\)/);
  assert.doesNotMatch(service, /mlmodel|tokenizer|quantization|architecture/i);
});

test('text emission never waits for an optional audio attachment', () => {
  assert.doesNotMatch(service, /setTimeout\(finish, 1_500\)/);
  assert.doesNotMatch(service, /audioWaiters/);
  assert.doesNotMatch(audioPatch, /\+\s+std::thread::spawn\(move \|\|/);
});
