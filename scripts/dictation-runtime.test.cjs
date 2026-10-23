const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { transformSync } = require('esbuild');
const loaded = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync('electron/main/services/conomoRuntime.ts', 'utf8'),
  { loader: 'ts', format: 'cjs' }).code, { module: loaded, exports: loaded.exports, require });

test('Memo connects through the packaged or external Conomo bridge without selecting a model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conomo-bridge-'));
  try {
    const worker = path.join(root, 'conomo'); fs.writeFileSync(worker, 'fixture');
    const env = {};
    loaded.exports.configureConomo(env, root);
    assert.equal(env.MEMO_ASR_BACKEND, 'conomo');
    assert.equal(env.MEMO_ASR_WORKER, worker);
    assert.equal(env.MEMO_CONTEXTUAL_VOCAB, '1');
    assert.equal(env.CONOMO_SOCKET, path.join(os.homedir(), 'Library/Application Support/Conomo/speech.sock'));
    const custom = { CONOMO_WORKER: worker, CONOMO_SOCKET: '/private/custom.sock' };
    loaded.exports.configureConomo(custom, '/missing');
    assert.equal(custom.CONOMO_SOCKET, '/private/custom.sock');
    fs.unlinkSync(worker);
    assert.throws(() => loaded.exports.configureConomo({}, root), /runtime worker missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
