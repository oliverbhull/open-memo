// Verify model contracts against the offline installer, without network access
// or changing the signed lightweight app. Runs on the macOS release runner.
const fs = require('node:fs');
const path = require('node:path');
const { assetManifest } = require('./model-assets.cjs');
function verifyUpdateAssets(resources, fullResources, archives) {
  const crypto = require('node:crypto');
  const contract = JSON.parse(fs.readFileSync(path.join(resources, 'model-assets.json')));
  if (contract.schemaVersion !== 1) throw new Error('Invalid model asset schema');
  for (const [name, directory] of Object.entries({ conomo: 'model', pnc: 'compiled' })) {
    const asset = contract.assets[name];
    if (fs.existsSync(path.join(resources, name, directory))) throw new Error(`Update includes ${name} weights`);
    const expected = assetManifest(path.join(fullResources, name, directory));
    if (JSON.stringify(expected) !== JSON.stringify({ version: asset.version, files: asset.files })) throw new Error(`Installer/update ${name} model mismatch`);
    const filename = path.basename(new URL(asset.url).pathname);
    const bytes = fs.readFileSync(path.join(archives, filename));
    if (bytes.length !== asset.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Invalid ${name} model archive`);
  }
}
module.exports = { verifyUpdateAssets };
if (require.main === module) verifyUpdateAssets(...process.argv.slice(2));

async function verifyRuntime(resources, fullResources) {
  const os = require('node:os');
  const Module = require('node:module');
  const { buildSync } = require('esbuild');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-update-models-'));
  const previousResources = process.resourcesPath;
  const originalLoad = Module._load;
  try {
    process.resourcesPath = resources;
    const entry = path.resolve(__dirname, '../electron/main/services/ModelAssets.ts');
    const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'], write: false }).outputFiles[0].text;
    const loaded = new Module(entry, module);
    Module._load = (name, ...args) => name === 'electron'
      ? { app: { isPackaged: true, getPath: () => temporary } } : originalLoad(name, ...args);
    try { loaded._compile(compiled, entry); } finally { Module._load = originalLoad; }
    const service = loaded.exports;
    await service.prepareModelAssets(resources, [fullResources]);
    // Prove a subsequent launch works with just the persistent cache.
    await service.prepareModelAssets(resources);
    for (const name of ['conomo', 'pnc']) {
      const env = { ...process.env };
      const root = path.join(resources, name);
      if (name === 'conomo') env.CONOMO_MODEL_DIR = service.resolveModelAssetPath(name, root);
      else env.MEMO_PNC_MODEL_DIR = service.resolveModelAssetPath(name, root);
      const result = await execFile('/bin/bash', [path.join(__dirname, 'shell', `verify-${name}-bundle.sh`), root], { env, timeout: 180_000 });
      process.stdout.write(result.stdout);
    }
  } finally {
    Module._load = originalLoad;
    process.resourcesPath = previousResources;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
module.exports.verifyRuntime = verifyRuntime;
if (require.main === module) verifyRuntime(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
