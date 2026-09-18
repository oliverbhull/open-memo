import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';

export const MODEL_PACK_NAMES = ['conomo', 'pnc', 'cleanup'] as const;
export type ModelPackName = typeof MODEL_PACK_NAMES[number];

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
  return ['model-pack.json', 'manifest.json', 'model/model.safetensors', 'model/memo-cleanup-model.json', 'runtime/bin/python', 'worker/transcript-cleanup-worker.py', 'VERSIONS'];
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

let installation: Promise<void> | null = null;

export function ensurePersistentModelPacks(): Promise<void> {
  if (!installation) {
    installation = Promise.all(MODEL_PACK_NAMES.map(name => installBundledModelPack(name)))
      .then(() => undefined)
      .catch(error => {
        installation = null;
        throw error;
      });
  }
  return installation;
}
