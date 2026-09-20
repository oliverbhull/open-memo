import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';

function dictationBinaryPath(): string | null {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'dictation', 'memo-dictation'),
        path.join(app.getAppPath(), '..', '..', 'Resources', 'dictation', 'memo-dictation'),
        path.join(process.resourcesPath, 'memo-dictation'),
      ]
    : [path.join(process.cwd(), '.build', 'dictation', 'memo-dictation')];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

export async function checkInputMonitoringPermission(request: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const binary = dictationBinaryPath();
  if (!binary) {
    logger.warn('[Permissions] Dictation helper unavailable for Input Monitoring probe');
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const child = spawn(binary, [request ? '--request-input-monitoring' : '--check-input-monitoring'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MEMO_PARENT_PID: String(process.pid) },
    });
    let output = '';
    let settled = false;
    const finish = (granted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(granted);
    };
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.includes('HOTKEY_READY')) finish(true);
      if (output.includes('HOTKEY_PERMISSION_REQUIRED')) finish(false);
    });
    child.on('error', error => {
      logger.warn('[Permissions] Input Monitoring probe failed:', error);
      finish(false);
    });
    child.on('close', code => finish(code === 0 && output.includes('HOTKEY_READY')));
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);
  });
}
