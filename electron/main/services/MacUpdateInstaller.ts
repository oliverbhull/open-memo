import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareModelAssets } from './ModelAssets';

const execFileAsync = promisify(execFile);

export interface PreparedMacUpdate {
  install(): void | Promise<void>;
  discard?(): Promise<void>;
}

export interface MacUpdateInstallerLike {
  prune?(): Promise<void>;
  prepare(downloadedFile: string, expectedVersion: string): Promise<PreparedMacUpdate>;
}

export const updateHelperScript = `#!/bin/sh
set -u

parent_pid="$1"
staged_app="$2"
target_app="$3"
backup_app="$4"
work_root="$5"
new_executable="$target_app/Contents/MacOS/Memo"

while /bin/kill -0 "$parent_pid" 2>/dev/null; do
  /bin/sleep 0.1
done

rollback() {
  if [ -d "$backup_app" ]; then
    /bin/rm -rf "$target_app"
    if /bin/mv "$backup_app" "$target_app"; then
      /usr/bin/open "$target_app" --args --memo-update-failed || true
    fi
  fi
}

if ! /bin/mv "$target_app" "$backup_app"; then
  /usr/bin/open "$target_app" --args --memo-update-failed || true
  exit 1
fi
if ! /bin/mv "$staged_app" "$target_app"; then
  rollback
  exit 1
fi

if ! /usr/bin/open "$target_app"; then
  rollback
  exit 1
fi

/bin/sleep 10
if /usr/bin/pgrep -f "$new_executable" >/dev/null 2>&1; then
  /bin/rm -rf "$backup_app"
  /bin/rm -rf "$work_root"
  exit 0
fi

rollback
exit 1
`;

function installedAppPath(): string {
  return path.resolve(path.dirname(process.execPath), '..', '..');
}

async function signingIdentity(filePath: string): Promise<{ team: string; identifier: string; hash: string }> {
  const result = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', filePath]);
  const output = `${result.stdout}\n${result.stderr}`;
  const team = output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim();
  const identifier = output.match(/^Identifier=(.+)$/mu)?.[1]?.trim();
  const hash = output.match(/^CDHash=(.+)$/mu)?.[1]?.trim();
  if (!team || team === 'not set' || !identifier || !hash) {
    throw new Error(`Could not identify the signed app at ${filePath}.`);
  }
  return { team, identifier, hash };
}

async function writableInstalledApp(runningApp: string, identity: Awaited<ReturnType<typeof signingIdentity>>): Promise<string> {
  const target = await fs.promises.realpath(runningApp);
  if (!target.split(path.sep).includes('AppTranslocation')) {
    await fs.promises.access(path.dirname(target), fs.constants.W_OK | fs.constants.X_OK);
    return target;
  }

  // Gatekeeper launches the app from a read-only path. Only update an installed
  // copy if its signed executable exactly matches the running app.
  const matches = new Set<string>();
  for (const candidate of ['/Applications/Memo.app', path.join(app.getPath('home'), 'Applications', 'Memo.app')]) {
    try {
      const installed = await fs.promises.realpath(candidate);
      if (installed.split(path.sep).includes('AppTranslocation')) continue;
      await fs.promises.access(path.dirname(installed), fs.constants.W_OK | fs.constants.X_OK);
      const installedIdentity = await signingIdentity(installed);
      if (installedIdentity.team === identity.team && installedIdentity.identifier === identity.identifier
          && installedIdentity.hash === identity.hash) {
        await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
        matches.add(installed);
      }
    } catch {
      // The candidate may be absent, unwritable, or a different unsigned app.
    }
  }
  const [installed, ...otherMatches] = matches;
  if (!installed || otherMatches.length) {
    throw new Error('Launch the installed copy of Memo from Applications to update it.');
  }
  return installed;
}

export class MacUpdateInstaller implements MacUpdateInstallerLike {
  constructor(private readonly runningApp = installedAppPath()) {}

  async prune(): Promise<void> {
    const userData = app.getPath('userData');
    const directories = await fs.promises.readdir(userData, { withFileTypes: true });
    for (const directory of directories) {
      if (!directory.isDirectory() || !directory.name.startsWith('prepared-update-')) continue;
      const root = path.join(userData, directory.name);
      // A previous app is a rollback copy, owned by the install helper.
      if (fs.existsSync(path.join(root, 'Previous Memo.app'))) continue;
      try {
        const owner = JSON.parse(await fs.promises.readFile(path.join(root, 'owner.json'), 'utf8')) as { pid: number };
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) continue;
        try { process.kill(owner.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fs.promises.rm(root, { recursive: true, force: true });
        }
      } catch { /* Retain unrecognized or legacy preparations. */ }
    }
  }

  async prepare(downloadedFile: string, expectedVersion: string): Promise<PreparedMacUpdate> {
    if (process.platform !== 'darwin') throw new Error('The staged updater is macOS-only.');
    if (!path.isAbsolute(downloadedFile) || !fs.existsSync(downloadedFile)) {
      throw new Error('The downloaded update is unavailable.');
    }

    const currentIdentity = await signingIdentity(this.runningApp);
    const targetApp = await writableInstalledApp(this.runningApp, currentIdentity);
    const workRoot = await fs.promises.mkdtemp(path.join(app.getPath('userData'), 'prepared-update-'));
    try {
      await fs.promises.writeFile(path.join(workRoot, 'owner.json'), JSON.stringify({ pid: process.pid }));
      const extractedRoot = path.join(workRoot, 'extracted');
      await fs.promises.mkdir(extractedRoot);
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', downloadedFile, extractedRoot]);

      const stagedApp = path.join(extractedRoot, 'Memo.app');
      const stagedExecutable = path.join(stagedApp, 'Contents', 'MacOS', 'Memo');
      if (!fs.existsSync(stagedExecutable)) throw new Error('The update does not contain Memo.app.');

      const version = (await execFileAsync('/usr/bin/defaults', [
        'read', path.join(stagedApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString',
      ])).stdout.trim();
      if (version !== expectedVersion) throw new Error(`Expected Memo ${expectedVersion}, received ${version}.`);

      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);
      await execFileAsync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', stagedApp]);
      const stagedIdentity = await signingIdentity(stagedApp);
      if (currentIdentity.team !== stagedIdentity.team || currentIdentity.identifier !== stagedIdentity.identifier) {
        throw new Error('The update does not match the installed app’s signing identity.');
      }

      await prepareModelAssets(path.join(stagedApp, 'Contents', 'Resources'), [path.join(targetApp, 'Contents', 'Resources')]);

      const helperPath = path.join(workRoot, 'install-update.sh');
      const backupApp = path.join(workRoot, 'Previous Memo.app');
      await fs.promises.writeFile(helperPath, updateHelperScript, { mode: 0o700 });

      return {
        discard: () => fs.promises.rm(workRoot, { recursive: true, force: true }),
        install: async () => {
          const log = await fs.promises.open(path.join(workRoot, 'install.log'), 'a');
          try {
            const child = spawn('/bin/sh', [
              helperPath,
              String(process.pid),
              stagedApp,
              targetApp,
              backupApp,
              workRoot,
            ], { detached: true, stdio: ['ignore', log.fd, log.fd] });
            await once(child, 'spawn');
            child.unref();
          } finally {
            await log.close();
          }
          app.quit();
        },
      };
    } catch (error) {
      await fs.promises.rm(workRoot, { recursive: true, force: true });
      throw error;
    }
  }
}
