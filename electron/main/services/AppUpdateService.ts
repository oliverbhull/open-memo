import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import { logger } from '../utils/logger';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class AppUpdateService {
  private readonly updater: AppUpdater;
  private readonly getMainWindow: () => BrowserWindow | null;
  private firstCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private manualCheck = false;
  private checking = false;
  private updatePromptOpen = false;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
    this.updater = electronUpdater.autoUpdater;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.registerEvents();
  }

  start(): void {
    if (!app.isPackaged || this.firstCheckTimer || this.intervalTimer) return;

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
    await this.check(true);
  }

  private async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.manualCheck = manual;
    try {
      logger.info(`[AppUpdateService] Checking for updates (${manual ? 'manual' : 'automatic'})`);
      await this.updater.checkForUpdates();
    } catch (error) {
      logger.warn('[AppUpdateService] Update check failed:', error);
      if (manual) {
        await this.showMessage({
          type: 'warning',
          title: 'Memo Updates',
          message: 'Memo could not check for updates.',
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
      logger.info(`[AppUpdateService] Downloading Memo ${info.version}`);
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

    this.updater.on('update-downloaded', (info) => void this.promptToRestart(info.version));
    this.updater.on('error', (error) => logger.warn('[AppUpdateService] Updater error:', error));
  }

  private async promptToRestart(version: string): Promise<void> {
    if (this.updatePromptOpen) return;
    this.updatePromptOpen = true;
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
      if (result.response === 0) this.updater.quitAndInstall();
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
