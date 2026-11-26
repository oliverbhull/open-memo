import { app } from 'electron';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { prepareModelAssets, resolveModelAssetPath } from './ModelAssets';

export const MODEL_PACK_NAMES = ['conomo', 'pnc'] as const;
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
  if (name === 'conomo' && process.platform === 'win32') {
    return ['model-pack.json', 'manifest.json', 'memo-nemotron-worker.exe', 'nemotron-en-q8.gguf', 'Notice.txt', 'NVIDIA-Open-Model-License.html'];
  }
  if (name === 'conomo') return ['model-pack.json', 'conomo', 'VERSIONS', 'device-runtime/bin/python3.12'];
  return ['model-pack.json', 'memo-pnc', 'tokenizer.vocab', 'manifest.json', 'VERSIONS'];
}

export function isCompleteModelPack(name: ModelPackName, root: string): boolean {
  const paths = requiredPaths(name);
  if (name === 'conomo' && process.platform !== 'win32') {
    paths.push(...(fs.existsSync(path.join(root, 'runtime/model_assets.py'))
      ? ['runtime/worker.py', 'MODEL-LICENSE']
      : ['runtime/conomo/model-manifest.json']));
  }
  return paths.every(relative => fs.existsSync(path.join(root, relative)))
    && (process.platform === 'win32' || fs.existsSync(resolveModelAssetPath(name, root)));
}

async function verifyModelPack(name: ModelPackName, root: string): Promise<void> {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'model-pack.json'), 'utf8')) as PackManifest;
  if (manifest.schemaVersion !== 1 || manifest.name !== name || !/^[a-f0-9]{64}$/u.test(manifest.version)) {
    throw new Error(`${name} model pack manifest is invalid`);
  }
  if (name === 'conomo' && process.platform === 'win32' && !manifest.files?.['nemotron-en-q8.gguf']) {
    throw new Error('Conomo model pack manifest is missing the Nemotron weights');
  }
  const aggregate = createHash('sha256');
  for (const relative of Object.keys(manifest.files).sort()) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`Unsafe model pack path: ${relative}`);
    const expected = manifest.files[relative];
    if (!expected) throw new Error(`${name} model pack manifest entry is missing: ${relative}`);
    const target = path.join(root, relative);
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size !== expected.bytes) throw new Error(`${name} model pack file size mismatch: ${relative}`);
    const fileHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) fileHash.update(chunk);
    const digest = fileHash.digest('hex');
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
  if (process.platform === 'win32' && name === 'conomo') {
    return app.isPackaged ? bundledPackPath(name) : path.join(process.cwd(), '.build', 'windows', name);
  }
  if (!app.isPackaged) return path.join(process.cwd(), '.build', name);
  if (verifiedBundledPacks.has(name)) return bundledPackPath(name);
  const active = readActivePack(name);
  if (active) {
    const installed = path.join(packStoreRoot(), name, active.version);
    if (isCompleteModelPack(name, installed)) return installed;
    logger.warn(`[ModelPackService] Ignoring incomplete active ${name} pack ${active.version}`);
  }
  return bundledPackPath(name);
}

const verifiedBundledPacks = new Set<ModelPackName>();

function compiledModelPath(root: string): string {
  const compiled = resolveModelAssetPath('pnc', root);
  const models = fs.readdirSync(compiled).filter(name => name.endsWith('.mlmodelc'));
  if (models.length !== 1) throw new Error(`Expected one compiled model in ${compiled}`);
  return path.join(compiled, models[0]!);
}

function expectWorkerReady(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, timeout: 120_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error || stdout.split(/\r?\n/u)[0] !== 'READY') {
        reject(new Error(`Bundled model worker failed: ${(stderr || error?.message || stdout).trim().slice(0, 500)}`));
      } else {
        resolve();
      }
    });
    child.stdin?.end();
  });
}

async function verifyInstalledPack(name: 'conomo' | 'pnc'): Promise<string> {
  const source = bundledPackPath(name);
  if (!isCompleteModelPack(name, source)) throw new Error(`Bundled ${name} pack is incomplete`);
  await verifyModelPack(name, source);
  return source;
}

let windowsConomoVerification: Promise<string> | undefined;

export function verifyBundledWindowsConomo(): Promise<string> {
  return windowsConomoVerification ??= verifyInstalledPack('conomo');
}

export async function verifyBundledModelPacks(): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    await verifyBundledWindowsConomo();
    return;
  }
  await prepareModelAssets(process.resourcesPath);
  for (const name of ['conomo', 'pnc'] as const) {
    const source = await verifyInstalledPack(name);
    if (name === 'conomo') {
      await expectWorkerReady(path.join(source, 'conomo'), ['--worker'], { ...process.env, CONOMO_MODEL_DIR: resolveModelAssetPath('conomo', source) });
    } else {
      await expectWorkerReady(path.join(source, 'memo-pnc'), [
        '--model-path', compiledModelPath(source),
        '--vocabulary-path', path.join(source, 'tokenizer.vocab'),
        '--worker',
      ]);
    }
    verifiedBundledPacks.add(name);
  }
}

export async function removeLegacyBundledModelPacks(): Promise<void> {
  if (!app.isPackaged || !verifiedBundledPacks.has('conomo') || !verifiedBundledPacks.has('pnc')) return;
  await Promise.all((['conomo', 'pnc'] as const).map(name =>
    fs.promises.rm(path.join(packStoreRoot(), name), { recursive: true, force: true })));
  logger.info('[ModelPackService] Removed legacy duplicate Conomo and punctuation packs');
}
