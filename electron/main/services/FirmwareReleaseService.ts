import { createHash, randomUUID, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELEASES_URL = 'https://api.github.com/repos/oliverbhull/open-memo/releases?per_page=30';
const MANIFEST_NAME = 'memo-firmware-release.json';
const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`;
const EXPECTED_BOARD = 'xiao_ble/nrf52840/sense';
const MAX_RELEASE_LIST_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_UF2_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_ID_PATTERN = /^[0-9a-f]{16}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+\+[0-9a-f]{16}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const FIRMWARE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWAzIpW2SafwSd3uajEYRny0mtM991AKrmybs4mqlTh0=
-----END PUBLIC KEY-----
`;

interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

interface FirmwareReleaseManifest {
  schema: 1;
  board: string;
  build_id: string;
  firmware_version: string;
  input_sha256: string;
  release_tag: string;
  source_commit: string;
  uf2_file: string;
  uf2_sha256: string;
  sidecar_file: string;
  sidecar_sha256: string;
}

export interface FirmwareUpdateArtifact {
  path: string;
  releaseTag: string;
  firmwareVersion: string;
  sha256: string;
}

interface FirmwareReleaseServiceOptions {
  cacheDirectory: string;
  fetchImpl?: typeof fetch;
  releasesUrl?: string;
  publicKey?: string;
}

export class FirmwareReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmwareReleaseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FirmwareReleaseError(`${label} is not valid UTF-8 JSON: ${detail}`);
  }
}

function parseRelease(value: unknown): GitHubRelease | null {
  if (!isRecord(value) || typeof value.tag_name !== 'string') return null;
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') return null;
  if (!Array.isArray(value.assets)) return null;
  const assets: GitHubReleaseAsset[] = [];
  for (const asset of value.assets) {
    if (
      !isRecord(asset)
      || typeof asset.name !== 'string'
      || typeof asset.size !== 'number'
      || typeof asset.browser_download_url !== 'string'
    ) return null;
    assets.push({
      name: asset.name,
      size: asset.size,
      browser_download_url: asset.browser_download_url,
    });
  }
  return {
    tag_name: value.tag_name,
    draft: value.draft,
    prerelease: value.prerelease,
    assets,
  };
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  pattern?: RegExp,
): string {
  const result = value[field];
  if (typeof result !== 'string' || (pattern && !pattern.test(result))) {
    throw new FirmwareReleaseError(`signed firmware manifest has invalid ${field}`);
  }
  return result;
}

export function parseFirmwareManifest(bytes: Buffer, releaseTag: string): FirmwareReleaseManifest {
  const value = parseJson(bytes, 'firmware manifest');
  if (!isRecord(value)) throw new FirmwareReleaseError('signed firmware manifest must be one object');
  const expectedKeys = new Set([
    'schema', 'board', 'build_id', 'firmware_version', 'input_sha256', 'release_tag',
    'source_commit', 'uf2_file', 'uf2_sha256', 'sidecar_file', 'sidecar_sha256',
  ]);
  if (
    Object.keys(value).length !== expectedKeys.size
    || Object.keys(value).some((key) => !expectedKeys.has(key))
    || value.schema !== 1
  ) {
    throw new FirmwareReleaseError('signed firmware manifest has an unsupported schema');
  }

  const board = requireString(value, 'board');
  const buildId = requireString(value, 'build_id', BUILD_ID_PATTERN);
  const firmwareVersion = requireString(value, 'firmware_version', VERSION_PATTERN);
  const inputSha256 = requireString(value, 'input_sha256', SHA256_PATTERN);
  const manifestReleaseTag = requireString(value, 'release_tag', SAFE_NAME_PATTERN);
  const sourceCommit = requireString(value, 'source_commit', COMMIT_PATTERN);
  const uf2File = requireString(value, 'uf2_file', SAFE_NAME_PATTERN);
  const uf2Sha256 = requireString(value, 'uf2_sha256', SHA256_PATTERN);
  const sidecarFile = requireString(value, 'sidecar_file', SAFE_NAME_PATTERN);
  const sidecarSha256 = requireString(value, 'sidecar_sha256', SHA256_PATTERN);

  if (board !== EXPECTED_BOARD) {
    throw new FirmwareReleaseError(`signed firmware targets unexpected board ${board}`);
  }
  if (manifestReleaseTag !== releaseTag) {
    throw new FirmwareReleaseError('signed firmware manifest does not match its GitHub release tag');
  }
  if (!releaseTag.startsWith('firmware-v')) {
    throw new FirmwareReleaseError('signed firmware release tag has an unexpected prefix');
  }
  if (buildId !== inputSha256.slice(0, buildId.length)) {
    throw new FirmwareReleaseError('signed firmware build ID does not match its input digest');
  }
  if (!firmwareVersion.endsWith(`+${buildId}`)) {
    throw new FirmwareReleaseError('signed firmware version does not match its build ID');
  }
  if (!uf2File.endsWith('.uf2') || sidecarFile !== `${uf2File}.json`) {
    throw new FirmwareReleaseError('signed firmware asset names are inconsistent');
  }

  return {
    schema: 1,
    board,
    build_id: buildId,
    firmware_version: firmwareVersion,
    input_sha256: inputSha256,
    release_tag: manifestReleaseTag,
    source_commit: sourceCommit,
    uf2_file: uf2File,
    uf2_sha256: uf2Sha256,
    sidecar_file: sidecarFile,
    sidecar_sha256: sidecarSha256,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareBaseVersions(left: string, right: string): number | null {
  const parse = (version: string): number[] | null => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readResponse(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  if (!response.ok) {
    throw new FirmwareReleaseError(`${label} download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new FirmwareReleaseError(`${label} exceeds the maximum allowed size`);
  }
  if (!response.body) throw new FirmwareReleaseError(`${label} response has no body`);

  const chunks: Buffer[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new FirmwareReleaseError(`${label} exceeds the maximum allowed size`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, received);
}

async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class FirmwareReleaseService {
  private readonly cacheDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly releasesUrl: string;
  private readonly publicKey: string;

  constructor(options: FirmwareReleaseServiceOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.releasesUrl = options.releasesUrl ?? RELEASES_URL;
    this.publicKey = options.publicKey ?? FIRMWARE_SIGNING_PUBLIC_KEY;
  }

  async findUpdate(currentFirmwareVersion: string): Promise<FirmwareUpdateArtifact | null> {
    const releases = await this.fetchBytes(
      this.releasesUrl,
      MAX_RELEASE_LIST_BYTES,
      'firmware release list',
      'application/vnd.github+json',
    );
    const values = parseJson(releases, 'firmware release list');
    if (!Array.isArray(values)) throw new FirmwareReleaseError('firmware release list is not an array');
    const release = values
      .map(parseRelease)
      .find((candidate): candidate is GitHubRelease => Boolean(
        candidate
        && !candidate.draft
        && candidate.prerelease
        && candidate.tag_name.startsWith('firmware-v'),
      ));
    if (!release) return null;

    const manifestAsset = this.requireUniqueAsset(release, MANIFEST_NAME, MAX_MANIFEST_BYTES);
    const signatureAsset = this.requireUniqueAsset(release, SIGNATURE_NAME, 128);
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.fetchBytes(manifestAsset.browser_download_url, MAX_MANIFEST_BYTES, 'firmware manifest'),
      this.fetchBytes(signatureAsset.browser_download_url, 128, 'firmware signature'),
    ]);
    if (signatureBytes.length !== 64) {
      throw new FirmwareReleaseError('firmware manifest signature has an invalid length');
    }
    if (!verifySignature(null, manifestBytes, this.publicKey, signatureBytes)) {
      throw new FirmwareReleaseError('firmware manifest signature is not trusted');
    }

    const manifest = parseFirmwareManifest(manifestBytes, release.tag_name);
    if (manifest.firmware_version === currentFirmwareVersion) return null;
    if ((compareBaseVersions(currentFirmwareVersion, manifest.firmware_version) ?? 0) > 0) {
      return null;
    }

    const uf2Asset = this.requireUniqueAsset(release, manifest.uf2_file, MAX_UF2_BYTES);
    const releaseDirectory = path.join(this.cacheDirectory, manifest.release_tag);
    const destination = path.join(releaseDirectory, manifest.uf2_file);
    try {
      const cached = await fs.promises.readFile(destination);
      if (cached.length <= MAX_UF2_BYTES && sha256(cached) === manifest.uf2_sha256) {
        return {
          path: destination,
          releaseTag: manifest.release_tag,
          firmwareVersion: manifest.firmware_version,
          sha256: manifest.uf2_sha256,
        };
      }
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
    }

    const uf2Bytes = await this.fetchBytes(
      uf2Asset.browser_download_url,
      MAX_UF2_BYTES,
      'firmware UF2',
      'application/octet-stream',
    );
    const actualDigest = sha256(uf2Bytes);
    if (actualDigest !== manifest.uf2_sha256) {
      throw new FirmwareReleaseError('downloaded firmware UF2 does not match its signed SHA-256');
    }
    await writeAtomically(destination, uf2Bytes);
    return {
      path: destination,
      releaseTag: manifest.release_tag,
      firmwareVersion: manifest.firmware_version,
      sha256: manifest.uf2_sha256,
    };
  }

  private requireUniqueAsset(
    release: GitHubRelease,
    name: string,
    maximumBytes: number,
  ): GitHubReleaseAsset {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) {
      throw new FirmwareReleaseError(`firmware release must contain exactly one ${name}`);
    }
    const asset = matches[0];
    if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximumBytes) {
      throw new FirmwareReleaseError(`firmware release asset ${name} has an invalid size`);
    }
    return asset;
  }

  private async fetchBytes(
    url: string,
    maximumBytes: number,
    label: string,
    accept = 'application/octet-stream',
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'Open-Memo-Firmware-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      return await readResponse(response, maximumBytes, label);
    } catch (error) {
      if (error instanceof FirmwareReleaseError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new FirmwareReleaseError(`${label} could not be downloaded: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
