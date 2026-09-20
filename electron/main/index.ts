import { app, autoUpdater, BrowserWindow, ipcMain, systemPreferences, shell, Menu, clipboard } from 'electron';
import { randomUUID } from 'node:crypto';
import { MemoSttService, TranscriptionData } from './services/MemoSttService';
import { createTray, getMicrophoneInputState, refreshAudioInputDevices, selectSystemInput, setMainWindow, setOpenMainWindowHandler, setLastTranscript, setRecordingState, setProcessingState, updateMenuState, setMemoSttService } from './services/TrayService';
import {
  loadSettings,
  loadUserSettings,
  migrateToElectronStore,
  saveSettings,
  saveUserSettings,
  store,
} from './services/SettingsService';
import { applyPhraseReplacements, clampPhraseReplacementRulesFromInput } from './services/phraseReplacement';
import { updateOverlayVisibility, sendAudioLevels, sendStatusToOverlay } from './services/WindowService';
import path from 'path';
import os from 'os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger } from './utils/logger';
import { normalizeTranscriptionText, stripLeadingDashSpace, stripTrailingEnter } from './services/textProcessing';
import { runMemoExport } from './exportMemos';
import { audioStorageService } from './services/AudioStorageService';
import { applicationIconService } from './services/ApplicationIconService';
import { saveJsonExport } from './services/JsonExportService';
import { audioInputService } from './services/AudioInputService';
import { AsrModelService } from './services/AsrModelService';
import type { AppContext, AsrModelId, AsrState } from '../shared/electron-api';
import { resolveTranscriptionText, resolveCleanInput } from '../shared/transcription';
import { UsbTranscriptService } from './services/UsbTranscriptService';
import { DeviceSyncService } from './services/DeviceSyncService';
import { MemoDatabaseService } from './services/MemoDatabaseService';
import { resolveApplicationContext } from './services/applicationContext';
import { AppUpdateService } from './services/AppUpdateService';
import { PunctuationService } from './services/PunctuationService';
import { CleanupService } from './services/CleanupService';
import { pasteIntoFocusedTarget } from './services/checkedPaste';
import { createDictationEntry } from '../shared/dictationEntry';
import { ensurePersistentModelPacks } from './services/ModelPackService';
import { checkInputMonitoringPermission } from './services/InputMonitoringPermissionService';

const isExportMode = process.env.MEMO_EXPORT === '1';

if (isExportMode) {
  app.setPath('userData', path.join(os.homedir(), 'Library/Application Support/Memo'));
}

// Get __dirname - esbuild bundles to CommonJS, so we calculate it
// In dev: dist/main.cjs is at process.cwd()/dist/main.cjs
// In production: dist/main.cjs is at app.getAppPath()/dist/main.cjs
const __dirname = app.isPackaged 
  ? path.join(app.getAppPath(), 'dist')
  : path.join(process.cwd(), 'dist');

function selectedSystemMicIsAvailable(): boolean {
  const selectedName = store.get('selectedSystemMicName')?.trim();
  return !selectedName || audioInputService.getDevices().some(({ name }) => name === selectedName);
}

app.setName('Memo');

const memoDatabaseService = new MemoDatabaseService({
  databasePath: path.join(app.getPath('userData'), 'memo.sqlite3'),
});

const gotSingleInstanceLock = isExportMode || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let memoSttService: MemoSttService | null = null;
let deviceSyncService: DeviceSyncService | null = null;
const appUpdateService = new AppUpdateService(() => mainWindow, async () => {
  isQuitting = true;
  await ensurePersistentModelPacks();
  await cleanupMemoStt();
});
let isRecording = false;
let isQuitting = false;
let deliveryQueue: Promise<void> = Promise.resolve();
let micDeviceRecoveryTimer: NodeJS.Timeout | null = null;
const asrModelService = new AsrModelService();
const usbTranscriptService = new UsbTranscriptService();
const punctuationService = new PunctuationService();
const cleanupService = new CleanupService();

cleanupService.on('state-changed', (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('writing:cleanup-state-changed', state);
  }
});

asrModelService.on('state-changed', (state: AsrState) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('asr:state-changed', state);
  }
});

app.on('second-instance', () => {
  openMainWindow();
});

function createWindow(): void {
  // Check for dev mode - either NODE_ENV or if dist-react doesn't exist
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 440,
    height: 600,
    minWidth: 280,
    minHeight: 350,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    show: true,
    ...(process.platform === 'darwin' ? {
      // macOS: Use hiddenInset title bar to show native traffic lights
      titleBarStyle: 'hiddenInset',
      frame: true, // Frame must be true for titleBarStyle to work
    } : {
      // Other platforms: Use frameless window
      frame: false,
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const rendererUrl = isDev
    ? new URL('http://localhost:5173/')
    : pathToFileURL(path.join(app.getAppPath(), 'dist-react', 'index.html'));
  const allowRendererNavigation = (event: Electron.Event, targetUrl: string) => {
    const target = new URL(targetUrl);
    if (target.origin !== rendererUrl.origin || target.pathname !== rendererUrl.pathname) {
      event.preventDefault();
      logger.warn(`[Main] Blocked renderer navigation to ${targetUrl}`);
    }
  };
  mainWindow.webContents.on('will-navigate', allowRendererNavigation);
  mainWindow.webContents.on('will-redirect', allowRendererNavigation);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  void mainWindow.loadURL(rendererUrl.toString()).catch((error) => {
    logger.error('[Main] Failed to load renderer:', error);
  });
  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  // Set main window in tray service
  setMainWindow(mainWindow);
}

function openMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
}

/**
 * Create application menu bar for macOS
 */
function createMenuBar() {
  if (process.platform !== 'darwin') return;
  
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => { void appUpdateService.checkManually(); },
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Command+,',
          click: () => {
            openMainWindow();
            mainWindow?.webContents.send('settings:open');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setMemoSttServiceForTray(service: MemoSttService | null) {
  setMemoSttService(service);
}

async function startLiveDictation(): Promise<void> {
  if (isQuitting) return;
  if (!memoSttService || !selectedSystemMicIsAvailable()) return;
  await memoSttService.start();
  if (memoSttService.getStatus() !== 'running') return;
}

async function setupMemoSttService(): Promise<void> {
  logger.info('Creating new MemoSttService instance');
  memoSttService = new MemoSttService();
  
  // Set service reference in TrayService for command sending
  setMemoSttServiceForTray(memoSttService);
  
  // Load hotkey from settings, default to 'function'
  const userSettings = loadUserSettings();
  const hotkey = userSettings.hotkey || 'function';
  memoSttService.setHotkey(hotkey);
  
  let pendingDeliveries = 0;
  let pendingRecognition = 0;
  const updateProcessingState = () => setProcessingState(pendingRecognition > 0 || pendingDeliveries > 0);
  memoSttService.on('transcription', (data: TranscriptionData) => {
    pendingRecognition = Math.max(0, pendingRecognition - 1);
    pendingDeliveries += 1;
    updateProcessingState();
    const timestamp = Date.now();
    const settings = loadSettings();
    deliveryQueue = deliveryQueue.then(async () => {
      let deliveryFinished = false;
      const finishDelivery = () => {
        if (deliveryFinished) return;
        deliveryFinished = true;
        pendingDeliveries -= 1;
        updateProcessingState();
      };
      try {
        // IMPORTANT: Transcriptions arrive AFTER recording has stopped
        // The flow is: recording starts → user speaks → recording stops → transcription happens
        // So we should NEVER set isRecording = true here. If we get a transcription,
        // recording has already stopped. The recording state should already be false.
        // If it's not false, that's a bug we should log, not fix by setting it to true.
        if (isRecording) {
          logger.warn('[Main] Transcription received while still recording - this should not happen');
          // Don't change state, just log the issue
        }

        // Update last transcript and paste: support "say enter" to press Enter after paste
        const entryId = randomUUID();
        const cleanMode = !isQuitting && settings.writingMode === 'clean' && cleanupService.isEnabled();
        const rawText = resolveTranscriptionText(data);
        const normalized = normalizeTranscriptionText(stripLeadingDashSpace(rawText));
        const asSpoken = resolveCleanInput(data);
        let formatted: string;
        let cleanProvenance: Record<string, unknown> | undefined;
        if (cleanMode) {
          const cleanup = await cleanupService.format(asSpoken, settings.vocabWords);
          formatted = cleanup.text;
          cleanProvenance = { asSpoken, candidate: cleanup.candidateText, selected: cleanup.text,
            status: cleanup.status, reason: cleanup.reason, model: cleanup.model,
            contract: cleanup.contract, latencyMs: cleanup.latencyMs };
          logger.info(`[Main] Clean ${cleanup.status}${cleanup.reason ? ` (${cleanup.reason})` : ''}` +
            `${cleanup.latencyMs === undefined ? '' : ` in ${cleanup.latencyMs.toFixed(0)} ms`}`);
        } else {
          formatted = app.isPackaged && !isQuitting ? await punctuationService.format(normalized) : asSpoken;
        }
        const afterPhrases = applyPhraseReplacements(formatted, settings.phraseReplacements);
        const { textToPaste: textBeforeNormalization, pressEnter: pressEnterThisTime } = stripTrailingEnter(afterPhrases, settings.sayEnterToPressEnter ?? false);
        const textToPaste = normalizeTranscriptionText(textBeforeNormalization);
        let delivery = isQuitting ? 'shutdown' : 'empty';
        let deliveryAppContext: AppContext | undefined;

        if (textToPaste && !isQuitting) {
          setLastTranscript(textToPaste);
          try {
            const pasteStarted = performance.now();
            clipboard.writeText(textToPaste);
            delivery = 'clipboard_only';
            const clipboardMs = performance.now() - pasteStarted;
            const pasteEventStarted = performance.now();
            // The onboarding test field lives inside Memo. Paste into our own
            // focused renderer directly; routing that through System Events can
            // trigger an unrelated Automation prompt or timeout. Other apps
            // continue through the permission-checked system paste path.
            const outcome = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
              ? (() => {
                  mainWindow.webContents.paste();
                  if (pressEnterThisTime) {
                    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
                    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
                  }
                  return {
                    status: 'pasted' as const,
                    appContext: { appName: 'Memo', windowTitle: 'Memo' },
                  };
                })()
              : pasteIntoFocusedTarget(pressEnterThisTime);
            delivery = outcome.status;
            deliveryAppContext = outcome.appContext;
            const pasted = outcome.status === 'pasted';
            if (!pasted) {
              logger.info(`[Main] Automatic paste skipped (${outcome.status}); transcript copied and retained`);
              mainWindow?.webContents.send('audio:showToast', {
                message: 'Automatic paste was skipped. Your dictation is on the clipboard.',
                severity: 'warning', duration: 4000,
              });
            }
            const pasteEventMs = performance.now() - pasteEventStarted;
            if (pasted) delivery = 'pasted';
            logger.debug(
              (pasted ? '[Main] Pasted transcription into focused app' : '[Main] Kept transcription on clipboard') +
              (pressEnterThisTime ? ' (voice enter)' : '') +
              ` clipboard=${clipboardMs.toFixed(1)} ms paste_event=${pasteEventMs.toFixed(1)} ms`
            );
          } catch (pasteErr) {
            delivery = 'paste_failed';
            logger.warn('[Main] Paste failed (accessibility may be required):', pasteErr);
          }
        }

        finishDelivery();

        // Explicitly requested development diagnostics. JSON escaping keeps dictated
        // newlines/control characters from impersonating other log entries.
        if (!app.isPackaged) {
          logger.info('[Dictation comparison] ' + JSON.stringify({
            id: entryId,
            rawGranite: asSpoken,
            lfmOutput: cleanProvenance?.status === 'accepted' ? formatted : null,
            cleanupStatus: cleanProvenance?.status ?? 'not_requested',
            cleanupReason: cleanProvenance?.reason ?? null,
            ...(cleanProvenance?.status === 'fallback' ? { modelCandidate: cleanProvenance.candidate ?? null } : {}),
            finalText: textToPaste,
            delivery,
            pressEnterRequested: pressEnterThisTime,
            cleanupMs: cleanProvenance?.latencyMs ?? null,
          }));
        }

        // Reuse the comparison ID for the memo and its optional WAV file.
        const { audioCapture, ...transcription } = data;
        const appContext = resolveApplicationContext(
          applicationIconService.enrichContext(deliveryAppContext ?? data.appContext),
          !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
        );
        let audio: Awaited<ReturnType<typeof audioStorageService.save>> | undefined;
        if (settings.saveAudio && audioCapture?.wavBuffer) {
          try {
            audio = await audioStorageService.save(entryId, audioCapture.wavBuffer, audioCapture.duration);
          } catch (error) {
            logger.error(`[AudioStorage] Failed to retain audio for memo ${entryId}:`, error);
            mainWindow?.webContents.send('audio:showToast', {
              message: 'The audio for this dictation could not be saved',
              severity: 'warning',
              duration: 4000,
            });
          }
        }

        const completed = {
          ...transcription,
          processedText: textToPaste,
          rawTranscript: data.rawTranscript ?? '',
          wasProcessedByLLM: cleanMode ? cleanProvenance?.status === 'accepted' : data.wasProcessedByLLM,
          context: { ...data.context, ...(cleanProvenance ? { cleanup: cleanProvenance } : {}), delivery },
          id: entryId,
          timestamp,
          ...(appContext ? { appContext } : {}),
          ...(audio ? { audio } : {}),
        };
        // History belongs to the main process, including while its window is closed.
        if (textToPaste) {
          let deviceId = store.get('desktopDeviceId');
          if (!deviceId) {
            deviceId = `desktop-${randomUUID()}`;
            store.set('desktopDeviceId', deviceId);
          }
          await memoDatabaseService.saveEntry(createDictationEntry(completed, deviceId));
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('transcription:new', { ...completed, persisted: true });
          }
        }
      } catch (error) {
        logger.error('[Main] Could not finish transcription delivery:', error);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:showToast', {
            message: 'Memo could not save this dictation. Check the clipboard before continuing.',
            severity: 'error', duration: 6000,
          });
        }
      } finally {
        finishDelivery();
      }
    });
  });

  memoSttService.on('status', (status: string) => {
    // Update recording state based on service status
    if (status === 'stopped' || status === 'error') {
      pendingRecognition = 0;
      updateProcessingState();
      if (isRecording) {
        isRecording = false;
        setRecordingState(false);
        updateOverlayVisibility(false, mainWindow);
        sendStatusToOverlay(false, mainWindow);
      }
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memo-stt:status', status);
    }
  });

  memoSttService.on('error', (error: Error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memo-stt:error', {
        message: error.message,
        name: error.name,
      });
    }
  });

  // Handle audio levels if memo-stt outputs them
  memoSttService.on('audioLevels', (levels: number[]) => {
    sendAudioLevels(levels);
  });

  memoSttService.on('micInfoUpdated', () => {
    updateMenuState();
  });

  // Handle recording started event - update overlay immediately
  memoSttService.on('recordingStarted', () => {
    logger.debug('[Main] Recording started event received');
    if (!isRecording) {
      isRecording = true;
      setRecordingState(true);
      updateOverlayVisibility(true, mainWindow);
      sendStatusToOverlay(true, mainWindow);
    } else {
      logger.warn('[Main] Recording started event received but already recording');
    }
  });

  // Handle recording stopped event - update overlay immediately
  memoSttService.on('recordingStopped', () => {
    logger.debug('[Main] Recording stopped event received');
    if (isRecording) {
      isRecording = false;
      setRecordingState(false);
      updateOverlayVisibility(false, mainWindow);
      sendStatusToOverlay(false, mainWindow);
    } else {
      logger.warn('[Main] Recording stopped event received but not recording');
    }
  });

  // Handle processing started event
  memoSttService.on('processingStarted', () => {
    logger.debug('[Main] Processing started event received');
    pendingRecognition += 1;
    updateProcessingState();
  });

  // Handle processing completed event.
  memoSttService.on('processingCompleted', () => {
    logger.debug('[Main] Processing completed event received');
    pendingRecognition = Math.max(0, pendingRecognition - 1);
    updateProcessingState();
    // The no-speech path emits this without a transcription event.
  });

  // Handle processing failed event - clear processing state when transcription fails
  memoSttService.on('processingFailed', () => {
    logger.debug('[Main] Processing failed event received');
    pendingRecognition = Math.max(0, pendingRecognition - 1);
    updateProcessingState();
    if (isRecording) {
      logger.warn('[Main] Recording state still set when processing failed, clearing it');
      isRecording = false;
      setRecordingState(false);
      updateOverlayVisibility(false, mainWindow);
      sendStatusToOverlay(false, mainWindow);
    }
  });

  // Reopen the selected input after a CoreAudio error without discarding it or
  // substituting the macOS default. If it is unavailable, leave capture stopped.
  memoSttService.on('micDeviceError', (detail: string) => {
    logger.warn(`[Main] mic device error: ${detail} — refreshing inputs and restarting`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:showToast', {
        message: 'Microphone reconnecting…',
        severity: 'warning',
        duration: 3000,
      });
    }
    // Stderr and process exit can report the same failure. Collapse them into one
    // recovery after CoreAudio has had a moment to settle.
    if (micDeviceRecoveryTimer) clearTimeout(micDeviceRecoveryTimer);
    micDeviceRecoveryTimer = setTimeout(() => {
      micDeviceRecoveryTimer = null;
      void refreshAudioInputDevices()
        .then((alreadyRestarted) => {
          if (!selectedSystemMicIsAvailable()) {
            memoSttService?.stop();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('audio:showToast', {
                message: 'Selected microphone unavailable',
                severity: 'warning',
                duration: 3000,
              });
            }
            return;
          }
          if (!alreadyRestarted) memoSttService?.restart();
        })
        .catch((error) => {
          logger.warn('[Main] Could not refresh microphones during recovery:', error);
          memoSttService?.restart();
        });
    }, 800);
  });

  // Do not start against another microphone when an explicit selection is absent.
  if (!selectedSystemMicIsAvailable()) {
    logger.warn('[Main] Selected microphone is unavailable; capture remains stopped');
    return;
  }
  await startLiveDictation();
}

app.whenReady().then(async () => {
  if (isExportMode) {
    try {
      await runMemoExport();
      app.exit(0);
    } catch (err) {
      console.error('Memo export failed:', err);
      app.exit(1);
    }
    return;
  }

  // Run migration from file-based settings to electron-store
  migrateToElectronStore();

  // Seed persistent, content-addressed model packs before workers start. App
  // updates can become lightweight after one migration release has shipped.
  try {
    await ensurePersistentModelPacks();
  } catch (error) {
    logger.warn('[Main] Could not persist bundled model packs; using bundled assets for this launch:', error);
  }

  // Memo owns a normal app window, so keep one foreground app identity on macOS.
  if (process.platform === 'darwin') app.setActivationPolicy('regular');

  // Dock icon: use the app bundle icon from electron-builder (app-icon.icns). Avoid
  // app.dock.setIcon(single 128px bitmap) — it breaks inactive/active Dock rendering.

  // Create menu bar first (needed for macOS to recognize app)
  createMenuBar();

  setOpenMainWindowHandler(openMainWindow);
  openMainWindow();
  appUpdateService.start();
  if (loadSettings().writingMode === 'clean') cleanupService.start();
  else if (app.isPackaged) punctuationService.start();

  // Resolve a remembered microphone before memo-stt starts. An unavailable
  // explicit selection remains selected and capture stays stopped.
  await refreshAudioInputDevices();

  // Only start memo-stt service if user is onboarded
  // This prevents the Input Monitoring dialog from appearing before onboarding
  const userSettings = loadUserSettings();
  const userName = userSettings.userName;
  const isOnboarded = userName && (userSettings.onboardedUsers || []).includes(userName);

  if (isOnboarded) {
    await setupMemoSttService();
  } else {
    logger.info('[Main] User not onboarded yet, skipping memo-stt service start');
  }
  
  // Initialize tray. The overlay window is created on demand when recording
  // starts so its transparency context is fresh for the active display.
  createTray();

  deviceSyncService = new DeviceSyncService({
    pauseDictation: async () => {
      if (!memoSttService) return false;
      logger.info('[Main] Pausing live dictation for Memo device transcription');
      await memoSttService.suspend();
      return true;
    },
    resumeDictation: async () => {
      if (isQuitting) return;
      memoSttService?.resume();
      if (!isQuitting && memoSttService && selectedSystemMicIsAvailable()) {
        logger.info('[Main] Restoring live dictation after Memo device transcription');
        await startLiveDictation();
      }
    },
  });
  deviceSyncService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('device-sync:status', status);
    }
  });
  void deviceSyncService.start();
  
  app.on('activate', () => {
    openMainWindow();
  });
});

// Stop workers and flush accepted dictations before macOS quit or updater restart.
let cleanupComplete = false;
let cleanupPromise: Promise<void> | null = null;
const cleanupMemoStt = (): Promise<void> => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (micDeviceRecoveryTimer) clearTimeout(micDeviceRecoveryTimer);
    appUpdateService.stop();
    punctuationService.stop();
    cleanupService.stop();
    await Promise.all([
      deviceSyncService?.stop({ restoreDictation: false }),
      memoSttService?.suspend(),
    ]);
    await deliveryQueue;
    deviceSyncService = null;
    memoSttService = null;
    cleanupComplete = true;
  })();
  return cleanupPromise;
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  isQuitting = true;
  if (cleanupComplete) return;
  event.preventDefault();
  void cleanupMemoStt().then(() => app.quit()).catch((error) => {
    logger.error('Shutdown failed:', error);
    app.exit(1);
  });
});

autoUpdater.on('before-quit-for-update', () => {
  isQuitting = true;
  void cleanupMemoStt();
});

process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());

const exitAfterFailure = (error: unknown) => {
  // An error may contain dictated content; detailed diagnostics stay in development.
  logger.error('Memo encountered an unexpected failure and will close.');
  logger.debug('Unexpected failure details:', error);
  isQuitting = true;
  void cleanupMemoStt().finally(() => app.exit(1));
};
process.on('uncaughtException', exitAfterFailure);
process.on('unhandledRejection', exitAfterFailure);

// IPC handlers
ipcMain.handle('memo-stt:get-status', () => {
  return memoSttService?.getStatus() || 'stopped';
});

ipcMain.handle('usb-transcripts:list', () => usbTranscriptService.list());

ipcMain.handle('entries:initialize', () => memoDatabaseService.initialize());

ipcMain.handle('entries:import-legacy', (_event, entries: unknown) => (
  memoDatabaseService.importLegacyEntries(entries)
));

ipcMain.handle('entries:save', (_event, entry: unknown) => memoDatabaseService.saveEntry(entry));

ipcMain.handle('entries:get', (_event, id: unknown) => memoDatabaseService.getEntry(id));

ipcMain.handle('entries:list', (_event, limit: unknown, offset: unknown) => (
  memoDatabaseService.getEntries(limit, offset)
));

ipcMain.handle('entries:get-all-active', () => memoDatabaseService.getAllActiveEntries());

ipcMain.handle('entries:get-total-word-count', () => memoDatabaseService.getTotalWordCount());

ipcMain.handle('device-sync:get-status', () => (
  deviceSyncService?.getStatus() || { state: 'disconnected', completed: 0, total: 0 }
));

ipcMain.handle('device-sync:open-recordings-folder', async () => {
  try {
    const directory = deviceSyncService?.recordingsDirectory()
      || path.join(app.getPath('userData'), 'device-recordings');
    await fs.promises.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    return error ? { success: false, error } : { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('memo-stt:restart', async () => memoSttService?.restart());

ipcMain.handle('asr:get-state', () => asrModelService.getState());

ipcMain.handle('asr:select-model', async (_event, model: AsrModelId) => (
  asrModelService.selectModel(model, () => {
    const deviceBatchOwnsStt = deviceSyncService?.isTranscribing() ?? false;
    deviceSyncService?.restart();
    if (!deviceBatchOwnsStt) memoSttService?.restart();
  })
));

// Permission handlers
ipcMain.handle('permissions:check-microphone', async () => {
  if (process.platform !== 'darwin') {
    return true; // Assume granted on non-macOS
  }
  
  try {
    if (systemPreferences.getMediaAccessStatus) {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return status === 'granted';
    }
    return true;
  } catch (error) {
    console.error('Failed to check microphone permission:', error);
    return false;
  }
});

ipcMain.handle('permissions:request-microphone', async () => {
  if (process.platform !== 'darwin') {
    return true; // Assume granted on non-macOS
  }
  
  try {
    if (systemPreferences.askForMediaAccess && typeof systemPreferences.askForMediaAccess === 'function') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return !!granted;
    }
    return true;
  } catch (error) {
    logger.error('Failed to request microphone permission:', error);
    return false;
  }
});

ipcMain.handle('permissions:open-microphone-preferences', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  }
});

ipcMain.handle('permissions:check-input-monitoring', async () => {
  return checkInputMonitoringPermission(false);
});

ipcMain.handle('permissions:request-input-monitoring', async () => (
  checkInputMonitoringPermission(true)
));

ipcMain.handle('permissions:open-input-monitoring-preferences', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  
  try {
    // Open System Settings to Input Monitoring pane
    // Note: Input Monitoring is in Privacy & Security section
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  } catch (error) {
    logger.error('Failed to open input monitoring preferences:', error);
    // Fallback: try opening System Settings directly
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security');
    } catch (fallbackError) {
      logger.error('Failed to open system preferences (fallback):', fallbackError);
      // Last resort: open System Settings app
      try {
        await shell.openExternal('x-apple.systempreferences:');
      } catch (lastResortError) {
        logger.error('Failed to open system preferences (last resort):', lastResortError);
      }
    }
  }
});

ipcMain.handle('permissions:check-accessibility', async () => {
  if (process.platform !== 'darwin') {
    return true; // Assume granted on non-macOS
  }
  
  try {
    if (app.isReady() && systemPreferences.isTrustedAccessibilityClient) {
      return systemPreferences.isTrustedAccessibilityClient(false);
    }
    return false;
  } catch (error) {
    logger.error('Failed to check accessibility permission:', error);
    return false;
  }
});

ipcMain.handle('permissions:request-accessibility', async () => {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(true);
  } catch (error) {
    logger.error('Failed to request accessibility permission:', error);
    return false;
  }
});

ipcMain.handle('permissions:open-system-preferences', async () => {
  if (process.platform !== 'darwin') {
    return;
  }
  
  try {
    // Open System Preferences to Accessibility pane
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } catch (error) {
    logger.error('Failed to open system preferences:', error);
    // Fallback: try opening System Preferences
    try {
      await shell.openExternal('x-apple.systempreferences:');
    } catch (fallbackError) {
      logger.error('Failed to open system preferences (fallback):', fallbackError);
    }
  }
});

ipcMain.handle('permissions:open-automation-preferences', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
  }
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

// Handler to start memo-stt service manually (after onboarding completes)
ipcMain.handle('app:start-memo-stt-service', async () => {
  if (!memoSttService) {
    logger.info('[Main] Starting memo-stt service on demand');
    await setupMemoSttService();
  } else {
    logger.info('[Main] Ensuring memo-stt service is running');
    await startLiveDictation();
  }
  if (!memoSttService) throw new Error('Memo dictation service could not be created.');
  return memoSttService.waitUntilReady();
});

// User name handlers
function normalizeUserName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

ipcMain.handle('user:save-name', async (_event, name: unknown) => {
  const normalizedName = normalizeUserName(name);
  saveUserSettings({ userName: normalizedName });
  if (normalizedName) {
    const settings = loadSettings();
    const hasName = settings.vocabWords.some(
      word => word.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
    );
    if (!hasName) {
      settings.vocabWords = [...settings.vocabWords, normalizedName];
      saveSettings(settings);
      memoSttService?.updateVocabulary();
    }
  }
});

ipcMain.handle('user:get-name', async () => {
  const settings = loadUserSettings();
  return settings.userName || null;
});

ipcMain.handle('user:is-onboarded', async (_event, userName: unknown) => {
  const settings = loadUserSettings();
  const onboardedUsers = settings.onboardedUsers || [];
  return onboardedUsers.includes(normalizeUserName(userName));
});

ipcMain.handle('user:mark-onboarded', async (_event, userName: unknown) => {
  const settings = loadUserSettings();
  const onboardedUsers = settings.onboardedUsers || [];
  const normalizedName = normalizeUserName(userName);

  if (normalizedName && !onboardedUsers.includes(normalizedName)) {
    saveUserSettings({
      ...settings,
      onboardedUsers: [...onboardedUsers, normalizedName],
    });
  }
});

// Debounce timer for input-device-change restarts (avoids rapid-fire restarts when the OS
// fires multiple devicechange events during a single plug/unplug event).
let inputDeviceChangeTimer: NodeJS.Timeout | null = null;

/**
 * Schedule a restart of memo-stt to pick up the new OS default input device.
 * Debounced so back-to-back OS events collapse into a single restart.
 */
function scheduleSystemMicRestart(reason: string): void {
  if (inputDeviceChangeTimer) {
    clearTimeout(inputDeviceChangeTimer);
  }
  inputDeviceChangeTimer = setTimeout(() => {
    inputDeviceChangeTimer = null;
    logger.info(`[Main] Restarting memo-stt due to audio input device change (${reason})`);
    memoSttService?.restart();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:showToast', {
        message: 'Microphone updated',
        severity: 'info',
        duration: 2000,
      });
    }
  }, 600);
}

ipcMain.handle('audio:inputDeviceChanged', async () => {
  const alreadyRestarted = await refreshAudioInputDevices();
  if (!selectedSystemMicIsAvailable()) {
    memoSttService?.stop();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:showToast', {
        message: 'Selected microphone unavailable',
        severity: 'warning',
        duration: 3000,
      });
    }
    return;
  }
  if (!alreadyRestarted) {
    scheduleSystemMicRestart('devicechange event');
  }
});

ipcMain.handle('microphone:get-state', async () => {
  await refreshAudioInputDevices();
  return getMicrophoneInputState();
});

ipcMain.handle('microphone:select-system-input', async (_event, deviceName: unknown) => {
  if (deviceName !== null && typeof deviceName !== 'string') {
    throw new Error('Microphone selection must be a device name or system default.');
  }
  const normalizedDeviceName = typeof deviceName === 'string'
    ? deviceName.trim().slice(0, 200)
    : null;
  await selectSystemInput(normalizedDeviceName);
  return getMicrophoneInputState();
});

// Interface settings handlers
ipcMain.handle('settings:getInterfaceSettings', () => {
  const settings = loadSettings();
  const loginItemSettings = app.getLoginItemSettings();
  return {
    sayEnterToPressEnter: settings.sayEnterToPressEnter ?? false,
    handsFreeMode: settings.handsFreeMode ?? false,
    saveAudio: settings.saveAudio ?? false,
    writingMode: settings.writingMode,
    cleanupState: cleanupService.getState(),
    vocabWords: Array.isArray(settings.vocabWords) ? settings.vocabWords : [],
    phraseReplacements: Array.isArray(settings.phraseReplacements) ? settings.phraseReplacements : [],
    startAtLogin: loginItemSettings.openAtLogin || false,
  };
});

ipcMain.handle('settings:setVocabWords', async (_event, vocabWords: string[]) => {
  const settings = loadSettings();
  settings.vocabWords = Array.isArray(vocabWords) ? vocabWords : [];
  saveSettings(settings);

  // Update memo-stt vocabulary for command and replacement handling.
  if (memoSttService) {
    memoSttService.updateVocabulary();
  }

  return true;
});

ipcMain.handle('settings:setPhraseReplacements', async (_event, rules: unknown) => {
  const settings = loadSettings();
  settings.phraseReplacements = clampPhraseReplacementRulesFromInput(rules);
  saveSettings(settings);
  return true;
});

ipcMain.handle('settings:setSayEnterToPressEnter', async (_event, enabled: boolean) => {
  const settings = loadSettings();
  settings.sayEnterToPressEnter = enabled;
  saveSettings(settings);
  updateMenuState();
  return true;
});

ipcMain.handle('settings:setHandsFreeMode', async (_event, enabled: boolean) => {
  const settings = loadSettings();
  const previous = settings.handsFreeMode ?? false;
  settings.handsFreeMode = enabled;
  saveSettings(settings);

  if (memoSttService && previous !== enabled) {
    memoSttService.restart();
  }
  updateMenuState();

  return true;
});

ipcMain.handle('settings:setSaveAudio', async (_event, enabled: boolean) => {
  const settings = loadSettings();
  const changed = settings.saveAudio !== (enabled === true);
  settings.saveAudio = enabled === true;
  saveSettings(settings);
  if (changed) memoSttService?.restart();
  updateMenuState();
  return true;
});

ipcMain.handle('settings:setWritingMode', async (_event, mode: unknown) => {
  if (mode !== 'as-spoken' && mode !== 'clean') {
    throw new Error('Writing mode must be As spoken or Clean.');
  }
  const settings = loadSettings();
  settings.writingMode = mode;
  saveSettings(settings);
  if (mode === 'clean') {
    punctuationService.stop();
    cleanupService.start();
  } else {
    cleanupService.stop();
    if (app.isPackaged) punctuationService.start();
  }
  return true;
});

ipcMain.handle('settings:setStartAtLogin', async (_event, enabled: boolean) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: 'Memo',
    path: process.execPath
  });
  
  updateMenuState();
  
  return true;
});

ipcMain.handle('audio:get', async (_event, entryId: string) => {
  try {
    const data = await audioStorageService.read(entryId) ?? await usbTranscriptService.readAudio(entryId);
    return data ? { success: true, data } : { success: false, error: 'Audio not found' };
  } catch (error) {
    logger.error(`[AudioStorage] Failed to read memo ${entryId}:`, error);
    return { success: false, error: 'Audio could not be loaded' };
  }
});

ipcMain.handle('audio:delete', async (_event, entryId: string) => {
  try {
    await audioStorageService.delete(entryId);
    return { success: true };
  } catch (error) {
    logger.error(`[AudioStorage] Failed to delete memo ${entryId}:`, error);
    return { success: false, error: 'Audio could not be deleted' };
  }
});

ipcMain.handle('audio:openFolder', async () => {
  try {
    const directory = await audioStorageService.openDirectory();
    const error = await shell.openPath(directory);
    return error ? { success: false, error } : { success: true };
  } catch (error) {
    logger.error('[AudioStorage] Failed to open recordings folder:', error);
    return { success: false, error: 'Recordings folder could not be opened' };
  }
});

ipcMain.handle('app-icon:get', (_event, appName: string, bundleId?: string) => {
  return applicationIconService.getIconDataUrl(appName, bundleId);
});

ipcMain.handle('export:json', async (_event, document: unknown) => {
  try {
    return await saveJsonExport(mainWindow, document);
  } catch (error) {
    logger.error('[Export] Failed to save JSON export:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
  }
});
