import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PreparedMacUpdate {
  install(): void;
}

export interface MacUpdateInstallerLike {
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
    /bin/mv "$backup_app" "$target_app"
    /usr/bin/open "$target_app" >/dev/null 2>&1 || true
  fi
}

/bin/mv "$target_app" "$backup_app" || exit 1
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

async function teamIdentifier(filePath: string): Promise<string> {
  const result = await execFileAsync('/usr/bin/codesign', ['--display', '--verbose=4', filePath]);
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/^TeamIdentifier=(.+)$/mu);
  if (!match?.[1]) throw new Error(`No signing team found for ${filePath}`);
  return match[1].trim();
}

export class MacUpdateInstaller implements MacUpdateInstallerLike {
  constructor(private readonly targetApp = installedAppPath()) {}

  async prepare(downloadedFile: string, expectedVersion: string): Promise<PreparedMacUpdate> {
    if (process.platform !== 'darwin') throw new Error('The staged updater is macOS-only.');
    if (!path.isAbsolute(downloadedFile) || !fs.existsSync(downloadedFile)) {
      throw new Error('The downloaded update is unavailable.');
    }

    const workRoot = await fs.promises.mkdtemp(path.join(app.getPath('userData'), 'prepared-update-'));
    const extractedRoot = path.join(workRoot, 'extracted');
    await fs.promises.mkdir(extractedRoot);
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', downloadedFile, extractedRoot]);

    const stagedApp = path.join(extractedRoot, 'Memo.app');
    const stagedExecutable = path.join(stagedApp, 'Contents', 'MacOS', 'Memo');
    const targetApp = this.targetApp;
    if (!fs.existsSync(stagedExecutable)) throw new Error('The update does not contain Memo.app.');

    const version = (await execFileAsync('/usr/bin/defaults', [
      'read', path.join(stagedApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString',
    ])).stdout.trim();
    if (version !== expectedVersion) throw new Error(`Expected Memo ${expectedVersion}, received ${version}.`);

    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);
    await execFileAsync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', stagedApp]);
    const [currentTeam, stagedTeam] = await Promise.all([
      teamIdentifier(targetApp),
      teamIdentifier(stagedApp),
    ]);
    if (currentTeam !== stagedTeam) throw new Error('The update was signed by a different Apple team.');

    const helperPath = path.join(workRoot, 'install-update.sh');
    const backupApp = path.join(workRoot, 'Previous Memo.app');
    await fs.promises.writeFile(helperPath, updateHelperScript, { mode: 0o700 });

    return {
      install: () => {
        const child = spawn('/bin/sh', [
          helperPath,
          String(process.pid),
          stagedApp,
          targetApp,
          backupApp,
          workRoot,
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        app.quit();
      },
    };
  }
}
