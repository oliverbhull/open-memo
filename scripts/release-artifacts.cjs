const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('js-yaml');
const fullModelUpdateVersions = require('../config/full-model-update-versions.json');

async function verifyReleaseArtifacts(directory, version) {
  const names = fs.readdirSync(directory);
  const expected = ['zip', 'dmg'].map(extension => `Open-Memo-${version}-arm64.${extension}`);
  for (const extension of ['zip', 'dmg']) {
    const matches = names.filter(name => name.endsWith(`.${extension}`));
    if (matches.length !== 1 || !expected.includes(matches[0])) {
      throw new Error(`Expected exactly one versioned ARM64 ${extension}: ${version}`);
    }
  }
  const dmgPath = path.join(directory, expected[1]);
  if (!fs.lstatSync(dmgPath).isFile() || fs.statSync(dmgPath).size === 0) {
    throw new Error('Full installer DMG is empty');
  }
  const manifest = load(fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf8'));
  const expectedManifestFiles = fullModelUpdateVersions.includes(version) ? 2 : 1;
  if (!manifest || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== expectedManifestFiles) {
    throw new Error('Update manifest version or file list is invalid');
  }
  const updateArtifacts = expectedManifestFiles === 2 ? expected : [expected[0]];
  for (const name of updateArtifacts) {
    const entries = manifest.files.filter(file => file.url === name);
    if (entries.length !== 1) throw new Error(`Update manifest must reference ${name} exactly once`);
    const filePath = path.join(directory, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size === 0 || entries[0].size !== stat.size) throw new Error(`Invalid size for ${name}`);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    if (entries[0].sha512 !== hash.digest('base64')) throw new Error(`Checksum mismatch for ${name}`);
  }
  if (expectedManifestFiles === 1 && manifest.files.some(file => file.url.endsWith('.dmg'))) {
    throw new Error('Update manifest must not serve the full installer DMG');
  }
  const zip = manifest.files.find(file => file.url === expected[0]);
  if (manifest.path !== zip.url || manifest.sha512 !== zip.sha512) throw new Error('Legacy update manifest ZIP reference is invalid');
  return [...expected, 'latest-mac.yml'];
}

module.exports = { verifyReleaseArtifacts };
if (require.main === module) {
  verifyReleaseArtifacts(process.argv[2] || 'dist', require('../package.json').version)
    .then(files => console.log(`Verified release artifacts: ${files.join(', ')}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
