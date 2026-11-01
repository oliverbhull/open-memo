const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');

const compile = file => transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const compiled = compile('electron/main/services/GroqService.ts');
const API_KEY = 'gsk_test_0123456789';

function load(file) {
  const module = { exports: {} };
  vm.runInNewContext(compile(file), { module, exports: module.exports });
  return module.exports;
}
const vocabularyProtection = load('electron/main/services/vocabularyProtection.ts');
const textProcessing = load('electron/main/services/textProcessing.ts');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function chat(content, finish_reason = 'stop') {
  return json({ choices: [{ finish_reason, message: { content } }] });
}

function harness({ fetch, encrypted = 'unset', encryptionAvailable = true, settings = {} } = {}) {
  const values = {};
  const store = {
    get: key => values[key],
    set: (key, value) => { values[key] = value; },
  };
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: value => Buffer.from(`encrypted:${value}`).reverse(),
    decryptString: value => {
      const decoded = Buffer.from(value).reverse().toString();
      if (!decoded.startsWith('encrypted:')) throw new Error('Could not decrypt');
      return decoded.slice('encrypted:'.length);
    },
  };
  values.groqApiKeyEncrypted = encrypted === 'unset'
    ? safeStorage.encryptString(API_KEY).toString('base64') : encrypted;
  let saved = { groqEnabled: false, groqCleanupEnabled: true, saveAudio: false, ...settings };
  const logs = [];
  const log = (...parts) => logs.push(parts.join(' '));
  const requests = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, AbortController, AbortSignal, Blob, Buffer, FormData, Uint8Array, performance,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return fetch(url, init);
    },
    require: name => {
      if (name === 'electron') return { safeStorage };
      if (name === '../utils/logger') return { logger: { info: log, warn: log, error: log, debug: log } };
      if (name === './SettingsService') {
        return { store, loadSettings: () => ({ ...saved }), saveSettings: next => { saved = { ...next }; } };
      }
      if (name === './vocabularyProtection') return vocabularyProtection;
      if (name === './textProcessing') return textProcessing;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { groq: module.exports, values, requests, logs, settings: () => saved };
}

test('a key is tested with Groq and stored only in encrypted form', async () => {
  const { groq, values, requests, logs } = harness({ encrypted: null, fetch: async () => json({ data: [] }) });
  assert.equal(groq.hasGroqApiKey(), false);
  await groq.saveGroqApiKey(`  ${API_KEY}\n`);
  assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(groq.hasGroqApiKey(), true);
  assert.equal(Buffer.from(values.groqApiKeyEncrypted, 'base64').includes(API_KEY), false);
  assert.equal(values.groqApiKeyEncrypted.includes(API_KEY), false);
  assert.equal(logs.join('\n').includes(API_KEY), false);
  groq.removeGroqApiKey();
  assert.equal(groq.hasGroqApiKey(), false);
});

test('a rejected, malformed or unstorable key is never saved', async () => {
  const rejected = harness({ encrypted: null, fetch: async () => json({ error: {} }, 401) });
  await assert.rejects(rejected.groq.saveGroqApiKey(API_KEY), /rejected this API key/);
  assert.equal(rejected.groq.hasGroqApiKey(), false);

  const offline = harness({ encrypted: null, fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.groq.saveGroqApiKey(API_KEY), /Could not reach Groq/);
  assert.equal(offline.groq.hasGroqApiKey(), false);

  const malformed = harness({ encrypted: null, fetch: async () => json({}) });
  for (const key of ['', 'has space', 'kéy', null, 42]) {
    await assert.rejects(malformed.groq.saveGroqApiKey(key), /valid Groq API key/);
  }
  assert.equal(malformed.requests.length, 0);

  const insecure = harness({ encrypted: null, encryptionAvailable: false, fetch: async () => json({}) });
  await assert.rejects(insecure.groq.saveGroqApiKey(API_KEY), /store the key securely/);
  assert.equal(insecure.requests.length, 0);
});

test('turning Groq on also turns its cleanup on, and cleanup can then be turned off', () => {
  const { groq, settings } = harness({ fetch: async () => json({}), settings: { groqCleanupEnabled: false } });
  const on = groq.changeGroqEnabled(true);
  assert.equal(on.groqEnabled, true);
  assert.equal(on.groqCleanupEnabled, true);
  assert.equal(on.recorderNeedsRestart, true);

  // A later change to cleanup survives repeating the same Groq setting.
  settings().groqCleanupEnabled = false;
  const again = groq.changeGroqEnabled(true);
  assert.equal(again.groqCleanupEnabled, false);
  assert.equal(again.recorderNeedsRestart, false);

  const off = groq.changeGroqEnabled(false);
  assert.equal(off.groqEnabled, false);
  assert.equal(off.recorderNeedsRestart, true);

  // Using Groq again restores the automatic default.
  assert.equal(groq.changeGroqEnabled(true).groqCleanupEnabled, true);
});

test('Groq needs a key, and saved audio already keeps the recorder output on', () => {
  const noKey = harness({ encrypted: null, fetch: async () => json({}) });
  assert.throws(() => noKey.groq.changeGroqEnabled(true), /Add a Groq API key/);
  assert.equal(noKey.settings().groqEnabled, false);

  const saving = harness({ fetch: async () => json({}), settings: { saveAudio: true } });
  assert.equal(saving.groq.changeGroqEnabled(true).recorderNeedsRestart, false);
});

test('transcription uploads the WAV with the model and a bounded vocabulary hint', async () => {
  const { groq, requests } = harness({ fetch: async () => json({ text: ' - Hello Rayaan. ' }) });
  const vocabulary = ['Rayaan', ...Array.from({ length: 200 }, (_, index) => `word-${index}`)];
  const result = await groq.transcribeWithGroq(Buffer.from('RIFFaudio'), vocabulary);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello Rayaan.');
  assert.equal(result.model, 'whisper-large-v3');

  const { url, init } = requests[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body.get('model'), 'whisper-large-v3');
  const file = init.body.get('file');
  assert.equal(file.name, 'dictation.wav');
  assert.equal(file.type, 'audio/wav');
  assert.equal(await file.text(), 'RIFFaudio');
  const prompt = init.body.get('prompt');
  assert.ok(prompt.startsWith('Rayaan, word-0'));
  assert.ok(prompt.length <= 800);
});

test('every transcription failure returns a reason instead of throwing', async () => {
  const wav = Buffer.from('RIFF');
  const failures = [
    [async () => json({}, 401), 'auth'],
    [async () => json({}, 403), 'auth'],
    [async () => json({}, 413), 'too_large'],
    [async () => json({}, 429), 'rate_limited'],
    [async () => json({}, 500), 'provider_error'],
    [async () => json({ text: '...' }), 'invalid_response'],
    [async () => new Response('not json'), 'invalid_response'],
    [async () => { throw new TypeError('fetch failed'); }, 'network'],
    [async () => { throw new DOMException('Too slow', 'TimeoutError'); }, 'timeout'],
  ];
  for (const [fetch, reason] of failures) {
    const result = await harness({ fetch }).groq.transcribeWithGroq(wav, []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test('transcription stops before the network without a key, audio or within the size limit', async () => {
  const fetch = async () => { throw new Error('should not be called'); };
  const noKey = harness({ encrypted: null, fetch });
  assert.equal((await noKey.groq.transcribeWithGroq(Buffer.from('RIFF'), [])).reason, 'no_key');

  const unreadable = harness({ encrypted: Buffer.from('tampered').toString('base64'), fetch });
  assert.equal((await unreadable.groq.transcribeWithGroq(Buffer.from('RIFF'), [])).reason, 'no_key');

  const noAudio = harness({ fetch });
  assert.equal((await noAudio.groq.transcribeWithGroq(undefined, [])).reason, 'no_audio');

  const tooLarge = harness({ fetch });
  assert.equal((await tooLarge.groq.transcribeWithGroq(Buffer.alloc(25 * 1024 * 1024 + 1), [])).reason, 'too_large');
  assert.equal(tooLarge.requests.length, 0);
});

test('shutdown aborts a waiting request so history can flush', async () => {
  const { groq } = harness({
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
  });
  const pending = groq.transcribeWithGroq(Buffer.from('RIFF'), []);
  groq.abortGroqRequests();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('timeouts stay bounded for long audio and text', () => {
  const { groq } = harness({ fetch: async () => json({}) });
  assert.equal(groq.groqTranscriptionTimeoutMs(0), 10_000);
  // AbortSignal.timeout throws on a fractional delay.
  assert.equal(groq.groqTranscriptionTimeoutMs(1_001), 10_003);
  assert.equal(groq.groqTranscriptionTimeoutMs(256 * 1024), 11_024);
  assert.equal(groq.groqTranscriptionTimeoutMs(25 * 1024 * 1024), 30_000);
  assert.equal(groq.groqCleanupTimeoutMs('short'), 8_005);
  assert.equal(groq.groqCleanupTimeoutMs('x'.repeat(20_000)), 20_000);
});

test('cleanup sends only the transcript and restores protected vocabulary', async () => {
  const { groq, requests } = harness({
    fetch: async (_url, init) => {
      const { messages } = JSON.parse(init.body);
      const marker = messages[1].content.match(/__MEMO_VOCAB_0_0__/)[0];
      return chat(`<transcript>\nI met ${marker} today.\n</transcript>`);
    },
  });
  const result = await groq.cleanupWithGroq('um i met rayaan today', ['Rayaan']);
  assert.equal(result.status, 'accepted');
  assert.equal(result.text, 'I met Rayaan today.');
  assert.equal(result.model, 'openai/gpt-oss-20b');

  const { url, init } = requests[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /never a request to you/);
  assert.equal(body.messages[1].content, '<transcript>\num i met __MEMO_VOCAB_0_0__ today\n</transcript>');
  assert.equal(init.body.includes('Rayaan'), false);
});

test('cleanup keeps the input when a candidate cannot be trusted', async () => {
  const input = 'please send the quarterly report to the whole team before friday afternoon if you can';
  const candidates = [
    [() => chat('Cleaned but cut off', 'length'), 'invalid_response'],
    [() => chat('   '), 'invalid_response'],
    [() => json({ choices: [] }), 'invalid_response'],
    [() => chat('x'.repeat(257)), 'candidate_bounds'],
    [() => chat('Sent.'), 'candidate_bounds'],
    [() => json({}, 401), 'auth'],
    [() => json({}, 429), 'rate_limited'],
    [async () => { throw new TypeError('fetch failed'); }, 'network'],
  ];
  for (const [fetch, reason] of candidates) {
    const result = await harness({ fetch }).groq.cleanupWithGroq(input, []);
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, reason);
    assert.equal(result.text, input);
  }

  const dropped = await harness({ fetch: async () => chat('I met someone today.') })
    .groq.cleanupWithGroq('i met rayaan today', ['Rayaan']);
  assert.equal(dropped.reason, 'vocabulary_protection');
  assert.equal(dropped.text, 'i met rayaan today');
});

test('cleanup stops before the network without a key or within the input bound', async () => {
  const fetch = async () => { throw new Error('should not be called'); };
  const noKey = await harness({ encrypted: null, fetch }).groq.cleanupWithGroq('hello', []);
  assert.equal(noKey.reason, 'no_key');
  const long = await harness({ fetch }).groq.cleanupWithGroq('x'.repeat(20_001), []);
  assert.equal(long.reason, 'input_bounds');
});

test('a Groq transcript replaces the text, keeps local text in history and relabels timing', () => {
  const { groq } = harness({ fetch: async () => json({}) });
  const data = {
    rawTranscript: 'local words',
    processedText: 'Local words',
    context: { dictationTiming: { backend: 'conomo', recordingId: '1' }, other: true },
  };
  const applied = groq.applyGroqTranscription(data, { ok: true, text: 'Groq words.', model: 'whisper-large-v3', latencyMs: 12 });
  assert.equal(applied.rawTranscript, 'Groq words.');
  assert.equal(applied.processedText, 'Groq words.');
  assert.equal(applied.context.other, true);
  assert.equal(applied.context.dictationTiming.backend, 'groq:whisper-large-v3');
  assert.equal(applied.context.dictationTiming.recordingId, '1');
  assert.equal(applied.context.groqTranscription.localTranscript, 'local words');
  assert.equal(data.rawTranscript, 'local words');

  const failed = groq.applyGroqTranscription(data, { ok: false, reason: 'timeout', latencyMs: 10_000 });
  assert.equal(failed.rawTranscript, 'local words');
  assert.equal(failed.processedText, 'Local words');
  assert.equal(failed.context.dictationTiming.backend, 'conomo');
  assert.equal(failed.context.groqTranscription.status, 'fallback');
  assert.equal(failed.context.groqTranscription.reason, 'timeout');
});

test('failure notices explain what happened without technical reasons', () => {
  const { groqFailureNotice } = harness({ fetch: async () => json({}) }).groq;
  assert.match(groqFailureNotice('auth', 'transcription'), /rejected your API key.*on-device text/);
  assert.match(groqFailureNotice('rate_limited', 'cleanup'), /rate limit.*local formatting/);
  assert.match(groqFailureNotice('too_large', 'transcription'), /too long/);
  assert.match(groqFailureNotice('input_bounds', 'cleanup'), /too long/);
  assert.match(groqFailureNotice('network', 'cleanup'), /Groq cleanup was unavailable/);
  assert.match(groqFailureNotice('timeout', 'transcription'), /Groq transcription was unavailable/);
});

test('the recorder keeps audio for Groq without retaining it for history', async () => {
  const spawned = [];
  const settings = { groqEnabled: true, saveAudio: false, vocabWords: [] };
  const module = { exports: {} };
  vm.runInNewContext(compile('electron/main/services/MemoSttService.ts'), {
    module, exports: module.exports, Buffer, process, performance,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 500 ? 0 : ms), clearTimeout,
    require: name => {
      if (name === 'child_process') {
        return {
          spawnSync: () => ({ status: 0 }),
          spawn: (_command, _args, options) => {
            const child = new EventEmitter();
            Object.assign(child, { exitCode: null, signalCode: null, killed: false, kill: () => true });
            child.stdin = new EventEmitter();
            child.stdin.write = () => true;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            spawned.push(options.env);
            return child;
          },
        };
      }
      if (name === 'fs') return { existsSync: () => true };
      if (name === 'electron') return { app: { isPackaged: false } };
      if (name === '../utils/logger') return { logger: { info() {}, warn() {}, error() {}, debug() {} } };
      if (name === './SettingsService') return { loadSettings: () => settings, store: { get() {}, set() {} } };
      if (name === './windowsRuntime') return { windowsDictationPath: () => '/dictation.exe', configureWindowsSpeech() {} };
      if (name === './conomoRuntime') return { configureConomo() {} };
      if (name === './ModelPackService') return { resolveModelPackPath: () => '/conomo' };
      if (name.includes('transcription')) return { resolveTranscriptionText: data => data.processedText, resolveCleanInput: data => data.rawTranscript };
      if (name === './textProcessing') return textProcessing;
      return require(name);
    },
  });
  const service = new module.exports.MemoSttService();
  service.on('error', () => {});
  await service.start();
  assert.equal(spawned[0].MEMO_EMIT_AUDIO, '1');

  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]);
  const delivered = [];
  service.on('transcription', data => delivered.push(data));
  await service.processLine(`AUDIO_WAV:${wav.toString('base64')}`);
  await service.processLine(`FINAL: ${JSON.stringify({ rawTranscript: 'hello', processedText: 'Hello', wasProcessedByLLM: false })}`);
  assert.deepEqual(Buffer.from(delivered[0].audioCapture.wavBuffer), wav);

  settings.groqEnabled = false;
  await service.processLine(`AUDIO_WAV:${wav.toString('base64')}`);
  await service.processLine(`FINAL: ${JSON.stringify({ rawTranscript: 'bye', processedText: 'Bye', wasProcessedByLLM: false })}`);
  assert.equal(delivered[1].audioCapture, undefined);
});

test('the delivery path retains audio only for Save dictation audio and never returns the key to Settings', () => {
  const main = fs.readFileSync('electron/main/index.ts', 'utf8');
  assert.match(main, /if \(settings\.saveAudio && audioCapture\?\.wavBuffer\)/);
  assert.match(main, /groqKeySaved: hasGroqApiKey\(\)/);
  assert.doesNotMatch(main, /readGroqApiKey|groqApiKeyEncrypted/);
  assert.doesNotMatch(fs.readFileSync('electron/preload/index.ts', 'utf8'), /getGroqApiKey|groqApiKeyEncrypted/);
});
