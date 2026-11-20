import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

const execFileAsync = (command: string, args: string[], options: { timeout: number }) => promisify(execFile)(command, args, options);
export const MODEL_ASSET_DIRECTORIES = { conomo: 'model', pnc: 'compiled' } as const;
export type ModelAssetName = keyof typeof MODEL_ASSET_DIRECTORIES;
interface Asset {
  version: string;
  url: string;
  bytes: number;
  sha256: string;
  files: Record<string, { bytes: number; sha256: string }>;
}
interface AssetContract { schemaVersion: 1; assets: Record<ModelAssetName, Asset> }

function readContract(resources: string): AssetContract | null {
  const file = path.join(resources, 'model-assets.json');
  if (!fs.existsSync(file)) return null; // Full installers remain self-contained.
  const contract = JSON.parse(fs.readFileSync(file, 'utf8')) as AssetContract;
  if (contract.schemaVersion !== 1) throw new Error('Unsupported model assets contract');
  for (const name of Object.keys(MODEL_ASSET_DIRECTORIES) as ModelAssetName[]) {
    const asset = contract.assets?.[name];
    if (!asset || !/^[a-f0-9]{64}$/u.test(asset.version) || !/^[a-f0-9]{64}$/u.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !Object.keys(asset.files ?? {}).length) {
      throw new Error(`Invalid ${name} model assets`);
    }
    const url = new URL(asset.url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/oliverbhull/open-memo/releases/download/')
      || url.username || url.password || url.search || url.hash) throw new Error('Invalid model assets URL');
    const aggregate = createHash('sha256');
    for (const relative of Object.keys(asset.files).sort()) {
      const entry = asset.files[relative];
      if (!entry || !relative || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')
        || relative.includes('\\') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        throw new Error('Invalid model assets file');
      }
      aggregate.update(relative).update('\0').update(String(entry.bytes)).update('\0').update(entry.sha256).update('\n');
    }
    if (aggregate.digest('hex') !== asset.version) throw new Error('Invalid model assets version');
  }
  return contract;
}

function assetStore(name: ModelAssetName, version: string): string {
  return path.join(app.getPath('userData'), 'model-assets', name, version);
}

export function resolveModelAssetPath(name: ModelAssetName, runtimeRoot: string): string {
  if (app.isPackaged && process.platform === 'darwin') {
    const asset = readContract(process.resourcesPath)?.assets[name];
    if (asset) return assetStore(name, asset.version);
  }
  return path.join(runtimeRoot, MODEL_ASSET_DIRECTORIES[name]);
}

async function verify(root: string, asset: Asset): Promise<void> {
  if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new Error('Model asset root is a symbolic link');
  for (const [relative, expected] of Object.entries(asset.files)) {
    const file = path.join(root, relative);
    // Assets contain data only. Never follow a link outside the verified tree.
    let current = root;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error('Model asset contains a symbolic link');
    }
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('Model asset size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) throw new Error('Model asset checksum mismatch');
  }
}

function responseFor(url: URL, redirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (!redirects || next.protocol !== 'https:') return reject(new Error('Invalid model download redirect'));
        responseFor(next, redirects - 1).then(resolve, reject);
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Model download failed: HTTP ${response.statusCode}`));
      } else {
        response.setTimeout(60_000, () => response.destroy(new Error('Model download timed out')));
        resolve(response);
      }
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Model connection timed out')));
    request.on('error', reject);
  });
}

/** Called only after the staged app's signature has been verified. Old assets
 * stay in place for the running app and rollback; activation follows app version. */
export async function prepareModelAssets(resources: string, sourceResources: string[] = []): Promise<void> {
  const contract = readContract(resources);
  if (!contract) return;
  for (const name of Object.keys(MODEL_ASSET_DIRECTORIES) as ModelAssetName[]) {
    const asset = contract.assets[name];
    const destination = assetStore(name, asset.version);
    try { await verify(destination, asset); continue; } catch { /* Recover missing or damaged cache. */ }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const staging = await fs.promises.mkdtemp(`${destination}.staging-`);
    const archive = `${staging}.tar.gz`;
    try {
      let copied = false;
      for (const source of sourceResources) {
        const candidate = path.join(source, name, MODEL_ASSET_DIRECTORIES[name]);
        try { await verify(candidate, asset); } catch { continue; }
        // Copy just the files in the signed contract, avoiding build caches.
        for (const relative of Object.keys(asset.files)) {
          const target = path.join(staging, relative);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.copyFile(path.join(candidate, relative), target);
        }
        copied = true;
        break;
      }
      if (!copied) {
        const response = await responseFor(new URL(asset.url));
        let bytes = 0;
        const hash = createHash('sha256');
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > asset.bytes) return callback(new Error('Model download exceeded expected size'));
          hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(response, meter, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Model download integrity check failed');
        await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', staging], { timeout: 120_000 });
      }
      await verify(staging, asset);
      await fs.promises.rm(destination, { recursive: true, force: true });
      await fs.promises.rename(staging, destination);
    } finally {
      await fs.promises.rm(archive, { force: true });
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }
}
