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
  const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron', './ModelPackService'], write: false }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const original = Module._load;
  Module._load = (request, parent, isMain) => {
    if (request === 'electron') return { app: { isPackaged: packaged } };
    if (request === './ModelPackService') return {
      resolveModelPackPath: () => '/Users/test/Library/Application Support/Memo/model-packs/cleanup/pack',
      isCleanupModelPackInstalled: () => true,
      installCleanupModelPack: async () => '/Users/test/Library/Application Support/Memo/model-packs/cleanup/pack',
    };
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
  queueMicrotask(() => worker.reply({ type: 'ready', prompt_version: 'memo-lfm-faithful-v1' }));
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

test('fresh installs default to As spoken so LFM is opt-in', () => {
  assert.equal(loadStoreDefaults().writingMode, 'as-spoken');
});

test('Cleaned remains selectable after As spoken stops the cleanup worker', () => {
  const settings = fs.readFileSync(path.resolve('electron/renderer/src/components/Settings.tsx'), 'utf8');
  assert.match(settings, /<option value="clean">Cleaned – 1\.03 GB model download<\/option>/);
  assert.doesNotMatch(settings, /disabled=\{cleanupState\.status === 'disabled'\}/);
});

test('packaged builds start the downloaded LFM', async t => {
  const Service = loadService({ packaged: true, spawn: (command, args) => {
    assert.match(command, /model-packs\/cleanup\/pack\/runtime\/bin\/python$/);
    assert.equal(args[0], '-B');
    assert.match(args[1], /model-packs\/cleanup\/pack\/worker\/transcript-cleanup-worker\.py$/);
    assert.match(args[3], /model-packs\/cleanup\/pack\/model$/);
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
  assert.equal(calls[0].text, 'raw granite speech'); assert.equal('vocabulary' in calls[0], false);
  finish();
  const results = await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]); assert.equal(results[0].text, 'Cleaned.');
  assert.equal(results[0].contract, 'memo-lfm-faithful-v2-ungated'); assert.equal(results[1].reason, 'input_bounds');
});

test('worker failure retains exact input and candidate evidence', async t => {
  const Service = loadService({ spawn: () => fakeWorker((r, child) => child.reply({ id: r.id, status: 'fallback', text: r.text, candidate_text: 'Incomplete draft.', reason: 'worker_error' })) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format('Original speech.', []);
  assert.equal(result.text, 'Original speech.'); assert.equal(result.candidateText, 'Incomplete draft.');
  assert.equal(result.reason, 'worker_error');
});

test('expanded input is rejected without sending or restarting the worker', async t => {
  const calls = []; let worker;
  const Service = loadService({ spawn: () => {
    worker = fakeWorker((request, child) => {
      calls.push(request);
      child.reply({ id: request.id, text: request.text, status: 'accepted' });
    });
    return worker;
  } });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const original = 'Rayaan '.repeat(1000);
  const result = await service.format(original, ['Rayaan']);
  assert.equal(result.reason, 'protected_input_bounds');
  assert.equal(result.text, original);
  assert.equal(calls.length, 0);
  assert.deepEqual(worker.kills, []);
  assert.equal(service.getState().status, 'ready');
  assert.equal((await service.format('rayaan', ['Rayaan'])).text, 'Rayaan');
  assert.equal(calls.length, 1);
});

test('large dictionaries stay local and vocabulary edits affect the next request', async t => {
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    assert.deepEqual(Object.keys(request).sort(), ['id', 'text']);
    child.reply({ id: request.id, text: request.text, status: 'accepted' });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const vocabulary = Array.from({ length: 10000 }, (_, index) => `Term${index}`);
  vocabulary.push('Rayaan');
  assert.equal((await service.format('rayaan met term9999', vocabulary)).text, 'Rayaan met Term9999');
  assert.equal((await service.format('rayaan', [...vocabulary])).text, 'Rayaan');
  vocabulary[vocabulary.length - 1] = 'RAYAAN';
  assert.equal((await service.format('rayaan', vocabulary)).text, 'RAYAAN');
  assert.equal((await service.format('rayaan', [])).text, 'rayaan');
});

test('cleanup preserves canonical vocabulary and rejects damaged placeholders', async t => {
  let damagePlaceholder = false;
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    const text = damagePlaceholder
      ? request.text.replace(/__MEMO_VOCAB_[A-F0-9]+_0__/, 'Rayon')
      : `Cleaned: ${request.text}`;
    child.reply({ id: request.id, text, candidate_text: text, status: 'accepted' });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const accepted = await service.format('rayaan met jtech', ['Rayaan', 'JTECH']);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.text, 'Cleaned: Rayaan met JTECH');
  damagePlaceholder = true;
  const fallback = await service.format('rayaan met jtech', ['Rayaan', 'JTECH']);
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.reason, 'vocabulary_protection');
  assert.equal(fallback.text, 'rayaan met jtech');
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
    { text: 'i can not tell if this is properly formatted is it', vocabulary: [] },
    { text: 'I am getting together with Ramsey on Thursday, actually no Friday.', vocabulary: [] },
    { text: 'all right i am testing this there seems to be a lot of latency with the final transcription appearing i think it is probably because the model is too big we are asking it to do too much it is appearing to clean my speech but i fear it is not adding any punctuation so that or capital letters or named entities so that is a problem', vocabulary: [] },
    { text: 'i met rayaan from jtech at suffolk', vocabulary: ['Rayaan', 'JTECH', 'Suffolk'] },
  ];
  const rows = [];
  for (const input of inputs) {
    const result = await service.format(input.text, input.vocabulary);
    rows.push({ input: input.text, vocabulary: input.vocabulary, ...result });
    if (result.status === 'fallback') assert.equal(result.text, input.text);
    if (process.env.MEMO_CLEANUP_FUSED_MODEL) {
      assert.equal(result.model, process.env.MEMO_CLEANUP_FUSED_MODEL);
    } else {
      assert.match(result.model, /fused-step-1024-6bit$/);
    }
  }
  fs.mkdirSync('.build/lfm-hone', { recursive: true });
  fs.writeFileSync('.build/lfm-hone/live-smoke.json', JSON.stringify(rows, null, 2));
  // Completed model output is delivered without a wording-similarity gate.
  for (const row of rows.slice(0, 3)) {
    assert.equal(row.status, 'accepted');
    assert.equal(row.reason, undefined);
    assert.equal(row.text, row.candidateText);
  }
  assert.equal(rows[3].status, 'accepted');
  assert.match(rows[3].text, /Rayaan/); assert.match(rows[3].text, /JTECH/); assert.match(rows[3].text, /Suffolk/);

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

test('email requests are scoped per dictation and preserve paragraph breaks', async t => {
  const requests = [];
  const email = 'Hi Sarah,\n\nPlease do not confirm yet.\n\nThanks,\nOliver';
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    requests.push(request);
    child.reply({ id: request.id, status: 'accepted', text: request.format === 'email' ? email : 'Normal text.' });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format('hi Sarah please do not confirm yet thanks Oliver', [], 'email');
  assert.equal(result.text, email);
  assert.equal(result.contract, 'memo-lfm-email-v4-profile-signature');
  await service.format('normal text', []);
  assert.equal(requests[0].format, 'email');
  assert.equal(requests[1].format, undefined);
  assert.equal(loadStoreDefaults().experimentalEmailFormatting, false);
});

test('email layout repairs a flat model response without affecting plain cleanup or vocabulary', async t => {
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    child.reply({ id: request.id, status: 'accepted', text: request.text });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const flat = 'Hi Jason, Great to be connected. Thanks, Oliver.';
  const email = await service.format(flat, ['Jason', 'Oliver'], 'email');
  assert.equal(email.text, 'Hi Jason,\n\nGreat to be connected.\n\nThanks,\nOliver');
  assert.equal((await service.format(flat, [])).text, flat);
  // Saved punctuation stays exact even when it is part of the signature.
  assert.equal((await service.format(flat, ['Oliver.'], 'email')).text, 'Hi Jason,\n\nGreat to be connected.\n\nThanks,\nOliver.');
});

test('installed LFM delivers formatted dictation without a wording gate and still formats email', { skip: process.env.MEMO_LFM_SMOKE !== '1' }, async t => {
  const Service = loadService(); const service = new Service();
  t.after(() => service.stop()); await ready(service);
  const source = "the system is actually working quite well but i am frustrated that when i dictate it is really changing what i say fundamentally and it is like i would say just like filtering it a little bit too much especially with longer transmission especially like especially with longer utterances like if i say a ton of words and speak for a while it just like dilutes it a lot like removes a lot of content";
  const result = await service.format(source, []);
  assert.equal(result.status, 'accepted');
  assert.equal(result.reason, undefined);
  assert.equal(result.text, result.candidateText);
  assert.notEqual(result.text, source);
  const email = await service.format('hi Jason great to be connected we will try to make this as easy as possible for you if you pick a time we will make it work thanks Oliver', [], 'email');
  assert.equal(email.status, 'accepted');
  assert.equal(email.text, 'Hi Jason,\n\nGreat to be connected. We’ll try to make this as easy as possible for you. If you pick a time, we’ll make it work.\n\nThanks,\nOliver');
  const signed = await service.format('hi Jason great to be connected please send the proposal thanks', [], 'email', 'Oliver Hull');
  assert.equal(signed.status, 'accepted');
  assert.match(signed.text, /\nOliver Hull$/);
  assert.doesNotMatch(signed.text, /Jamie/);
});

test('email signature uses the current supplied onboarding name, not model output', async t => {
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    child.reply({ id: request.id, status: 'accepted', text: 'Hi Jason, Great to be connected. Thanks, Jamie.' });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const first = await service.format('hi Jason great to be connected thanks', [], 'email', 'Oliver Hull');
  assert.equal(first.status, 'accepted');
  assert.equal(first.text, 'Hi Jason,\n\nGreat to be connected.\n\nThanks,\nOliver Hull');
  const second = await service.format('hi Jason great to be connected thanks', [], 'email', 'Aisha Khan');
  assert.match(second.text, /Thanks,\nAisha Khan$/);
  const plain = await service.format('hi Jason great to be connected thanks', [], 'plain', 'Oliver Hull');
  assert.equal(plain.text, 'Hi Jason, Great to be connected. Thanks, Jamie.');
});

test('email retains the dictated thank-you opening when LFM substitutes Hello', async t => {
  const Service = loadService({ spawn: () => fakeWorker((request, child) => {
    child.reply({ id: request.id, status: 'accepted', text: 'Hello Dimitri,\n\nThis is helpful.\n\nThanks,\nJamie' });
  }) });
  const service = new Service(); t.after(() => service.stop()); await ready(service);
  const result = await service.format('thanks dimitri this is helpful', [], 'email', 'Oliver');
  assert.equal(result.status, 'accepted');
  assert.equal(result.text, 'Thanks Dimitri,\n\nThis is helpful.\n\nThanks,\nOliver');
});
