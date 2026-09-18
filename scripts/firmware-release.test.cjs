const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const source = path.resolve('electron/main/services/FirmwareReleaseService.ts');
const compiled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = module.paths;
loaded._compile(compiled, source);
const { FirmwareReleaseService } = loaded.exports;
const appReleases = () => Array.from({ length: 30 }, (_, i) => ({ tag_name: `v1.0.${i}`, draft: false, prerelease: false, assets: [] }));

test('discovers and verifies firmware after more than thirty app releases', async t => {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-firmware-'));
  t.after(() => fs.rmSync(cacheDirectory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const uf2 = Buffer.from('test firmware bytes');
  const sha256 = crypto.createHash('sha256').update(uf2).digest('hex');
  const tag = 'firmware-v1.2.3';
  const manifest = Buffer.from(JSON.stringify({ schema: 1, board: 'xiao_ble/nrf52840/sense',
    build_id: 'a'.repeat(16), firmware_version: `1.2.3+${'a'.repeat(16)}`, input_sha256: 'a'.repeat(64),
    release_tag: tag, source_commit: 'b'.repeat(40), uf2_file: 'memo.uf2', uf2_sha256: sha256,
    sidecar_file: 'memo.uf2.json', sidecar_sha256: 'c'.repeat(64) }));
  const data = { 'memo-firmware-release.json': manifest,
    'memo-firmware-release.json.sig': crypto.sign(null, manifest, keys.privateKey), 'memo.uf2': uf2 };
  const firmware = { tag_name: tag, draft: false, prerelease: true,
    assets: Object.entries(data).map(([name, bytes]) => ({ name, size: bytes.length, browser_download_url: `https://assets.example/${name}` })) };
  const pages = [];
  const service = new FirmwareReleaseService({ cacheDirectory,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    releasesUrl: 'https://api.example/releases?existing=yes&per_page=1&page=99',
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.hostname === 'assets.example') return new Response(data[parsed.pathname.slice(1)]);
      assert.equal(parsed.searchParams.get('existing'), 'yes');
      assert.equal(parsed.searchParams.get('per_page'), '30');
      const page = Number(parsed.searchParams.get('page'));
      pages.push(page);
      return Response.json(page === 1 ? appReleases() : [...appReleases().slice(0, 5), firmware]);
    } });
  const result = await service.findUpdate('1.2.2');
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(fs.readFileSync(result.path), uf2);
});
test('discovery stops at the end of release history', async () => {
  let calls = 0;
  const service = new FirmwareReleaseService({ cacheDirectory: '/unused', fetchImpl: async () => {
    calls++; return Response.json([]);
  } });
  assert.equal(await service.findUpdate('1.0.0'), null);
  assert.equal(calls, 1);
});
test('discovery is bounded and reports truncation instead of no update', async () => {
  let calls = 0;
  const service = new FirmwareReleaseService({ cacheDirectory: '/unused', fetchImpl: async () => {
    calls++; return Response.json(appReleases());
  } });
  await assert.rejects(service.findUpdate('1.0.0'), /release history limit/);
  assert.equal(calls, 10);
});
