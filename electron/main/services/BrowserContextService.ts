import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ReplySnapshot } from '../../shared/emailContext';

/** Metadata failures must never prevent paste or save. No browser scripting or Gmail API. */
export function captureBrowserReply(): Promise<ReplySnapshot | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-context', 'memo-browser-context')
    : path.join(app.getAppPath(), '.build', 'browser-context', 'memo-browser-context');
  return new Promise(resolve => {
    execFile(helper, [], { encoding: 'utf8', timeout: 600, maxBuffer: 32 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        const snapshot = JSON.parse(stdout);
        resolve(snapshot && typeof snapshot.bundleId === 'string' && typeof snapshot.windowTitle === 'string' && typeof snapshot.documentURL === 'string' ? snapshot : undefined);
      } catch { resolve(undefined); }
    });
  });
}
