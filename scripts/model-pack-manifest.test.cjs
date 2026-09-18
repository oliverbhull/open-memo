const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManifest } = require('./model-pack-manifest.cjs');

test('model pack manifest is deterministic and content-addressed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-model-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'weights.bin'), 'weights');
  fs.writeFileSync(path.join(root, 'VERSIONS'), 'model=v1\n');

  const first = createManifest('cleanup', root);
  fs.writeFileSync(path.join(root, 'model-pack.json'), JSON.stringify(first));
  const second = createManifest('cleanup', root);
  assert.deepEqual(second, first);
  assert.equal(first.files['nested/weights.bin'].sha256, crypto.createHash('sha256').update('weights').digest('hex'));

  fs.writeFileSync(path.join(root, 'nested', 'weights.bin'), 'changed');
  assert.notEqual(createManifest('cleanup', root).version, first.version);
});
