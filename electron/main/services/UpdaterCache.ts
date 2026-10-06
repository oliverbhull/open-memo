import fs from 'node:fs/promises';
import path from 'node:path';

function versionParts(value: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) return null;
  return value.split('.').map(Number);
}

function isInstalledOrOlder(cachedVersion: string, installedVersion: string): boolean {
  const cached = versionParts(cachedVersion);
  const installed = versionParts(installedVersion);
  if (!cached || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (cached[index] !== installed[index]) return cached[index]! < installed[index]!;
  }
  return true;
}

export async function pruneUpdaterCache(cacheDir: string, installedVersion: string): Promise<void> {
  // MacUpdater otherwise keeps a second full ZIP for differential downloads.
  // Memo disables differential downloads, so this copy has no purpose.
  await fs.rm(path.join(cacheDir, 'update.zip'), { force: true });

  const pendingDir = path.join(cacheDir, 'pending');
  let fileName: unknown;
  try {
    const info = JSON.parse(await fs.readFile(path.join(pendingDir, 'update-info.json'), 'utf8')) as { fileName?: unknown };
    fileName = info.fileName;
  } catch {
    return;
  }
  const cachedVersion = typeof fileName === 'string'
    ? /^Open-Memo-(\d+\.\d+\.\d+)-arm64\.zip$/u.exec(fileName)?.[1]
    : undefined;
  if (cachedVersion && isInstalledOrOlder(cachedVersion, installedVersion)) {
    await fs.rm(pendingDir, { recursive: true, force: true });
  }
}
