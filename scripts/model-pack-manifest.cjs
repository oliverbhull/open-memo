const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PACKS = ['conomo', 'pnc', 'cleanup'];
const INCLUDED_TOP_LEVEL = {
  conomo: new Set(['conomo', 'compiled', 'tokenizer.json', 'manifest.json', 'LICENSE-APACHE-2.0.txt', 'NOTICE.txt', 'VERSIONS', 'device-runtime']),
  pnc: new Set(['memo-pnc', 'compiled', 'tokenizer.vocab', 'manifest.json', 'VERSIONS', 'NOTICE.md']),
  cleanup: null,
};

function filesUnder(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    // electron-builder excludes dotfiles from these resource filters. They are
    // build caches/markers, not runtime inputs, so keep them out of the signed
    // content contract as well.
    if (entry.name.startsWith('.')) return [];
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(root, absolute);
    if (!entry.isFile() || entry.name === 'model-pack.json') return [];
    return [path.relative(root, absolute).split(path.sep).join('/')];
  });
}

function createManifest(name, root) {
  const files = {};
  const aggregate = crypto.createHash('sha256');
  const included = INCLUDED_TOP_LEVEL[name];
  const runtimeFiles = filesUnder(root).filter(relative => !included || included.has(relative.split('/')[0]));
  for (const relative of runtimeFiles.sort()) {
    const contents = fs.readFileSync(path.join(root, relative));
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    files[relative] = { bytes: contents.length, sha256 };
    aggregate.update(relative).update('\0').update(String(contents.length)).update('\0').update(sha256).update('\n');
  }
  return { schemaVersion: 1, name, version: aggregate.digest('hex'), files };
}

function writeManifests(buildRoot = path.resolve('.build')) {
  for (const name of PACKS) {
    const root = path.join(buildRoot, name);
    if (!fs.statSync(root).isDirectory()) throw new Error(`Missing model pack: ${root}`);
    const manifest = createManifest(name, root);
    fs.writeFileSync(path.join(root, 'model-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${name} ${manifest.version}\n`);
  }
}

if (require.main === module) writeManifests(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
module.exports = { createManifest, writeManifests };
