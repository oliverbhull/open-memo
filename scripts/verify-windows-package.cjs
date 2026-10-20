const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(process.argv[2] || 'dist/win-unpacked');
const resources = path.join(root, 'resources');
const resource = file => path.join(resources, file);
function run(command, args, input, encoding = 'buffer') {
  const result = spawnSync(command, args, { input, encoding, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr}`);
  return result.stdout;
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function pcmFromWav(file) {
  const wav = fs.readFileSync(file);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4), type = wav.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') {
      assert.equal(wav.readUInt16LE(offset + 8), 1);
      assert.equal(wav.readUInt16LE(offset + 10), 1);
      assert.equal(wav.readUInt32LE(offset + 12), 16000);
      assert.equal(wav.readUInt16LE(offset + 22), 16);
    }
    if (type === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('Speech smoke WAV has no PCM');
}
function frame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5); header[0] = opcode; header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
function replies(buffer) {
  const texts = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.ok(offset + 5 <= buffer.length, 'Truncated worker header');
    const status = buffer[offset], size = buffer.readUInt32LE(offset + 1);
    assert.ok(offset + 5 + size <= buffer.length, 'Truncated worker text');
    const text = buffer.toString('utf8', offset + 5, offset + 5 + size);
    assert.equal(status, 0, text); texts.push(text); offset += 5 + size;
  }
  assert.equal(texts.length, 3, 'Expected ready and two resident utterances');
  assert.equal(texts[0], '');
  for (const text of texts.slice(1)) assert.match(text.toLowerCase(), /country/);
  assert.equal(texts[1], texts[2], 'Resident worker leaked text across utterances');
}
(async () => {
  for (const file of ['app-icon.ico', 'app.asar', 'dictation/memo-dictation.exe', 'whisper/memo-whisper-worker.exe', 'whisper/ggml-base.en-q5_1.bin', 'nemotron/memo-nemotron-worker.exe', 'nemotron/nemotron-en-q8.gguf', 'nemotron/Notice.txt', 'nemotron/NVIDIA-Open-Model-License.html', 'pnc/python/python.exe', 'pnc/worker.py', 'pnc/model.int8.onnx', 'pnc/bpe.vocab']) assert.ok(fs.existsSync(resource(file)), `Missing packaged resource: ${file}`);
  for (const forbidden of ['conomo', 'cleanup', 'ble-bridge', 'browser-context']) assert.ok(!fs.existsSync(resource(forbidden)), `Mac-only resource in Windows package: ${forbidden}`);
  const archive = resource('app.asar');
  for (const file of ['dist/main.cjs', 'dist/preload.cjs', 'dist-react/index.html']) assert.ok(asar.extractFile(archive, file).length > 0, `Missing app asset: ${file}`);
  for (const [folder, file] of [['whisper', 'ggml-base.en-q5_1.bin'], ['nemotron', 'nemotron-en-q8.gguf']]) {
    const manifest = JSON.parse(fs.readFileSync(resource(`${folder}/manifest.json`), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(await digest(resource(`${folder}/${file}`)), manifest.modelSha256, `${folder} model hash mismatch`);
  }
  const pcm = pcmFromWav('.build/whisper-source-d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav');
  const length = Buffer.alloc(4); length.writeUInt32LE(pcm.length / 2);
  replies(run(resource('whisper/memo-whisper-worker.exe'), [resource('whisper/ggml-base.en-q5_1.bin')], Buffer.concat([length, pcm, length, pcm])));
  const utterance = [frame(1)];
  for (let offset = 0; offset < pcm.length; offset += 1280) utterance.push(frame(2, pcm.subarray(offset, offset + 1280)));
  utterance.push(frame(3));
  replies(run(resource('nemotron/memo-nemotron-worker.exe'), [resource('nemotron/nemotron-en-q8.gguf')], Buffer.concat([...utterance, ...utterance])));
  const python = resource('pnc/python/python.exe');
  run(python, ['-c', 'import sys,sherpa_onnx; assert sys.flags.isolated; assert sherpa_onnx.__version__ == "1.13.8"'], undefined, 'utf8');
  const output = run(python, [resource('pnc/worker.py'), '--model-path', resource('pnc/model.int8.onnx'), '--vocabulary-path', resource('pnc/bpe.vocab'), '--worker'], '{"id":"packaged","text":"how are you i am fine thank you"}\n', 'utf8').trim().split(/\r?\n/);
  assert.equal(output[0], 'READY');
  assert.equal(JSON.parse(output[1]).text, 'How are you? I am fine. Thank you.');
  console.log('Packaged Windows app verified: assets, model hashes, resident Nemotron/Base speech, isolated punctuation runtime.');
})().catch(error => { console.error(error); process.exitCode = 1; });
