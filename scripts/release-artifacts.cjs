const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('js-yaml');

async function verifyReleaseArtifacts(directory, version) {
  const names = fs.readdirSync(directory);
  const extensions = ['zip', 'dmg'];
  const expected = extensions.map(extension => `Open-Memo-${version}-arm64.${extension}`);
  for (const extension of extensions) {
    const matches = names.filter(name => name.endsWith(`.${extension}`) && !name.endsWith('-app-arm64.zip'));
    if (matches.length !== 1 || !expected.includes(matches[0])) {
      throw new Error(`Expected exactly one versioned ARM64 ${extension}: ${version}`);
    }
  }
  const dmgPath = path.join(directory, expected[1]);
  if (!fs.lstatSync(dmgPath).isFile() || fs.statSync(dmgPath).size === 0) {
    throw new Error('Full installer DMG is empty');
  }
  const manifest = load(fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf8'));
  if (!manifest || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== 2) {
    throw new Error('Update manifest version or file list is invalid');
  }
  for (const name of expected) {
    const entries = manifest.files.filter(file => file.url === name);
    if (entries.length !== 1) throw new Error(`Update manifest must reference ${name} exactly once`);
    const filePath = path.join(directory, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size === 0 || entries[0].size !== stat.size) throw new Error(`Invalid size for ${name}`);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    if (entries[0].sha512 !== hash.digest('base64')) throw new Error(`Checksum mismatch for ${name}`);
  }
  const zip = manifest.files.find(file => file.url === expected[0]);
  if (manifest.path !== zip.url || manifest.sha512 !== zip.sha512) throw new Error('Legacy update manifest ZIP reference is invalid');
  const appZip = `Open-Memo-${version}-app-arm64.zip`;
  const appManifest = load(fs.readFileSync(path.join(directory, 'app-mac.yml'), 'utf8'));
  if (appManifest?.version !== version || appManifest.files?.length !== 1 || appManifest.files[0].url !== appZip
    || appManifest.path !== appZip || appManifest.sha512 !== appManifest.files[0].sha512) throw new Error('Lightweight update manifest is invalid');
  const appPath = path.join(directory, appZip);
  if (!fs.lstatSync(appPath).isFile() || fs.statSync(appPath).size !== appManifest.files[0].size) throw new Error('Invalid lightweight update size');
  const appHash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(appPath)) appHash.update(chunk);
  if (appHash.digest('base64') !== appManifest.sha512) throw new Error('Lightweight update checksum mismatch');
  return [...expected, appZip, 'latest-mac.yml', 'app-mac.yml'];
}

module.exports = { verifyReleaseArtifacts };
if (require.main === module) {
  verifyReleaseArtifacts(process.argv[2] || 'dist', require('../package.json').version)
    .then(files => console.log(`Verified release artifacts: ${files.join(', ')}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
