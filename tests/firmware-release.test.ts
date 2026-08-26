import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FIRMWARE_SIGNING_PUBLIC_KEY,
  FirmwareReleaseError,
  FirmwareReleaseService,
} from '../electron/main/services/FirmwareReleaseService';

const RELEASE_TAG = 'firmware-v2.0.0-0123456789abcdef-g0123456789ab';
const FIRMWARE_VERSION = '2.0.0+0123456789abcdef';
const UF2_FILE = `memo-${RELEASE_TAG}.uf2`;

test('embedded updater key matches the public key used by the mirror workflow', () => {
  const configured = fs.readFileSync(
    path.join(process.cwd(), 'config', 'firmware-signing-public-key.pem'),
    'utf-8',
  );
  assert.equal(FIRMWARE_SIGNING_PUBLIC_KEY, configured);
});

test('firmware mirror selects the newest published source release explicitly', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'mirror-firmware-release.yml'),
    'utf-8',
  );
  assert.match(workflow, /max_by\(\.published_at\)/);
});

function fixture(options: { tamperManifest?: boolean; tamperUf2?: boolean } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const uf2 = Buffer.from('synthetic signed UF2 fixture');
  const actualDigest = createHash('sha256').update(uf2).digest('hex');
  const manifest = Buffer.from(`${JSON.stringify({
    board: 'xiao_ble/nrf52840/sense',
    build_id: '0123456789abcdef',
    firmware_version: FIRMWARE_VERSION,
    input_sha256: '0123456789abcdef000000000000000000000000000000000000000000000000',
    release_tag: RELEASE_TAG,
    schema: 1,
    sidecar_file: `${UF2_FILE}.json`,
    sidecar_sha256: 'f'.repeat(64),
    source_commit: '0123456789abcdef0123456789abcdef01234567',
    uf2_file: UF2_FILE,
    uf2_sha256: actualDigest,
  }, null, 2)}\n`);
  const signature = sign(null, manifest, privateKey);
  const servedManifest = options.tamperManifest
    ? Buffer.from(manifest.toString('utf-8').replace(FIRMWARE_VERSION, '2.0.0+fedcba9876543210'))
    : manifest;
  const servedUf2 = options.tamperUf2 ? Buffer.from('modified UF2 fixture') : uf2;
  const urls = {
    releases: 'https://example.test/releases',
    manifest: 'https://example.test/manifest',
    signature: 'https://example.test/signature',
    uf2: 'https://example.test/firmware',
  };
  const releases = [{
    tag_name: RELEASE_TAG,
    draft: false,
    prerelease: true,
    assets: [
      { name: 'memo-firmware-release.json', size: servedManifest.length, browser_download_url: urls.manifest },
      { name: 'memo-firmware-release.json.sig', size: signature.length, browser_download_url: urls.signature },
      { name: UF2_FILE, size: servedUf2.length, browser_download_url: urls.uf2 },
    ],
  }];
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === urls.releases) return new Response(JSON.stringify(releases));
    if (url === urls.manifest) return new Response(servedManifest);
    if (url === urls.signature) return new Response(signature);
    if (url === urls.uf2) return new Response(servedUf2);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fetchImpl,
    requests,
    urls,
    uf2,
  };
}

test('downloads a mirrored signed firmware release and caches the verified UF2 bytes', async () => {
  const current = fixture();
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memo-firmware-release-'));
  try {
    const service = new FirmwareReleaseService({
      cacheDirectory: cache,
      fetchImpl: current.fetchImpl,
      releasesUrl: current.urls.releases,
      publicKey: current.publicKey,
    });
    const update = await service.findUpdate('2.0.0+ffffffffffffffff');
    assert.ok(update);
    assert.equal(update.firmwareVersion, FIRMWARE_VERSION);
    assert.deepEqual(await fs.promises.readFile(update.path), current.uf2);

    current.requests.length = 0;
    const cached = await service.findUpdate('2.0.0+ffffffffffffffff');
    assert.equal(cached?.path, update.path);
    assert.equal(current.requests.includes(current.urls.uf2), false);
  } finally {
    await fs.promises.rm(cache, { recursive: true, force: true });
  }
});

test('does not download the UF2 when the connected Memo already has the release', async () => {
  const current = fixture();
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memo-firmware-current-'));
  try {
    const service = new FirmwareReleaseService({
      cacheDirectory: cache,
      fetchImpl: current.fetchImpl,
      releasesUrl: current.urls.releases,
      publicKey: current.publicKey,
    });
    assert.equal(await service.findUpdate(FIRMWARE_VERSION), null);
    assert.equal(current.requests.includes(current.urls.uf2), false);
  } finally {
    await fs.promises.rm(cache, { recursive: true, force: true });
  }
});

test('does not downgrade a device with a newer semantic firmware version', async () => {
  const current = fixture();
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memo-firmware-newer-'));
  try {
    const service = new FirmwareReleaseService({
      cacheDirectory: cache,
      fetchImpl: current.fetchImpl,
      releasesUrl: current.urls.releases,
      publicKey: current.publicKey,
    });
    assert.equal(await service.findUpdate('3.0.0+ffffffffffffffff'), null);
    assert.equal(current.requests.includes(current.urls.uf2), false);
  } finally {
    await fs.promises.rm(cache, { recursive: true, force: true });
  }
});

test('rejects a manifest changed after it was signed', async () => {
  const current = fixture({ tamperManifest: true });
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memo-firmware-signature-'));
  try {
    const service = new FirmwareReleaseService({
      cacheDirectory: cache,
      fetchImpl: current.fetchImpl,
      releasesUrl: current.urls.releases,
      publicKey: current.publicKey,
    });
    await assert.rejects(
      service.findUpdate('2.0.0+ffffffffffffffff'),
      (error: unknown) => error instanceof FirmwareReleaseError
        && /signature is not trusted/.test(error.message),
    );
    assert.equal(current.requests.includes(current.urls.uf2), false);
  } finally {
    await fs.promises.rm(cache, { recursive: true, force: true });
  }
});

test('rejects UF2 bytes that do not match the signed digest', async () => {
  const current = fixture({ tamperUf2: true });
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memo-firmware-digest-'));
  try {
    const service = new FirmwareReleaseService({
      cacheDirectory: cache,
      fetchImpl: current.fetchImpl,
      releasesUrl: current.urls.releases,
      publicKey: current.publicKey,
    });
    await assert.rejects(
      service.findUpdate('2.0.0+ffffffffffffffff'),
      (error: unknown) => error instanceof FirmwareReleaseError
        && /signed SHA-256/.test(error.message),
    );
  } finally {
    await fs.promises.rm(cache, { recursive: true, force: true });
  }
});
