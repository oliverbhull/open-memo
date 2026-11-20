import type { AppUpdateStatus } from '../../shared/electron-api';
import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger';
import { MacUpdateInstaller, type MacUpdateInstallerLike, type PreparedMacUpdate } from './MacUpdateInstaller';
import { pruneUpdaterCache } from './UpdaterCache';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class AppUpdateService {
  private status: AppUpdateStatus = { state: 'idle' };
  private availableUpdate: { version: string; bytes?: number } | null = null;
  private readonly updater: AppUpdater;
  private readonly getMainWindow: () => BrowserWindow | null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private manualCheck = false;
  private checking = false;
  private downloading = false;
  private preparation: Promise<void> | null = null;
  private preparedUpdate: PreparedMacUpdate | null = null;
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
    this.updater.channel = 'app';
    this.updater.allowDowngrade = false;
    this.updater.autoDownload = true;
    // MacUpdater otherwise retains another entire ZIP as update.zip.
    this.updater.disableDifferentialDownload = true;
    // Squirrel.Mac buffers the locally proxied ZIP through CFURLConnection. Memo's
    // model-bearing ZIP is large enough to crash that native path, so installation
    // uses the streamed, signature-verified helper instead.
    this.updater.autoInstallOnAppQuit = false;
    this.registerEvents();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  private publishStatus(status: AppUpdateStatus): void {
    this.status = status;
    const window = this.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('app-update:status', status);
  }

  async openUpdate(): Promise<void> {
    if (this.downloading) return;
    if (this.downloadedUpdate) {
      await this.promptToRestart(this.downloadedUpdate.version);
    } else if (this.availableUpdate) {
      await this.downloadUpdate(this.availableUpdate.version);
    }
  }

  start(): void {
    if (process.platform === 'win32' || !app.isPackaged || this.intervalTimer) return;

    if (process.argv.includes('--memo-update-failed')) {
      void this.showMessage({
        type: 'warning',
        title: 'Memo Updates',
        message: 'Memo reopened the previous version because the update could not be installed.',
        detail: 'Try again from Applications, or download the latest installer from GitHub.',
      }).catch((error) => logger.warn('[AppUpdateService] Could not show update failure:', error));
    }

    this.cacheMaintenance = Promise.all([this.installer.prune?.(), pruneUpdaterCache(
      path.join(os.homedir(), 'Library', 'Caches', 'open-memo-updater'),
      app.getVersion(),
    )]).then(() => {}).catch((error) => logger.warn('[AppUpdateService] Could not prune old update files:', error));

    this.intervalTimer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
    void this.check(false);
  }

  stop(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.intervalTimer = null;
  }

  async checkManually(): Promise<void> {
    if (process.platform === 'win32') {
      await this.showMessage({ type: 'info', title: 'Memo Updates',
        message: 'Install Windows updates from the Memo download page.',
          detail: 'Automatic Windows updates are not enabled yet. Use Download for Windows in the GitHub README to get the current installer.' });
      return;
    }
    if (!app.isPackaged) {
      await this.showMessage({
        type: 'info',
        title: 'Memo Updates',
        message: 'Update checks are available in the installed version of Memo.',
      });
      return;
    }
    if (this.downloadedUpdate) {
      await this.promptToRestart(this.downloadedUpdate.version);
      return;
    }
    await this.check(true);
  }

  private async check(manual: boolean): Promise<void> {
    if (this.checking || this.downloading || this.downloadedUpdate) return;
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
        await this.preparation;
      }
    } catch (error) {
      this.downloading = false;
      if (this.availableUpdate) this.publishStatus({ state: 'available', version: this.availableUpdate.version });
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
      this.availableUpdate = { version: info.version, bytes };
      this.downloading = true;
      this.publishStatus({ state: 'downloading', version: info.version });
    });

    this.updater.on('update-not-available', (info) => {
      if (!this.downloadedUpdate) this.publishStatus({ state: 'idle' });
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
      // Extract, verify signatures, and provision changed model assets quietly.
      // Only offer a restart once everything needed by the new app is on disk.
      this.preparation = (async () => {
        try {
          this.preparedUpdate = await this.installer.prepare(info.downloadedFile, info.version);
          this.downloadedUpdate = { version: info.version, file: info.downloadedFile };
          this.publishStatus({ state: 'downloaded', version: info.version });
        } catch (error) {
          this.publishStatus({ state: 'available', version: info.version });
          logger.warn('[AppUpdateService] Could not prepare update:', error);
          throw error;
        } finally {
          this.downloading = false;
        }
      })();
      // EventEmitter does not await listeners. check()/downloadUpdate() also
      // observe this promise so manual requests can report failures.
      void this.preparation.catch(() => {});
    });
    this.updater.on('error', (error) => logger.warn('[AppUpdateService] Updater error:', error));
  }

  private async downloadUpdate(version: string): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    this.publishStatus({ state: 'downloading', version });
    try {
      await this.updater.downloadUpdate();
      await this.preparation;
    } catch (error) {
      this.publishStatus({ state: 'available', version });
      logger.warn('[AppUpdateService] Could not download update:', error);
      await this.showMessage({
        type: 'warning', title: 'Memo Updates',
        message: 'Memo could not download the update.',
        detail: 'Check your internet connection and try again.',
      });
    } finally {
      this.downloading = false;
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
        prepared = this.preparedUpdate ?? await this.installer.prepare(update.file, version);
        await this.beforeInstall();
        await prepared.install();
      }
    } catch (error) {
      await prepared?.discard?.().catch((cleanupError) => {
        logger.warn('[AppUpdateService] Could not remove prepared update:', cleanupError);
      });
      this.preparedUpdate = null;
      logger.warn('[AppUpdateService] Could not restart for update:', error);
      await this.showMessage({
        type: 'warning',
        title: 'Memo Updates',
        message: 'Memo could not restart to install the update.',
        detail: 'Open Memo from Applications and try again, or download the latest installer from GitHub.',
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
