import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
      const icon = await app.getFileIcon(appPath, { size: 'small' });
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
