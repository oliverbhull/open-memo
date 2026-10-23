const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync('electron/main/services/dictationLatency.ts', 'utf8'), {
  loader: 'ts', format: 'cjs',
}).code, { module: moduleUnderTest, exports: moduleUnderTest.exports, require, Date });
const { calculateDictationLatency } = moduleUnderTest.exports;

test('adds native release duration to receipt-to-delivery duration without mixing clock origins', () => {
  const result = calculateDictationLatency({ dictationTiming: {
    recordingId: '42', backend: 'nemotron-streaming', releaseToFinalMs: 1234,
    audioDurationMs: 8000, fallbackUsed: false, transcript: 'must not leak',
  } }, 900000, 900026, 'pasted');
  assert.equal(result.releaseToTextMs, 1260);
  assert.equal(result.finalToTextMs, 26);
  assert.equal(result.origin, 'native-release');
  assert.equal(JSON.stringify(result).includes('must not leak'), false);
});

test('keeps overlapping recordings independently correlated and reports fallback backend', () => {
  const make = (id, duration, fallbackUsed) => ({ dictationTiming: {
    recordingId: id, backend: fallbackUsed ? 'whisper-base' : 'nemotron-streaming',
    releaseToFinalMs: duration, audioDurationMs: 2000, fallbackUsed,
  } });
  const second = calculateDictationLatency(make('second', 50, false), 100, 110, 'clipboard_only');
  const first = calculateDictationLatency(make('first', 300, true), 90, 140, 'pasted');
  assert.equal(first.recordingId, 'first');
  assert.equal(first.releaseToTextMs, 350);
  assert.equal(first.fallbackUsed, true);
  assert.equal(second.recordingId, 'second');
  assert.equal(second.releaseToTextMs, 60);
});

test('rejects missing, malformed, nonfinite, and backward clock measurements', () => {
  assert.equal(calculateDictationLatency(undefined, 1, 2, 'pasted'), null);
  const context = { dictationTiming: {
    recordingId: '1', backend: 'whisper', releaseToFinalMs: 5, audioDurationMs: 100,
  } };
  for (const [receipt, end] of [[undefined, 2], [2, 1], [NaN, 5], [1, Infinity]]) {
    assert.equal(calculateDictationLatency(context, receipt, end, 'pasted'), null);
  }
  context.dictationTiming.releaseToFinalMs = -1;
  assert.equal(calculateDictationLatency(context, 1, 2, 'pasted'), null);
});
