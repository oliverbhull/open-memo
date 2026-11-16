const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');

const API_KEY = 'gsk_test_0123456789';
const API_URL = 'https://api.groq.com/openai/v1';
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox/private-thread';
const SENDER = 'Private Profile Name';
const settings = {
  sayEnterToPressEnter: true,
  vocabWords: ['Rayaan', 'JTECH'],
  phraseReplacements: [{ id: 'addr', find: 'office address', replace: '5 Main St', enabled: true }],
};

const bundle = buildSync({
  stdin: {
    contents: `
      export * from './electron/main/services/GroqService';
      export * from './electron/main/services/dictationFormatting';
      export * from './electron/main/services/SettingsService';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron', 'electron-store'],
  define: { 'process.platform': '"darwin"' },
}).outputFiles[0].text;

async function harness(t, { oldSettings = {}, encryptionAvailable = true } = {}) {
  const requests = [];
  let respond = (_request, response) => response.end('{}');
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const received = {
      path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString(),
    };
    requests.push(received);
    response.setHeader('Content-Type', 'application/json');
    respond(received, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: value => Buffer.from(`encrypted:${value}`).reverse(),
    decryptString: value => {
      const decoded = Buffer.from(value).reverse().toString();
      if (!decoded.startsWith('encrypted:')) throw new Error('Could not decrypt');
      return decoded.slice('encrypted:'.length);
    },
  };
  const module = { exports: {} };
  const logs = [];
  let target;
  const targetCalls = [];
  vm.runInNewContext(bundle, {
    module, exports: module.exports, AbortController, AbortSignal, Buffer, performance, URL,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    process,
    fetch: (url, init) => {
      assert.ok(url.startsWith(API_URL));
      return fetch(`http://127.0.0.1:${server.address().port}${url.slice(API_URL.length)}`, init);
    },
    require(name) {
      if (name === 'electron') return { safeStorage, app: { isPackaged: true } };
      if (name === 'electron-store') return class {
        constructor({ defaults }) { this.values = { ...defaults, ...oldSettings }; }
        get(key, fallback) { return this.values[key] ?? fallback; }
        set(key, value) { this.values[key] = value; }
      };
      if (name === 'node:child_process') return {
        execFile(_command, _args, _options, callback) {
          targetCalls.push(true);
          queueMicrotask(() => target ? callback(null, target) : callback(new Error('Unavailable')));
        },
      };
      return require(name);
    },
  });
  const app = module.exports;
  const localInputs = [];
  const localFormat = async input => {
    localInputs.push(input);
    return `${input[0].toUpperCase()}${input.slice(1)}.`;
  };
  const format = (processedText, { rawTranscript = processedText, cleanup = app.captureDictationCleanup(false) } = {}) =>
    app.formatRecordedDictation({ processedText, rawTranscript, audioCapture: { wavBuffer: Buffer.from('RIFF') } },
      settings, cleanup, SENDER, localFormat);
  const enable = async () => {
    await app.saveGroqApiKey(API_KEY);
    app.setGroqCleanupEnabled(true);
  };
  return {
    app, requests, localInputs, targetCalls, logs, format, enable,
    setTarget: value => { target = value; },
    setResponse: handler => { respond = handler; },
  };
}

function reply(response, content, finish_reason = 'stop') {
  response.end(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));
}

function chatBody(request) {
  assert.equal(request.path, '/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.doesNotMatch(request.body, /RIFF|wavBuffer|Private Profile Name|private-thread|mail\.google\.com/);
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
  return body;
}

test('fresh and old Cleaned profiles send zero dictations until explicitly opted in', async t => {
  for (const oldSettings of [
    {},
    { writingMode: 'clean', experimentalEmailFormatting: true },
    { writingMode: 'clean', groqEnabled: true, groqCleanupEnabled: true, experimentalEmailFormatting: true,
      groqApiKeyEncrypted: Buffer.from(`encrypted:${API_KEY}`).reverse().toString('base64') },
  ]) {
    const h = await harness(t, { oldSettings });
    h.setTarget(`com.google.Chrome\x1e${GMAIL_URL}`);
    assert.equal(h.app.isGroqCleanupEnabled(), false);
    const format = () => h.format('met rayaan enter', { cleanup: h.app.captureDictationCleanup(true) });
    const result = await format();
    assert.equal(result.textToPaste, 'Met Rayaan.');
    assert.equal(result.pressEnter, true);
    assert.equal(result.provenance, undefined);
    assert.equal(h.requests.length, 0);
    assert.equal(h.targetCalls.length, 0);

    await h.app.saveGroqApiKey(`  ${API_KEY}\n`);
    assert.equal(h.app.hasGroqApiKey(), true);
    assert.equal(h.app.isGroqCleanupEnabled(), false);
    await format();
    assert.deepEqual(h.requests.map(({ method, path, body }) => [method, path, body]), [['GET', '/models', '']]);
    assert.equal(h.requests[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(Buffer.from(h.app.store.get('groqApiKeyEncrypted'), 'base64').includes(API_KEY), false);
    assert.equal(h.logs.join('\n').includes(API_KEY), false);
  }
});

test('invalid and unstorable keys cannot enable cleanup', async t => {
  const h = await harness(t);
  assert.throws(() => h.app.setGroqCleanupEnabled(true), /Add a valid Groq API key/);
  for (const key of ['', 'has space', 'kéy', null, 42]) {
    await assert.rejects(h.app.saveGroqApiKey(key), /valid Groq API key/);
  }
  assert.equal(h.requests.length, 0);
  h.setResponse((_request, response) => { response.writeHead(401); response.end('{}'); });
  await assert.rejects(h.app.saveGroqApiKey(API_KEY), /rejected this API key/);
  assert.equal(h.app.hasGroqApiKey(), false);
  const insecure = await harness(t, { encryptionAvailable: false });
  await assert.rejects(insecure.app.saveGroqApiKey(API_KEY), /store the key securely/);
  assert.equal(insecure.requests.length, 0);
});

test('ordinary dictation makes one text-only request and preserves vocabulary, snippets and Say Enter', async t => {
  const h = await harness(t);
  await h.enable();
  h.setResponse((_request, response) => reply(response, 'Send __MEMO_VOCAB_0_0__ the office address at jtech.'));
  const result = await h.format('um send rayaan the office address enter');
  assert.equal(result.textToPaste, 'Send Rayaan the 5 Main St at JTECH.');
  assert.equal(result.pressEnter, true);
  assert.equal(result.provenance.status, 'accepted');
  assert.equal(result.provenance.contract, 'memo-groq-cleanup-v1');
  assert.equal(result.provenance.asSpoken, 'um send rayaan the office address enter');
  assert.equal(h.requests.length, 2);
  const body = chatBody(h.requests[1]);
  assert.doesNotMatch(body.messages[0].content, /email/i);
  assert.equal(body.messages[1].content, '<transcript>\num send __MEMO_VOCAB_0_0__ the office address\n</transcript>');
  assert.deepEqual(h.localInputs, []);
});

test('experimental email sends only text and adds the profile signature locally', async t => {
  const h = await harness(t);
  await h.enable();
  h.setTarget(`com.google.Chrome\x1e${GMAIL_URL}`);
  h.setResponse((_request, response) => reply(response, 'Hello __MEMO_VOCAB_0_0__, Please send the schedule. Thanks,'));
  const result = await h.format('hey rayaan please send the schedule', {
    rawTranscript: 'hey rayaan please send the schedule thanks',
    cleanup: h.app.captureDictationCleanup(true),
  });
  assert.equal(h.requests.length, 2);
  const body = chatBody(h.requests[1]);
  assert.match(body.messages[0].content, /plain-text email body/);
  assert.equal(body.messages[1].content, '<transcript>\nhey __MEMO_VOCAB_0_0__ please send the schedule thanks\n</transcript>');
  assert.equal(result.textToPaste, `Hey Rayaan,\n\nPlease send the schedule.\n\nThanks,\n${SENDER}`);
  assert.equal(result.provenance.contract, 'memo-groq-email-v1');
  assert.doesNotMatch(result.provenance.candidate, /Private Profile Name/);
  assert.deepEqual(h.localInputs, []);
});

test('email stays opt-in and destination detection failure uses ordinary cleanup', async t => {
  const h = await harness(t);
  await h.enable();
  h.setResponse((_request, response) => reply(response, 'Send the schedule.'));
  const plain = await h.format('send the schedule');
  assert.equal(h.targetCalls.length, 0);
  const undetected = await h.format('send the schedule', { cleanup: h.app.captureDictationCleanup(true) });
  assert.equal(h.targetCalls.length, 1);
  assert.equal(h.requests.length, 3);
  for (const request of h.requests.slice(1)) assert.doesNotMatch(chatBody(request).messages[0].content, /email/i);
  assert.equal(plain.textToPaste, undetected.textToPaste);
  assert.equal(undetected.textToPaste, 'Send the schedule.');
});

test('request failure, invalid generation and destroyed vocabulary use local punctuation', async t => {
  const h = await harness(t);
  await h.enable();
  h.setTarget(`com.google.Chrome\x1e${GMAIL_URL}`);
  for (const [respond, reason] of [
    [(_request, response) => { response.writeHead(429); response.end('{}'); }, 'rate_limited'],
    [(_request, response) => reply(response, 'Met __MEMO_VOCAB_0_0__', 'length'), 'invalid_response'],
    [(_request, response) => reply(response, 'Met someone else.'), 'vocabulary_protection'],
  ]) {
    h.setResponse(respond);
    const result = await h.format('met rayaan enter', { cleanup: h.app.captureDictationCleanup(true) });
    assert.equal(result.textToPaste, 'Met Rayaan.');
    assert.equal(result.pressEnter, true);
    assert.equal(result.provenance.status, 'fallback');
    assert.equal(result.provenance.reason, reason);
  }
  assert.deepEqual(h.localInputs, Array(3).fill('met rayaan'));
  assert.equal(h.requests.length, 4);
});

test('cleanup times out even when the provider sends headers and stalls the body', async t => {
  const h = await harness(t);
  await h.enable();
  h.setResponse((_request, response) => {
    response.write('{"choices":');
  });
  const result = await h.format('keep these words');
  assert.equal(result.provenance.reason, 'timeout');
  assert.equal(result.textToPaste, 'Keep these words.');
  assert.equal(h.requests.length, 2);
});

test('disabling cleanup aborts active work and queued consent cannot be reused after re-enabling', async t => {
  const h = await harness(t);
  await h.enable();
  let started;
  const startedRequest = new Promise(resolve => { started = resolve; });
  h.setResponse(() => started());
  const queued = h.app.captureDictationCleanup(false);
  const active = h.format('active dictation');
  await Promise.race([startedRequest, active.then(() => assert.fail('Expected a request to start'))]);
  h.app.setGroqCleanupEnabled(false);
  h.app.setGroqCleanupEnabled(true);
  const activeResult = await active;
  assert.equal(activeResult.textToPaste, 'Active dictation.');
  assert.equal(activeResult.provenance.reason, 'cancelled');
  assert.equal((await h.format('queued dictation', { cleanup: queued })).textToPaste, 'Queued dictation.');
  assert.equal(h.requests.length, 2);
});

test('removing the key during destination detection stops the queued request', async t => {
  const h = await harness(t);
  await h.enable();
  h.setTarget(`com.google.Chrome\x1e${GMAIL_URL}`);
  const pending = h.format('queued message', { cleanup: h.app.captureDictationCleanup(true) });
  h.app.removeGroqApiKey();
  assert.equal((await pending).textToPaste, 'Queued message.');
  assert.equal(h.app.hasGroqApiKey(), false);
  assert.equal(h.app.isGroqCleanupEnabled(), false);
  assert.equal(h.requests.length, 1);
  await h.app.saveGroqApiKey(API_KEY);
  assert.equal(h.app.isGroqCleanupEnabled(), false);
});

test('a suppressed native result cannot start cleanup', async t => {
  const h = await harness(t);
  await h.enable();
  const result = await h.format('', { rawTranscript: 'Suppressed audio artifact' });
  assert.equal(result.textToPaste, '');
  assert.equal(h.requests.length, 1);
});

const compile = file => transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;

test('the recorder emits and retains WAV only for Save dictation audio', async () => {
  const spawned = [];
  const settings = { saveAudio: true, vocabWords: [] };
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
      if (name === './asrVocabulary') return { asrVocabulary: words => words };
      if (name === './conomoRuntime') return { configureConomo() {} };
      if (name === './ModelPackService') return { resolveModelPackPath: () => '/conomo' };
      if (name.includes('transcription')) return { resolveTranscriptionText: data => data.processedText };
      if (name === './textProcessing') return {
        normalizeTranscriptionText: value => value.trim(),
      };
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

  settings.saveAudio = false;
  const defaultService = new module.exports.MemoSttService();
  defaultService.on('error', () => {});
  await defaultService.start();
  assert.equal(spawned[1].MEMO_EMIT_AUDIO, '0');
  await service.processLine(`AUDIO_WAV:${wav.toString('base64')}`);
  await service.processLine(`FINAL: ${JSON.stringify({ rawTranscript: 'bye', processedText: 'Bye', wasProcessedByLLM: false })}`);
  assert.equal(delivered[1].audioCapture, undefined);
});
