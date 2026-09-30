const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('packaged Conomo dictation uses its own runtime without the optional Cleaned pack', () => {
  const source = fs.readFileSync(
    path.resolve('electron/main/services/MemoSttService.ts'),
    'utf8',
  );

  assert.match(
    source,
    /MEMO_CONTEXTUAL_PYTHON = path\.join\(conomoRoot, 'device-runtime', 'bin', 'python3\.12'\)/,
  );
  assert.doesNotMatch(
    source,
    /MEMO_CONTEXTUAL_PYTHON\s*=\s*path\.join\(resolveModelPackPath\('cleanup'\)/,
  );

  const requirements = fs.readFileSync(
    path.resolve('sidecars/conomo/requirements-device.txt'),
    'utf8',
  );
  assert.match(requirements, /^tokenizers==[^\s]+$/m);

  const verifier = fs.readFileSync(
    path.resolve('scripts/shell/verify-conomo-bundle.sh'),
    'utf8',
  );
  assert.match(verifier, /from tokenizers import Tokenizer/);

  const manifestBuilder = fs.readFileSync(
    path.resolve('scripts/model-pack-manifest.cjs'),
    'utf8',
  );
  assert.match(manifestBuilder, /device-runtime\/\.memo-runtime-version/);
});
