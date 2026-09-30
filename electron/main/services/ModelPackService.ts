import { app } from 'electron';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import { logger } from '../utils/logger';

export const MODEL_PACK_NAMES = ['conomo', 'pnc', 'cleanup'] as const;
export type ModelPackName = typeof MODEL_PACK_NAMES[number];

const CLEANUP_PACK_URL = 'https://github.com/oliverbhull/open-memo/releases/download/cleanup-model-v1/open-memo-cleanup-v1.tar.gz';
const CLEANUP_PACK_BYTES = 1_034_639_401;
const CLEANUP_PACK_SHA256 = '932c010ad09edf1331486a134c59b0fc5b850d78a2f15db839d79c1a5f6530c0';
const CLEANUP_PACK_VERSION = CLEANUP_PACK_SHA256.slice(0, 20);

export interface ModelPackDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

interface ActivePack {
  schemaVersion: 1;
  name: ModelPackName;
  version: string;
  installedAt: string;
}

interface PackManifest {
  schemaVersion: 1;
  name: ModelPackName;
  version: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

function packStoreRoot(): string {
  return path.join(app.getPath('userData'), 'model-packs');
}

function bundledPackPath(name: ModelPackName): string {
  return path.join(process.resourcesPath, name);
}

function activeManifestPath(name: ModelPackName): string {
  return path.join(packStoreRoot(), name, 'active.json');
}

function requiredPaths(name: ModelPackName): string[] {
  if (name === 'conomo') return ['model-pack.json', 'conomo', 'compiled', 'tokenizer.json', 'manifest.json', 'VERSIONS', 'device-runtime/bin/python3.12'];
  if (name === 'pnc') return ['model-pack.json', 'memo-pnc', 'compiled', 'tokenizer.vocab', 'manifest.json', 'VERSIONS'];
  return ['manifest.json', 'model/model.safetensors', 'model/memo-cleanup-model.json', 'runtime/bin/python', 'worker/transcript-cleanup-worker.py', 'VERSIONS'];
}

export function isCompleteModelPack(name: ModelPackName, root: string): boolean {
  return requiredPaths(name).every(relative => fs.existsSync(path.join(root, relative)));
}

export function modelPackVersion(root: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'model-pack.json'), 'utf8')) as PackManifest;
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(manifest.version)) {
    throw new Error('Model pack manifest is invalid');
  }
  return manifest.version.slice(0, 20);
}

async function verifyModelPack(name: ModelPackName, root: string): Promise<void> {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'model-pack.json'), 'utf8')) as PackManifest;
  if (manifest.schemaVersion !== 1 || manifest.name !== name || !/^[a-f0-9]{64}$/u.test(manifest.version)) {
    throw new Error(`${name} model pack manifest is invalid`);
  }
  const aggregate = createHash('sha256');
  for (const relative of Object.keys(manifest.files).sort()) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`Unsafe model pack path: ${relative}`);
    const expected = manifest.files[relative];
    if (!expected) throw new Error(`${name} model pack manifest entry is missing: ${relative}`);
    const target = path.join(root, relative);
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size !== expected.bytes) throw new Error(`${name} model pack file size mismatch: ${relative}`);
    const digest = createHash('sha256').update(await fs.promises.readFile(target)).digest('hex');
    if (digest !== expected.sha256) throw new Error(`${name} model pack checksum mismatch: ${relative}`);
    aggregate.update(relative).update('\0').update(String(expected.bytes)).update('\0').update(digest).update('\n');
  }
  if (aggregate.digest('hex') !== manifest.version) throw new Error(`${name} model pack version mismatch`);
}

function readActivePack(name: ModelPackName): ActivePack | null {
  try {
    const value = JSON.parse(fs.readFileSync(activeManifestPath(name), 'utf8')) as ActivePack;
    if (value.schemaVersion !== 1 || value.name !== name || !/^[a-f0-9]{20}$/u.test(value.version)) return null;
    return value;
  } catch {
    return null;
  }
}

export function resolveModelPackPath(name: ModelPackName): string {
  if (!app.isPackaged) return path.join(process.cwd(), '.build', name);
  const active = readActivePack(name);
  if (active) {
    const installed = path.join(packStoreRoot(), name, active.version);
    if (isCompleteModelPack(name, installed)) return installed;
    logger.warn(`[ModelPackService] Ignoring incomplete active ${name} pack ${active.version}`);
  }
  return bundledPackPath(name);
}

async function copyPack(source: string, destination: string): Promise<void> {
  await fs.promises.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    // APFS clone-on-write keeps first migration fast and avoids temporarily
    // consuming another copy of multi-gigabyte model data where supported.
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

export async function installBundledModelPack(name: ModelPackName): Promise<string | null> {
  if (!app.isPackaged) return null;
  const source = bundledPackPath(name);
  if (!isCompleteModelPack(name, source)) {
    const installed = readActivePack(name);
    if (installed) return path.join(packStoreRoot(), name, installed.version);
    logger.warn(`[ModelPackService] No bundled or installed ${name} pack is available`);
    return null;
  }

  const version = modelPackVersion(source);
  const packDirectory = path.join(packStoreRoot(), name);
  const destination = path.join(packDirectory, version);
  await fs.promises.mkdir(packDirectory, { recursive: true });
  if (!isCompleteModelPack(name, destination)) {
    const staging = path.join(packDirectory, `.${version}.${process.pid}.staging`);
    await fs.promises.rm(staging, { recursive: true, force: true });
    try {
      await copyPack(source, staging);
      if (!isCompleteModelPack(name, staging)) throw new Error(`Copied ${name} pack is incomplete`);
      await verifyModelPack(name, staging);
      await fs.promises.rename(staging, destination);
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true });
      if (!isCompleteModelPack(name, destination)) throw error;
    }
  }

  const active: ActivePack = {
    schemaVersion: 1,
    name,
    version,
    installedAt: new Date().toISOString(),
  };
  const activePath = activeManifestPath(name);
  const temporary = `${activePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temporary, activePath);
  logger.info(`[ModelPackService] ${name} pack ${version} is persistent`);
  return destination;
}

function downloadResponse(url: URL, redirectsRemaining = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': `Open-Memo/${app.getVersion()}` } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining === 0) return reject(new Error('Cleaned download redirected too many times.'));
        const next = new URL(response.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Cleaned download was redirected to an insecure URL.'));
        downloadResponse(next, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Cleaned download failed with HTTP ${status}.`));
        return;
      }
      response.setTimeout(60_000, () => response.destroy(new Error('Cleaned download timed out.')));
      resolve(response);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Cleaned download connection timed out.')));
    request.on('error', reject);
  });
}

function extractArchive(archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], error => {
      if (error) reject(error); else resolve();
    });
  });
}

let cleanupDownload: Promise<string> | null = null;

export function isCleanupModelPackInstalled(): boolean {
  const active = readActivePack('cleanup');
  return Boolean(active && isCompleteModelPack('cleanup', path.join(packStoreRoot(), 'cleanup', active.version)));
}

export function installCleanupModelPack(
  onProgress?: (progress: ModelPackDownloadProgress) => void,
): Promise<string> {
  const existing = readActivePack('cleanup');
  if (existing) {
    const installed = path.join(packStoreRoot(), 'cleanup', existing.version);
    if (isCompleteModelPack('cleanup', installed)) return Promise.resolve(installed);
  }
  if (cleanupDownload) return cleanupDownload;

  cleanupDownload = (async () => {
    const packDirectory = path.join(packStoreRoot(), 'cleanup');
    const destination = path.join(packDirectory, CLEANUP_PACK_VERSION);
    const archive = path.join(packDirectory, `.${CLEANUP_PACK_VERSION}.tar.gz.part`);
    const staging = path.join(packDirectory, `.${CLEANUP_PACK_VERSION}.${process.pid}.staging`);
    await fs.promises.mkdir(packDirectory, { recursive: true });
    await fs.promises.rm(archive, { force: true });
    await fs.promises.rm(staging, { recursive: true, force: true });
    let downloadedBytes = 0;
    try {
      const response = await downloadResponse(new URL(CLEANUP_PACK_URL));
      const hash = createHash('sha256');
      let lastProgressAt = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > CLEANUP_PACK_BYTES) return callback(new Error('Cleaned download exceeded its expected size.'));
          hash.update(chunk);
          const now = Date.now();
          if (now - lastProgressAt >= 150) {
            lastProgressAt = now;
            onProgress?.({ downloadedBytes, totalBytes: CLEANUP_PACK_BYTES });
          }
          callback(null, chunk);
        },
      });
      await pipeline(response, meter, fs.createWriteStream(archive, { flags: 'wx' }));
      if (downloadedBytes !== CLEANUP_PACK_BYTES || hash.digest('hex') !== CLEANUP_PACK_SHA256) {
        throw new Error('Cleaned download failed its integrity check.');
      }
      await fs.promises.mkdir(staging, { recursive: true });
      await extractArchive(archive, staging);
      if (!isCompleteModelPack('cleanup', staging)) throw new Error('Downloaded Cleaned package is incomplete.');
      await fs.promises.rm(destination, { recursive: true, force: true });
      await fs.promises.rename(staging, destination);
      const active: ActivePack = {
        schemaVersion: 1, name: 'cleanup', version: CLEANUP_PACK_VERSION, installedAt: new Date().toISOString(),
      };
      const activePath = activeManifestPath('cleanup');
      await fs.promises.writeFile(`${activePath}.tmp`, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(`${activePath}.tmp`, activePath);
      onProgress?.({ downloadedBytes: CLEANUP_PACK_BYTES, totalBytes: CLEANUP_PACK_BYTES });
      logger.info(`[ModelPackService] cleanup pack ${CLEANUP_PACK_VERSION} downloaded`);
      return destination;
    } finally {
      await fs.promises.rm(archive, { force: true }).catch(() => undefined);
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  })().finally(() => { cleanupDownload = null; });
  return cleanupDownload;
}

let installation: Promise<void> | null = null;

export function ensurePersistentModelPacks(): Promise<void> {
  if (!installation) {
    installation = Promise.all((['conomo', 'pnc'] as ModelPackName[]).map(name => installBundledModelPack(name)))
      .then(() => undefined)
      .catch(error => {
        installation = null;
        throw error;
      });
  }
  return installation;
}
