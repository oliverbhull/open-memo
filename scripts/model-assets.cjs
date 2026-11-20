const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const directories = { conomo: 'model', pnc: 'compiled' };
function assetManifest(root) {
  const files = {};
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(path.join(directory, entry.name));
        files[relative] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      } else throw new Error(`Unsupported model asset: ${relative}`);
    }
  }
  walk(root);
  if (!Object.keys(files).length) throw new Error(`Empty model assets: ${root}`);
  const aggregate = crypto.createHash('sha256');
  for (const relative of Object.keys(files).sort()) {
    const file = files[relative];
    aggregate.update(relative).update('\0').update(String(file.bytes)).update('\0').update(file.sha256).update('\n');
  }
  return { version: aggregate.digest('hex'), files };
}

function separateModelAssets(resources, outputDirectory, appVersion) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const assets = {};
  for (const [name, directory] of Object.entries(directories)) {
    const root = path.join(resources, name, directory);
    const manifest = assetManifest(root);
    const filename = `Open-Memo-${name}-${manifest.version}.tar.gz`;
    const archive = path.join(outputDirectory, filename);
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', root, ...Object.keys(manifest.files).sort()], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }, timeout: 120_000,
    });
    const bytes = fs.readFileSync(archive);
    assets[name] = { ...manifest, url: `https://github.com/oliverbhull/open-memo/releases/download/v${appVersion}/${filename}`,
      bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  fs.writeFileSync(path.join(resources, 'model-assets.json'), `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`);
  for (const [name, directory] of Object.entries(directories)) fs.rmSync(path.join(resources, name, directory), { recursive: true });
}
module.exports = { assetManifest, separateModelAssets };
