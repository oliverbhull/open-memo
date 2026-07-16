import { app, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../shared/electron-api';
import { logger } from '../utils/logger';

interface ApplicationIdentity {
  bundleId?: string;
  appPath?: string;
}

const PROCESS_IDENTITY_SCRIPT = `
on run argv
  set targetName to item 1 of argv
  tell application "System Events"
    set matches to every application process whose name is targetName
    if (count of matches) is 0 then return linefeed
    set targetProcess to item 1 of matches
    set bundleIdValue to ""
    set appPathValue to ""
    try
      set bundleIdValue to bundle identifier of targetProcess
    end try
    try
      set appPathValue to POSIX path of (application file of targetProcess as alias)
    end try
    return bundleIdValue & linefeed & appPathValue
  end tell
end run`;

function bounded(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maximum);
  return normalized || undefined;
}

function spotlightLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ApplicationIconService {
  private readonly identities = new Map<string, ApplicationIdentity>();
  private readonly iconDataUrls = new Map<string, string | null>();

  enrichContext(context: AppContext | undefined): AppContext | undefined {
    if (!context) return undefined;
    const appName = bounded(context.appName, 200);
    if (!appName) return context;

    const identity = this.resolveRunningApplication(appName);
    if (identity.bundleId || identity.appPath) {
      this.identities.set(identity.bundleId || appName.toLowerCase(), identity);
    }
    return {
      appName,
      windowTitle: bounded(context.windowTitle, 1_000) || '',
      ...(identity.bundleId ? { bundleId: identity.bundleId } : {}),
    };
  }

  async getIconDataUrl(appNameValue: unknown, bundleIdValue: unknown): Promise<string | null> {
    const appName = bounded(appNameValue, 200);
    const bundleId = bounded(bundleIdValue, 300);
    if (!appName && !bundleId) return null;
    const cacheKey = bundleId || appName!.toLowerCase();
    if (this.iconDataUrls.has(cacheKey)) return this.iconDataUrls.get(cacheKey) ?? null;

    let identity = this.identities.get(cacheKey);
    if (!identity?.appPath && appName) identity = this.resolveRunningApplication(appName);
    if (!identity?.appPath && appName) identity = { appPath: this.findApplicationByName(appName) };
    if (!identity?.appPath && bundleId) {
      identity = { bundleId, appPath: this.findApplicationByBundleId(bundleId) };
    }

    const appPath = identity?.appPath;
    if (!appPath || !appPath.endsWith('.app') || !fs.existsSync(appPath)) {
      this.iconDataUrls.set(cacheKey, null);
      return null;
    }

    try {
      const icon = this.loadBundleIcon(appPath) ?? await app.getFileIcon(appPath, { size: 'normal' });
      const dataUrl = icon.isEmpty() ? null : icon.toDataURL();
      this.identities.set(cacheKey, { ...identity, appPath });
      this.iconDataUrls.set(cacheKey, dataUrl);
      return dataUrl;
    } catch (error) {
      logger.warn(`[AppIcon] Could not load icon for ${appName || bundleId}:`, error);
      this.iconDataUrls.set(cacheKey, null);
      return null;
    }
  }

  private loadBundleIcon(appPath: string): Electron.NativeImage | null {
    const iconPath = this.findBundleIconPath(appPath);
    if (!iconPath) return null;

    try {
      const stats = fs.statSync(iconPath);
      const cacheKey = createHash('sha256')
        .update(`${iconPath}:${stats.size}:${stats.mtimeMs}`)
        .digest('hex')
        .slice(0, 24);
      const cacheDirectory = path.join(app.getPath('userData'), 'cache', 'app-icons');
      const pngPath = path.join(cacheDirectory, `${cacheKey}.png`);
      if (!fs.existsSync(pngPath)) {
        fs.mkdirSync(cacheDirectory, { recursive: true });
        const temporaryPath = `${pngPath}.${process.pid}.tmp.png`;
        try {
          execFileSync('/usr/bin/sips', [
            '-s', 'format', 'png',
            '--resampleHeightWidth', '64', '64',
            iconPath,
            '--out', temporaryPath,
          ], { stdio: 'ignore', timeout: 5_000 });
          fs.renameSync(temporaryPath, pngPath);
        } catch (error) {
          fs.rmSync(temporaryPath, { force: true });
          throw error;
        }
      }

      const icon = nativeImage.createFromPath(pngPath);
      return icon.isEmpty() ? null : icon;
    } catch (error) {
      logger.debug(`[AppIcon] Could not load bundle artwork from ${iconPath}:`, error);
      return null;
    }
  }

  private findBundleIconPath(appPath: string): string | undefined {
    const infoPath = path.join(appPath, 'Contents', 'Info.plist');
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');
    const iconName = this.readPlistString(infoPath, 'CFBundleIconFile')
      || this.readPlistString(infoPath, 'CFBundleIconName');
    if (iconName && path.basename(iconName) === iconName) {
      const fileName = iconName.toLowerCase().endsWith('.icns') ? iconName : `${iconName}.icns`;
      const iconPath = path.join(resourcesPath, fileName);
      if (fs.existsSync(iconPath)) return iconPath;
    }

    try {
      return fs.readdirSync(resourcesPath)
        .filter((fileName) => fileName.toLowerCase().endsWith('.icns'))
        .map((fileName) => path.join(resourcesPath, fileName))
        .find((candidate) => fs.statSync(candidate).isFile());
    } catch {
      return undefined;
    }
  }

  private readPlistString(infoPath: string, key: string): string | undefined {
    try {
      return bounded(execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', infoPath], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 16_384,
      }), 255);
    } catch {
      return undefined;
    }
  }

  private resolveRunningApplication(appName: string): ApplicationIdentity {
    if (process.platform !== 'darwin') return {};
    try {
      const output = execFileSync('osascript', ['-e', PROCESS_IDENTITY_SCRIPT, appName], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 16_384,
      });
      const [bundleId, appPath] = output.split(/\r?\n/, 2).map((value) => value.trim());
      return {
        ...(bundleId ? { bundleId } : {}),
        ...(appPath ? { appPath } : {}),
      };
    } catch (error) {
      logger.debug(`[AppIcon] Could not resolve running application ${appName}:`, error);
      return {};
    }
  }

  private findApplicationByBundleId(bundleId: string): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    try {
      const query = `kMDItemCFBundleIdentifier == "${spotlightLiteral(bundleId)}"`;
      const output = execFileSync('mdfind', [query], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 256_000,
      });
      return output.split(/\r?\n/).map((value) => value.trim()).find((value) => value.endsWith('.app'));
    } catch (error) {
      logger.debug(`[AppIcon] Could not find bundle ${bundleId}:`, error);
      return undefined;
    }
  }

  private findApplicationByName(appName: string): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    try {
      const query = `kMDItemDisplayName == "${spotlightLiteral(appName)}"c && kMDItemContentType == "com.apple.application-bundle"`;
      const output = execFileSync('mdfind', [query], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 256_000,
      });
      return output.split(/\r?\n/).map((value) => value.trim()).find((value) => value.endsWith('.app'));
    } catch (error) {
      logger.debug(`[AppIcon] Could not find application ${appName}:`, error);
      return undefined;
    }
  }
}

export const applicationIconService = new ApplicationIconService();
