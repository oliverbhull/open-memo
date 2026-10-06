import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger';
import { MacUpdateInstaller, type MacUpdateInstallerLike, type PreparedMacUpdate } from './MacUpdateInstaller';
import { pruneUpdaterCache } from './UpdaterCache';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class AppUpdateService {
  private readonly updater: AppUpdater;
  private readonly getMainWindow: () => BrowserWindow | null;
  private firstCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private manualCheck = false;
  private checking = false;
  private downloading = false;
  private downloadPromptOpen = false;
  private declinedVersion: string | null = null;
  private updatePromptOpen = false;
  private downloadedUpdate: { version: string; file: string } | null = null;
  private cacheMaintenance: Promise<void> = Promise.resolve();

  constructor(
    getMainWindow: () => BrowserWindow | null,
    private readonly beforeInstall: () => Promise<void> = async () => {},
    private readonly installer: MacUpdateInstallerLike = new MacUpdateInstaller(),
  ) {
    this.getMainWindow = getMainWindow;
    this.updater = electronUpdater.autoUpdater;
    this.updater.autoDownload = false;
    // MacUpdater otherwise retains another entire ZIP as update.zip.
    this.updater.disableDifferentialDownload = true;
    // Squirrel.Mac buffers the locally proxied ZIP through CFURLConnection. Memo's
    // model-bearing ZIP is large enough to crash that native path, so installation
    // uses the streamed, signature-verified helper instead.
    this.updater.autoInstallOnAppQuit = false;
    this.registerEvents();
  }

  start(): void {
    if (!app.isPackaged || this.firstCheckTimer || this.intervalTimer) return;

    this.cacheMaintenance = pruneUpdaterCache(
      path.join(os.homedir(), 'Library', 'Caches', 'open-memo-updater'),
      app.getVersion(),
    ).catch((error) => logger.warn('[AppUpdateService] Could not prune old update files:', error));

    this.firstCheckTimer = setTimeout(() => {
      this.firstCheckTimer = null;
      void this.check(false);
    }, FIRST_CHECK_DELAY_MS);
    this.firstCheckTimer.unref();

    this.intervalTimer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  stop(): void {
    if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstCheckTimer = null;
    this.intervalTimer = null;
  }

  async checkManually(): Promise<void> {
    if (!app.isPackaged) {
      await this.showMessage({
        type: 'info',
        title: 'Memo Updates',
        message: 'Update checks are available in the installed version of Memo.',
      });
      return;
    }
    this.declinedVersion = null;
    await this.check(true);
  }

  private async check(manual: boolean): Promise<void> {
    if (this.checking || this.downloading) return;
    this.checking = true;
    this.manualCheck = manual;
    let downloading = false;
    try {
      await this.cacheMaintenance;
      logger.info(`[AppUpdateService] Checking for updates (${manual ? 'manual' : 'automatic'})`);
      const result = await this.updater.checkForUpdates();
      if (result?.downloadPromise) {
        downloading = true;
        await result.downloadPromise;
      }
    } catch (error) {
      logger.warn('[AppUpdateService] Update check failed:', error);
      if (manual) {
        await this.showMessage({
          type: 'warning',
          title: 'Memo Updates',
          message: downloading ? 'Memo could not download the update.' : 'Memo could not check for updates.',
          detail: 'Check your internet connection and try again.',
        });
      }
    } finally {
      this.checking = false;
      this.manualCheck = false;
    }
  }

  private registerEvents(): void {
    this.updater.on('update-available', (info) => {
      logger.info(`[AppUpdateService] Memo ${info.version} is available`);
      const bytes = info.files.find((file) => file.url.endsWith('.zip'))?.size;
      void this.promptToDownload(info.version, bytes);
    });

    this.updater.on('update-not-available', (info) => {
      logger.info(`[AppUpdateService] Memo is current (${info.version})`);
      if (this.manualCheck) {
        void this.showMessage({
          type: 'info',
          title: 'Memo Updates',
          message: 'Memo is up to date.',
          detail: `You are running Memo ${app.getVersion()}.`,
        });
      }
    });

    this.updater.on('update-downloaded', (info) => {
      this.downloadedUpdate = { version: info.version, file: info.downloadedFile };
      void this.promptToRestart(info.version);
    });
    this.updater.on('error', (error) => logger.warn('[AppUpdateService] Updater error:', error));
  }

  private async promptToDownload(version: string, bytes?: number): Promise<void> {
    if (this.downloadPromptOpen || this.downloading || this.declinedVersion === version) return;
    this.downloadPromptOpen = true;
    try {
      const size = typeof bytes === 'number' && bytes > 0
        ? bytes >= 1_000_000_000
          ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
          : `${Math.round(bytes / 1_000_000)} MB`
        : null;
      const result = await this.showMessage({
        type: 'info',
        title: 'Memo Update Available',
        message: `Memo ${version} is available.`,
        detail: size ? `The update will download ${size}.` : 'The update needs to be downloaded.',
        buttons: ['Download Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0) {
        this.declinedVersion = version;
        return;
      }
      this.downloading = true;
      await this.updater.downloadUpdate();
    } catch (error) {
      logger.warn('[AppUpdateService] Could not download update:', error);
      await this.showMessage({
        type: 'warning',
        title: 'Memo Updates',
        message: 'Memo could not download the update.',
        detail: 'Check your internet connection and try again.',
      });
    } finally {
      this.downloading = false;
      this.downloadPromptOpen = false;
    }
  }

  private async promptToRestart(version: string): Promise<void> {
    if (this.updatePromptOpen) return;
    this.updatePromptOpen = true;
    let prepared: PreparedMacUpdate | null = null;
    try {
      const result = await this.showMessage({
        type: 'info',
        title: 'Memo Update Ready',
        message: `Memo ${version} is ready to install.`,
        detail: 'Restart Memo to finish the update.',
        buttons: ['Restart and Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        const update = this.downloadedUpdate;
        if (!update || update.version !== version) throw new Error('The downloaded update is no longer available.');
        prepared = await this.installer.prepare(update.file, version);
        await this.beforeInstall();
        prepared.install();
      }
    } catch (error) {
      await prepared?.discard?.().catch((cleanupError) => {
        logger.warn('[AppUpdateService] Could not remove prepared update:', cleanupError);
      });
      logger.warn('[AppUpdateService] Could not restart for update:', error);
      await this.showMessage({
        type: 'warning',
        title: 'Memo Updates',
        message: 'Memo could not restart to install the update.',
        detail: 'Quit and reopen Memo to try again.',
      });
    } finally {
      this.updatePromptOpen = false;
    }
  }

  private showMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = this.getMainWindow();
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }
}
