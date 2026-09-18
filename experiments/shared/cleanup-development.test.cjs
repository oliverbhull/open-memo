const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const entry = path.resolve('experiments/shared/CleanupWorkerClient.ts');
const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(entry, module);
loaded.filename = entry;
loaded.paths = module.paths;
loaded._compile(compiled, entry);
const { CleanupWorkerClient } = loaded.exports;
const ready = client => new Promise((resolve, reject) => {
  const listener = (state, reason) => {
    if (state === 'ready') { client.off('state', listener); resolve(); }
    else if (state === 'unavailable') { client.off('state', listener); reject(new Error(reason)); }
  };
  client.on('state', listener);
  client.start();
});
const worker = path.resolve('experiments/clean-v1/worker.py');
const python = process.env.MEMO_CLEANUP_PYTHON || 'python3';

function fake(t, response, timeout = 200) {
  const script = `import sys,json,time\nprint(json.dumps(dict(type='ready',protocol=1,contract='memo-clean-v1',model='fake')),flush=True)\nr=json.loads(sys.stdin.readline())\n${response}`;
  const client = new CleanupWorkerClient(python, ['-c', script], timeout, 3000);
  t.after(() => client.stop());
  return client;
}

test('actual v1 worker crosses Node/Python deadline boundary and preserves literals', async t => {
  const client = new CleanupWorkerClient(python, [worker, '--identity'], 750, 3000);
  t.after(() => client.stop());
  await ready(client);
  for (const input of ['-12 degrees thanks', 'Hello 😀\nsecond paragraph.', 'Send $12.50.', 'say enter']) {
    const result = await client.format(input, []);
    assert.equal(result.status, 'accepted');
    assert.equal(result.text, input);
    assert.equal(result.contract, 'memo-clean-v1');
  }
  assert.equal((await client.format('literal ⟦x⟧', [])).status, 'fallback');
  assert.equal((await client.format('Still ready.', [])).status, 'accepted');
});

test('busy request falls back and timeout kills generation; restart handles new requests', async t => {
  const client = fake(t, 'time.sleep(2)', 30);
  await ready(client);
  const first = client.format('first', []);
  assert.equal((await client.format('second', [])).reason, 'busy');
  assert.equal((await first).reason, 'timeout');
  await ready(client);
  assert.equal((await client.format('third', [])).text, 'third');
});

test('malformed, stale, oversized and crashed responses preserve original', async t => {
  for (const response of ["print('bad json',flush=True)", "print('x'*270000,flush=True)", 'sys.exit(1)',
    "print(json.dumps(dict(protocol=1,contract='memo-clean-v1',model='fake',id='stale',status='accepted',raw='original',selected='bad')),flush=True)"]) {
    const client = fake(t, response);
    await ready(client);
    const result = await client.format('original', []);
    assert.equal(result.status, 'fallback');
    assert.equal(result.text, 'original');
  }
});

test('guard fallback preserves candidate provenance and selects original', async t => {
  const client = fake(t, "print(json.dumps(dict(protocol=1,contract='memo-clean-v1',model='fake',id=r['id'],status='fallback',reason='guard',candidate='unsafe')),flush=True)");
  await ready(client);
  const result = await client.format('original', []);
  assert.equal(result.text, 'original');
  assert.equal(result.candidateText, 'unsafe');
});

test('late valid response is never accepted', async t => {
  const client = fake(t, "time.sleep(.1)\nprint(json.dumps(dict(protocol=1,contract='memo-clean-v1',model='fake',id=r['id'],status='accepted',raw=r['text'],selected='changed')),flush=True)", 20);
  await ready(client);
  assert.equal((await client.format('original', [])).reason, 'timeout');
});

test('development startup omits the punctuation model and delivers the selected cleanup text', () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.doesNotMatch(scripts.dev, /build:pnc/);
  const main = fs.readFileSync('electron/main/index.ts', 'utf8');
  assert.match(main, /formatted = cleanup.text/);
  assert.match(main, /if \(app.isPackaged\) punctuationService.start\(\)/);
  assert.doesNotMatch(main, /Clean diagnostic source=/);
});

test('Clean input preserves sign-offs, negative values and questions while legacy suppression remains', () => {
  const source = path.resolve('electron/shared/transcription.ts');
  const js = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const m = new Module(source, module); m._compile(js, source);
  for (const raw of ['Thank you.', '-12 degrees', 'Why?', 'Hello\nthere.']) {
    assert.equal(m.exports.resolveCleanInput({ rawTranscript: raw, processedText: '' }), raw);
    assert.equal(m.exports.resolveTranscriptionText({ rawTranscript: raw, processedText: '' }), '');
  }
});

test('v2 formatting worker uses its own versioned contract', async t => {
  const client = new CleanupWorkerClient(python, [path.resolve('experiments/clean-v2/worker.py'), '--identity'], 750, 3000, 'memo-clean-v2-format-only');
  t.after(() => client.stop());
  await ready(client);
  const result = await client.format('-12 degrees thanks', []);
  assert.equal(result.status, 'accepted');
  assert.equal(result.text, '-12 degrees thanks');
});

test('validated local model formats text through live Node supervisor', { skip: process.env.MEMO_CLEANUP_MODEL_SMOKE !== '1' }, async t => {
  const client = new CleanupWorkerClient(python, [path.resolve('experiments/clean-v3/worker.py'), '--manifest', path.resolve('.build/clean-v3/LIVE.json')], 750, 30000, 'memo-clean-v3.1-annotations');
  t.after(() => client.stop());
  await ready(client);
  const result = await client.format('i am testing this it should work', []);
  assert.equal(result.status, 'accepted');
  assert.notEqual(result.text, 'i am testing this it should work');
  assert.equal(result.text.toLowerCase().replace(/[.,!?]/g, ''), 'i am testing this it should work');
  assert.equal(result.contract, 'memo-clean-v3.1-annotations');
});

test('candidate checksum mismatch prevents readiness', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'memo-clean-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = path.join(dir, 'payload');
  fs.writeFileSync(payload, 'changed');
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ contract: 'memo-clean-v2-format-only', status: 'internal_formatting_candidate', model: dir, sha256: { [payload]: 'incorrect' } }));
  const client = new CleanupWorkerClient(python, [path.resolve('experiments/clean-v2/worker.py'), '--manifest', manifest], 750, 3000, 'memo-clean-v2-format-only');
  t.after(() => client.stop());
  await assert.rejects(ready(client));
});
