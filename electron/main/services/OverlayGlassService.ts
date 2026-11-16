import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RectangleLike } from './overlayPosition';

let helper: ChildProcess | null = null;

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'overlay-glass', 'memo-overlay-glass')
    : path.join(app.getAppPath(), '.build', 'overlay-glass', 'memo-overlay-glass');
}

function ensureHelper(): ChildProcess | null {
  if (helper) return helper;
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath())) return null;
  const child = spawn(helperPath(), [], { stdio: ['pipe', 'ignore', 'ignore'] });
  const clear = (error?: Error) => {
    if (error) console.warn('[Overlay] Glass helper stopped:', error.message);
    if (helper === child) helper = null;
  };
  child.once('error', clear);
  child.once('exit', () => clear());
  child.stdin?.on('error', clear);
  helper = child;
  return child;
}

/** Shows the native glass and returns whether it is available. */
export function showOverlayGlass(bounds: RectangleLike): boolean {
  const child = ensureHelper();
  if (!child?.stdin?.writable) return false;
  child.stdin.write(`show ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}\n`);
  return true;
}

export function hideOverlayGlass(): void {
  if (helper?.stdin?.writable) helper.stdin.write('hide\n');
}
