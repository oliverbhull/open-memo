import { app, nativeImage } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { windowsDictationPath } from './windowsRuntime';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../shared/electron-api';
import { normalizeWebsiteDomain, BROWSER_BUNDLE_IDS } from '../../shared/websiteContext';
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

function windowsExecutable(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32768 || !/^[a-z]:\\/i.test(value) || !/\.exe$/i.test(value) || value.includes('\0')) return undefined;
  return path.win32.normalize(value);
}

function spotlightLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ApplicationIconService {
  private readonly identities = new Map<string, ApplicationIdentity>();
  private readonly iconDataUrls = new Map<string, string | null>();
  private readonly windowsPaths = new Map<string, Promise<string | undefined>>();

  private packagedWindowsIcon(executable: string): Electron.NativeImage | null {
    if (!/\\WindowsApps\\/i.test(executable)) return null;
    try {
      let directory = path.win32.dirname(executable);
      for (let depth = 0; depth < 6; depth++) {
        const manifest = path.win32.join(directory, 'AppxManifest.xml');
        if (fs.existsSync(manifest)) {
          if (fs.statSync(manifest).size > 1024 * 1024) return null;
          const xml = fs.readFileSync(manifest, 'utf8');
          const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          for (const application of xml.matchAll(/<Application\b([^>]*)>([\s\S]*?)<\/Application>/g)) {
            const relative = /\bExecutable=["']([^"']+)["']/.exec(application[1]!)?.[1];
            if (!relative || path.win32.resolve(directory, decode(relative)).toLowerCase() !== executable.toLowerCase()) continue;
            const logo = /\bSquare44x44Logo=["']([^"']+)["']/.exec(application[2]!)?.[1];
            if (!logo) return null;
            const artwork = path.win32.resolve(directory, decode(logo));
            const inside = path.win32.relative(directory, artwork);
            if (inside.startsWith('..') || path.win32.isAbsolute(inside) || !/\.png$/i.test(artwork)) return null;
            const stem = artwork.slice(0, -4);
            for (const candidate of [`${stem}.targetsize-64_altform-unplated.png`, artwork, `${stem}.scale-200.png`]) {
              if (!fs.existsSync(candidate)) continue;
              const icon = nativeImage.createFromPath(candidate);
              if (!icon.isEmpty()) return icon;
            }
          }
          return null;
        }
        const parent = path.win32.dirname(directory);
        if (parent === directory || path.win32.basename(parent).toLowerCase() === 'windowsapps') break;
        directory = parent;
      }
    } catch { /* Fall back to Windows' executable icon when package artwork is unavailable. */ }
    return null;
  }

  private resolveWindowsPath(name: string): Promise<string | undefined> {
    const key = name.toLowerCase();
    let request = this.windowsPaths.get(key);
    if (!request) {
      request = new Promise(resolve => {
        execFile(windowsDictationPath(), ['--resolve-app', name], { encoding: 'utf8', timeout: 1500, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) return resolve(undefined);
          try { resolve(windowsExecutable(JSON.parse(stdout).appPath)); }
          catch { resolve(undefined); }
        });
      });
      this.windowsPaths.set(key, request);
    }
    return request;
  }

  enrichContext(context: AppContext | undefined): AppContext | undefined {
    if (!context) return undefined;
    const appName = bounded(context.appName, 200);
    if (!appName) return context;

    // Decoration must not block delivery or history on an AppleScript lookup.
    // Resolve an icon lazily when the renderer requests one.
    const bundleId = bounded(context.bundleId, 300);
    const appPath = process.platform === 'win32' ? windowsExecutable(context.appPath) : undefined;
    if (appPath) this.identities.set(appName.toLowerCase(), { appPath });
    return {
      appName,
      ...(appPath ? { appPath } : {}),
      windowTitle: bounded(context.windowTitle, 1_000) || '',
      ...(context.emailReply ? { emailReply: context.emailReply } : {}),
      ...(bundleId ? { bundleId } : {}),
      ...(context.websiteDomain && bundleId && BROWSER_BUNDLE_IDS.has(bundleId) && normalizeWebsiteDomain(context.websiteDomain)
        ? { websiteDomain: normalizeWebsiteDomain(context.websiteDomain) } : {}),
    };
  }

  private readonly websiteIcons = new Map<string, Promise<string | null>>();

  private async getWebsiteIcon(domain: string): Promise<string | null> {
    try {
      // Fetch only the public icon, without cookies, page paths, or a third-party favicon service.
      const signal = AbortSignal.timeout(2500);
      let url = `https://${domain}/favicon.ico`;
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        response = await fetch(url, { signal, redirect: 'manual', credentials: 'omit' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects >= 3) return null;
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || next.port || !normalizeWebsiteDomain(next.hostname)) return null;
        url = next.href;
      }
      if (!response.ok || !response.body) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 256 * 1024) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      // Chromium can display ICO files directly even on platforms where nativeImage cannot decode them.
      if (buffer.length >= 6 && buffer.readUInt32LE(0) === 0x00010000 && buffer.readUInt16LE(4) > 0) {
        return `data:image/x-icon;base64,${buffer.toString('base64')}`;
      }
      const icon = nativeImage.createFromBuffer(buffer);
      return icon.isEmpty() ? null : icon.resize({ width: 64, height: 64 }).toDataURL();
    } catch { return null; }
  }

  async getIconDataUrl(appNameValue: unknown, bundleIdValue: unknown, websiteDomainValue?: unknown, appPathValue?: unknown): Promise<string | null> {
    if (process.platform === 'win32') {
      const name = bounded(appNameValue, 200);
      if (appPathValue !== undefined && !windowsExecutable(appPathValue)) return null;
      const executable = windowsExecutable(appPathValue)
        ?? (name === 'Memo' ? process.execPath : name ? this.identities.get(name.toLowerCase())?.appPath : undefined)
        ?? (name && name !== 'Unknown' ? await this.resolveWindowsPath(name) : undefined);
      if (!executable || !fs.existsSync(executable)) return null;
      const key = `win:${executable.toLowerCase()}`;
      if (this.iconDataUrls.has(key)) return this.iconDataUrls.get(key) ?? null;
      try {
        const icon = this.packagedWindowsIcon(executable) ?? await app.getFileIcon(executable, { size: 'normal' });
        const result = icon.isEmpty() ? null : icon.toDataURL();
        this.iconDataUrls.set(key, result);
        return result;
      } catch {
        return null;
      }
    }
    const domain = normalizeWebsiteDomain(websiteDomainValue);
    if (domain && typeof bundleIdValue === 'string' && BROWSER_BUNDLE_IDS.has(bundleIdValue)) {
      let request = this.websiteIcons.get(domain);
      if (!request) {
        request = this.getWebsiteIcon(domain);
        this.websiteIcons.set(domain, request);
      }
      const icon = await request;
      if (icon) return icon;
    }
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
