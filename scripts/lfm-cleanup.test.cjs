const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { buildSync } = require('esbuild');

function loadService({ packaged = false, spawn } = {}) {
  const entry = path.resolve('electron/main/services/CleanupService.ts');
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (request, parent, isMain) => {
    if (request === 'electron') return { app: { isPackaged: packaged } };
    if (spawn && request === 'node:child_process') return { spawn };
    if (spawn && request === 'node:fs') return { ...fs, existsSync: () => true };
    return original(request, parent, isMain);
  };
  try { loaded._compile(compiled, entry); } finally { Module._load = original; }
  return loaded.exports.CleanupService;
}

function loadStoreDefaults() {
  const entry = path.resolve('electron/main/services/StoreSchema.ts');
  const compiled = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  loaded._compile(compiled, entry);
  return loaded.exports.storeDefaults;
}

function fakeWorker(handle) {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough();
  worker.stderr = new PassThrough();
  worker.kills = [];
  worker.reply = value => worker.stdout.write(JSON.stringify(value) + '\n');
  worker.stdin = new Writable({ write(chunk, _encoding, callback) { callback(); handle(JSON.parse(String(chunk)), worker); } });
  worker.kill = signal => { worker.kills.push(signal); return true; };
  queueMicrotask(() => worker.reply({ type: 'ready', prompt_version: 'memo-lfm-hybrid-v3' }));
  return worker;
}

function ready(service) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LFM did not become ready')), 30_000);
    const listener = state => {
      if (state.status !== 'ready' && state.status !== 'unavailable') return;
      clearTimeout(timer); service.off('state-changed', listener);
      state.status === 'ready' ? resolve() : reject(new Error(state.detail));
    };
    service.on('state-changed', listener); service.start();
  });
}

test('fresh installs default to Cleaned so the bundled LFM starts', () => {
  assert.equal(loadStoreDefaults().writingMode, 'clean');
});

test('packaged builds start the bundled LFM', async t => {
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = '/Applications/Memo.app/Contents/Resources';
  t.after(() => { process.resourcesPath = originalResourcesPath; });
  const Service = loadService({ packaged: true, spawn: (command, args) => {
    assert.match(command, /Resources\/cleanup\/runtime\/bin\/python$/);
    assert.equal(args[0], '-B');
    assert.match(args[1], /Resources\/cleanup\/worker\/transcript-cleanup-worker\.py$/);
    assert.match(args[3], /Resources\/cleanup\/model$/);
    return fakeWorker((request, child) => child.reply({ id: request.id, text: 'Cleaned.', status: 'accepted' }));
  } });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  assert.equal(service.isEnabled(), process.platform === 'darwin');
  if (process.platform === 'darwin') assert.equal((await service.format('Original.', [])).text, 'Cleaned.');
});

test('fused model receives raw speech; rapid requests and fallback stay ordered', async t => {
  const calls = []; let finish;
  const Service = loadService({ spawn: (command, args) => {
    if (process.env.MEMO_CLEANUP_PYTHON) assert.equal(command, process.env.MEMO_CLEANUP_PYTHON);
    else assert.match(command, /cleanup-runtime\/bin\/python$/);
    if (process.env.MEMO_CLEANUP_FUSED_MODEL) assert.equal(args[3], process.env.MEMO_CLEANUP_FUSED_MODEL);
    else assert.match(args[3], /hybrid-v5\/fused-step-1024-6bit$/);
    assert.equal(args.includes('--adapter'), false);
    return fakeWorker((request, child) => {
      calls.push(request);
      finish = () => child.reply({ id: request.id, text: 'Cleaned.', status: 'accepted', candidate_text: 'Cleaned.' });
    });
  } });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const order = [];
  const first = service.format('raw granite speech', ['Ramsey']).then(r => { order.push(1); return r; });
  const second = service.format('x'.repeat(20001), []).then(r => { order.push(2); return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []); assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'raw granite speech'); assert.deepEqual(calls[0].vocabulary, ['Ramsey']);
  finish();
  const results = await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]); assert.equal(results[0].text, 'Cleaned.');
  assert.equal(results[0].contract, 'memo-lfm-hybrid-v3-plain-text'); assert.equal(results[1].reason, 'input_bounds');
});

test('worker failure retains exact input and candidate evidence', async t => {
  const Service = loadService({ spawn: () => fakeWorker((r, child) => child.reply({ id: r.id, status: 'fallback', text: r.text, candidate_text: 'Incomplete draft.', reason: 'worker_error' })) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format('Original speech.', []);
  assert.equal(result.text, 'Original speech.'); assert.equal(result.candidateText, 'Incomplete draft.');
  assert.equal(result.reason, 'worker_error');
});

test('long speech can finish after 750 ms without delaying an earlier completion', async t => {
  const Service = loadService({ spawn: () => fakeWorker((r, child) => {
    setTimeout(() => child.reply({ id: r.id, text: 'Complete long dictation.', status: 'accepted' }), 850);
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format('word '.repeat(100), []);
  assert.equal(result.status, 'accepted');
  assert.equal(result.text, 'Complete long dictation.');
});

test('timeout kills expired work; old exit cannot disable the replacement', async t => {
  const workers = [];
  const Service = loadService({ spawn: () => { const worker = fakeWorker(() => {}); workers.push(worker); return worker; } });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const hold = setTimeout(() => {}, 2000); t.after(() => clearTimeout(hold));
  const result = await service.format('Keep this.', []);
  assert.equal(result.text, 'Keep this.'); assert.equal(result.reason, 'timeout');
  assert.deepEqual(workers[0].kills, ['SIGKILL']);
  await ready(service);
  workers[0].emit('exit', null, 'SIGKILL');
  assert.equal(service.getState().status, 'ready');
  const active = service.format('Active.', []);
  const queued = service.format('Queued.', []);
  await new Promise(resolve => setImmediate(resolve));
  service.stop();
  assert.equal((await active).text, 'Active.');
  assert.equal((await queued).reason, 'worker_stopped');
});

test('installed LFM cleans user-supplied dictation through the actual service', { skip: process.env.MEMO_LFM_SMOKE !== '1' }, async t => {
  const Service = loadService(); const service = new Service();
  t.after(() => service.stop()); await ready(service);
  const inputs = [
    'i can not tell if this is properly formatted is it',
    'I am getting together with Ramsey on Thursday, actually no Friday.',
    'all right i am testing this there seems to be a lot of latency with the final transcription appearing i think it is probably because the model is too big we are asking it to do too much it is appearing to clean my speech but i fear it is not adding any punctuation so that or capital letters or named entities so that is a problem',
  ];
  const rows = [];
  for (const input of inputs) {
    const result = await service.format(input, []);
    rows.push({ input, ...result });
    if (result.status === 'fallback') assert.equal(result.text, input);
    if (process.env.MEMO_CLEANUP_FUSED_MODEL) {
      assert.equal(result.model, process.env.MEMO_CLEANUP_FUSED_MODEL);
    } else {
      assert.match(result.model, /fused-step-1024-6bit$/);
    }
  }
  fs.mkdirSync('.build/lfm-hone', { recursive: true });
  fs.writeFileSync('.build/lfm-hone/live-smoke.json', JSON.stringify(rows, null, 2));
  assert.equal(rows[0].status, 'accepted'); assert.notEqual(rows[0].text, inputs[0]);
  // This real user paragraph previously fell back because the guard rejected "cleaning".
  assert.equal(rows[2].status, 'accepted'); assert.notEqual(rows[2].text, inputs[2]);

});


test('oversized worker output is bounded and preserves exact input', async t => {
  let child;
  const Service = loadService({ spawn: () => {
    child = fakeWorker(() => child.stdout.write('x'.repeat(262145)));
    return child;
  } });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format(' Original. ', []);
  assert.equal(result.text, ' Original. ');
  assert.equal(result.reason, 'worker_exited');
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('invalid technical output and vocabulary preserve original', async t => {
  const Service = loadService({ spawn: () => fakeWorker((r, child) => child.reply({
    id: r.id, status: 'accepted', text: 'x'.repeat(257), candidate_text: { invalid: true },
  })) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  assert.equal((await service.format('Original.', ['x'.repeat(201)])).reason, 'input_bounds');
  const result = await service.format('Original.', []);
  assert.equal(result.status, 'fallback');
  assert.equal(result.text, 'Original.');
  assert.equal(result.candidateText, undefined);
});
