const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyReleaseArtifacts } = require('./release-artifacts.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['zip', 'dmg'].map(ext => {
    const url = `Open-Memo-1.2.3-arm64.${ext}`;
    const data = Buffer.from(ext);
    fs.writeFileSync(path.join(dir, url), data);
    return { url, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') };
  });
  const manifest = { version: '1.2.3', files, path: files[0].url, sha512: files[0].sha512 };
  const save = () => fs.writeFileSync(path.join(dir, 'latest-mac.yml'), JSON.stringify(manifest));
  save();
  return { dir, manifest, save };
}
test('verifies release ZIP, DMG and both manifest checksum references', async t => {
  const { dir } = fixture(t);
  assert.equal((await verifyReleaseArtifacts(dir, '1.2.3')).length, 3);
});
for (const [name, mutate] of Object.entries({
  'missing ZIP': f => fs.unlinkSync(path.join(f.dir, f.manifest.path)),
  'extra ZIP': f => fs.writeFileSync(path.join(f.dir, 'stale.zip'), 'old'),
  'missing manifest': f => fs.unlinkSync(path.join(f.dir, 'latest-mac.yml')),
  'wrong version': f => { f.manifest.version = '1.2.2'; f.save(); },
  'wrong size': f => { f.manifest.files[0].size++; f.save(); },
  'corrupt artifact': f => fs.writeFileSync(path.join(f.dir, f.manifest.path), 'bad'),
  'external URL': f => { f.manifest.files[0].url = 'https://example.com/app.zip'; f.save(); },
  'wrong legacy checksum': f => { f.manifest.sha512 = 'bad'; f.save(); },
})) test(`rejects ${name}`, async t => {
  const f = fixture(t); mutate(f);
  await assert.rejects(verifyReleaseArtifacts(f.dir, '1.2.3'));
});
