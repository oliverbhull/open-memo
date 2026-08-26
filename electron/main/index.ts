import { app, autoUpdater, BrowserWindow, ipcMain, systemPreferences, shell, Menu, clipboard } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MemoSttService, TranscriptionData } from './services/MemoSttService';
import { createTray, getMicrophoneInputState, refreshAudioInputDevices, selectSystemInput, setAudioSourceManager, setMainWindow, setOpenMainWindowHandler, setLastTranscript, setRecordingState, setProcessingState, setBleConnectionState, updateMenuState, setBleManager, setMemoSttService } from './services/TrayService';
import {
  loadSettings,
  loadUserSettings,
  migrateToElectronStore,
  saveSettings,
  saveUserSettings,
  store,
} from './services/SettingsService';
import { applyPhraseReplacements, clampPhraseReplacementRulesFromInput } from './services/phraseReplacement';
import { BleManager } from './services/BleManager';
import { AudioSourceManager } from './services/AudioSourceManager';
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
import type { AsrModelId, AsrState } from '../shared/electron-api';
import { resolveTranscriptionText } from '../shared/transcription';
import { UsbTranscriptService } from './services/UsbTranscriptService';
import { DeviceSyncService } from './services/DeviceSyncService';
import { MemoDatabaseService } from './services/MemoDatabaseService';
import { resolveApplicationContext } from './services/applicationContext';
import { AppUpdateService } from './services/AppUpdateService';

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

function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

function devAutoConnectUid(): string | null {
  if (!isDevMode()) return null;
  const directUid = process.env.MEMO_DEV_AUTO_CONNECT_UID?.trim();
  if (directUid && /^[0-9A-Fa-f]{5}$/.test(directUid)) {
    return directUid.toUpperCase();
  }

  const deviceName = process.env.MEMO_DEV_AUTO_CONNECT_DEVICE_NAME?.trim();
  const match = deviceName?.match(/memo_([0-9A-Fa-f]{5})/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function selectedSystemMicIsAvailable(): boolean {
  if (loadSettings().inputSource !== 'system') return true;
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
let bleManager: BleManager | null = null;
let audioSourceManager: AudioSourceManager | null = null;
const appUpdateService = new AppUpdateService(() => mainWindow);
let isRecording = false;
let pendingBlePostStopEnter = false;
let lastTextPasteAtMs = 0;
let awaitingTranscriptionAfterStop = false;
let isQuitting = false;
let micDeviceRecoveryTimer: NodeJS.Timeout | null = null;
const asrModelService = new AsrModelService();
const usbTranscriptService = new UsbTranscriptService();

asrModelService.on('state-changed', (state: AsrState) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('asr:state-changed', state);
  }
});

app.on('second-instance', () => {
  openMainWindow();
});

function pressReturnForBlePostStopEnter(): void {
  execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36'], { stdio: 'ignore' });
}

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
  if (process.platform === 'darwin') {
    app.dock?.show();
    app.focus({ steal: true });
  }
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
  if (!memoSttService || !selectedSystemMicIsAvailable()) return;
  await memoSttService.start();
  if (memoSttService.getStatus() !== 'running') return;
  const settings = loadSettings();
  const uid = devAutoConnectUid() || (settings.inputSource === 'ble' ? store.get('memoUid') : null);
  if (uid && bleManager) {
    const result = await bleManager.connect(uid);
    if (!result.success) logger.warn(`[Main] Could not restore Memo BLE capture: ${result.error}`);
  }
}

async function setupMemoSttService(): Promise<void> {
  // Initialize BLE manager if not exists
  if (!bleManager) {
    logger.info('Creating BleManager instance');
    bleManager = new BleManager(store);

    // Wire up state change events
    bleManager.on('stateChanged', (state) => {
      logger.info(`[BleManager] State changed: connected=${state.connected}, deviceUid=${state.deviceUid}, deviceName=${state.deviceName}, batteryLevel=${state.batteryLevel}`);
      
      // Update tray
      setBleConnectionState(state.connected, state.deviceName || undefined);
      
      // Save UID to settings if connected
      if (state.connected && state.deviceUid) {
        store.set('memoUid', state.deviceUid);
      }
    });
  }

  // Initialize Audio Source Manager if not exists
  if (!audioSourceManager) {
    logger.info('Creating AudioSourceManager instance');
    audioSourceManager = new AudioSourceManager(store);

    // Wire up toast notifications
    audioSourceManager.on('fallbackToast', (toastData) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:showToast', toastData);
      }
    });

    // Handle BLE disconnect: force BleManager + tray to disconnected, start reconnect loop, then restart
    // (so tray is correct even when DISCONNECTED: was never received from Rust)
    audioSourceManager.on('bleDisconnectRestartRequested', () => {
      logger.info('[Main] BLE disconnect restart requested - updating state and tray, then restarting');
      if (bleManager) {
        bleManager.setDisconnectedAndMaybeScheduleReconnect();
        setBleConnectionState(false);
      }
      if (memoSttService) {
        memoSttService.restart();
      }
    });

    // If we can't reconnect after repeated attempts, fall back to system mic.
    // Note: once we switch to system mic, BLE auto-reconnect (CONNECT_UID) won't run until user switches back to BLE.
    bleManager?.on('maxReconnectAttemptsReached', async () => {
      logger.info('[Main] Max BLE reconnect attempts reached - falling back to system mic');
      try {
        await audioSourceManager?.switchToSystemMic('disconnect', true);
      } catch (error) {
        logger.error('[Main] Failed to switch to system mic after max reconnect attempts:', error);
      }
      memoSttService?.restart();
    });

    // Handle restart request for other sources (e.g. manual switch to system mic)
    audioSourceManager.on('restartRequested', (source: 'system' | 'ble') => {
      logger.info(`[Main] Restart requested for source: ${source}`);
      if (memoSttService) {
        memoSttService.restart();
      }
    });

    // Handle settings updated event to refresh tray menu
    audioSourceManager.on('settingsUpdated', () => {
      logger.debug('[Main] Settings updated, refreshing tray menu');
      updateMenuState();
    });

    setAudioSourceManager(audioSourceManager);
  }

  logger.info('Creating new MemoSttService instance');
  memoSttService = new MemoSttService(audioSourceManager);
  
  // Set MemoSttService in BleManager
  if (bleManager) {
    bleManager.setMemoSttService(memoSttService);
  }
  
  // Set service reference in TrayService for command sending
  setMemoSttServiceForTray(memoSttService);
  
  // Set BleManager reference in TrayService for connection operations
  if (bleManager) {
    setBleManager(bleManager);
  }
  
  // Load hotkey from settings, default to 'function'
  const userSettings = loadUserSettings();
  const hotkey = userSettings.hotkey || 'function';
  memoSttService.setHotkey(hotkey);
  
  // Note: postEnter setting is automatically sent by MemoSttService
  // after the process starts (with a delay to ensure stdin is ready)

  memoSttService.on('transcription', async (data: TranscriptionData) => {
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
    const rawText = resolveTranscriptionText(data);
    const normalized = normalizeTranscriptionText(stripLeadingDashSpace(rawText));
    const settings = loadSettings();
    const afterPhrases = applyPhraseReplacements(normalized, settings.phraseReplacements);
    const { textToPaste: textBeforeNormalization, pressEnter: pressEnterThisTime } = stripTrailingEnter(afterPhrases, settings.sayEnterToPressEnter ?? false);
    const textToPaste = normalizeTranscriptionText(textBeforeNormalization);
    const pressEnter = pressEnterThisTime || pendingBlePostStopEnter;

    if (textToPaste) {
      setLastTranscript(textToPaste);
      try {
        clipboard.writeText(textToPaste);
        execFileSync(
          'osascript',
          ['-e', 'tell application "System Events" to keystroke "v" using command down'],
          { stdio: 'ignore' }
        );
        if (pressEnter) {
          pressReturnForBlePostStopEnter();
        }
        pendingBlePostStopEnter = false;
        awaitingTranscriptionAfterStop = false;
        lastTextPasteAtMs = Date.now();
        logger.debug(
          '[Main] Pasted transcription into focused app' +
          (pressEnterThisTime ? ' (voice enter)' : '') +
          (pressEnter && !pressEnterThisTime ? ' (BLE double-tap enter)' : '')
        );
      } catch (pasteErr) {
        logger.warn('[Main] Paste failed (accessibility may be required):', pasteErr);
      }
    }

    // Transcription completes processing, so clear processing state
    setProcessingState(false);

    // Generate one canonical ID for both the memo and its optional WAV file.
    const entryId = randomUUID();
    const { audioCapture, ...transcription } = data;
    const appContext = resolveApplicationContext(
      applicationIconService.enrichContext(data.appContext),
      !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    );
    let audio: Awaited<ReturnType<typeof audioStorageService.save>> | undefined;
    const rendererAvailable = !!mainWindow && !mainWindow.isDestroyed();
    if (rendererAvailable && settings.saveAudio && audioCapture?.wavBuffer) {
      try {
        audio = await audioStorageService.save(entryId, audioCapture.wavBuffer, audioCapture.duration);
      } catch (error) {
        logger.error(`[AudioStorage] Failed to retain audio for memo ${entryId}:`, error);
        mainWindow?.webContents.send('audio:showToast', {
          message: 'Transcript saved, but its audio could not be saved',
          severity: 'warning',
          duration: 4000,
        });
      }
    }

    // Send transcription to renderer (use stripped text so feed does not show "enter")
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription:new', {
        ...transcription,
        processedText: textToPaste,
        rawTranscript: pressEnterThisTime ? textToPaste : (data.rawTranscript ?? ''),
        id: entryId,
        timestamp: Date.now(),
        ...(appContext ? { appContext } : {}),
        ...(audio ? { audio } : {}),
      });
    }
    
  });

  memoSttService.on('status', (status: string) => {
    // Update recording state based on service status
    if (status === 'stopped' || status === 'error') {
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

  // BLE device: second button tap shortly after stop → memo-stt prints BLE_PRESS_ENTER
  memoSttService.on('blePressEnter', () => {
    const settings = loadSettings();
    if (!settings.postEnter) {
      logger.debug('[Main] BLE post-stop enter ignored (BLE double-tap Enter is off)');
      return;
    }
    if (!awaitingTranscriptionAfterStop && Date.now() - lastTextPasteAtMs < 5000) {
      try {
        pressReturnForBlePostStopEnter();
        logger.debug('[Main] BLE post-stop enter: sent Return after already-completed paste');
      } catch (err) {
        logger.warn('[Main] BLE post-stop enter failed (accessibility may be required):', err);
      }
      return;
    }

    pendingBlePostStopEnter = true;
    logger.debug('[Main] BLE post-stop enter queued until next paste');
  });

  memoSttService.on('micInfoUpdated', () => {
    updateMenuState();
  });

  // Handle recording started event - update overlay immediately
  memoSttService.on('recordingStarted', () => {
    logger.debug('[Main] Recording started event received');
    if (!isRecording) {
      pendingBlePostStopEnter = false;
      awaitingTranscriptionAfterStop = false;
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
      awaitingTranscriptionAfterStop = true;
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
    setProcessingState(true);
  });

  // Handle processing completed event.
  memoSttService.on('processingCompleted', () => {
    logger.debug('[Main] Processing completed event received');
    setProcessingState(false);
    // The no-speech path emits this without a transcription event.
    pendingBlePostStopEnter = false;
    awaitingTranscriptionAfterStop = false;
  });

  // Handle processing failed event - clear processing state when transcription fails
  memoSttService.on('processingFailed', () => {
    logger.debug('[Main] Processing failed event received');
    setProcessingState(false);
    pendingBlePostStopEnter = false;
    awaitingTranscriptionAfterStop = false;
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

  // Dock icon: use the app bundle icon from electron-builder (app-icon.icns). Avoid
  // app.dock.setIcon(single 128px bitmap) — it breaks inactive/active Dock rendering.

  // Create menu bar first (needed for macOS to recognize app)
  createMenuBar();

  setOpenMainWindowHandler(openMainWindow);
  openMainWindow();
  appUpdateService.start();

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
      if (loadSettings().inputSource === 'ble') bleManager?.markDisconnectedForCapturePause();
      await memoSttService.suspend();
      return true;
    },
    resumeDictation: async () => {
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
  deviceSyncService.on('transcription', (transcription: TranscriptionData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription:new', transcription);
    }
  });
  void deviceSyncService.start();
  
  app.on('activate', () => {
    openMainWindow();
  });
});

// Cleanup function to ensure the local ASR process is closed
let cleanupComplete = false;
const cleanupMemoStt = () => {
  if (cleanupComplete) return;
  cleanupComplete = true;

  appUpdateService.stop();

  deviceSyncService?.stop({ restoreDictation: false });
  deviceSyncService = null;

  if (memoSttService) {
    logger.info('Cleaning up memo-stt service...');
    memoSttService.stop();
    memoSttService = null;
  }

};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  cleanupMemoStt();
});

autoUpdater.on('before-quit-for-update', () => {
  isQuitting = true;
  cleanupMemoStt();
});

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, cleaning up...');
  cleanupMemoStt();
  app.quit();
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, cleaning up...');
  cleanupMemoStt();
  app.quit();
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  cleanupMemoStt();
  app.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  cleanupMemoStt();
  app.exit(1);
});

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

ipcMain.handle('permissions:check-input-monitoring', async () => {
  if (process.platform !== 'darwin') {
    return true; // Assume granted on non-macOS
  }
  
  try {
    // Input Monitoring doesn't have a direct API in Electron
    // We check by trying to use the permission (indirect check)
    // For now, we'll use a workaround: check if the app can monitor input
    // This is a best-effort check - the actual permission is managed by macOS
    // Electron has no API for this distinct macOS permission. The memo-stt
    // process reports an actionable error if access is missing.
    return app.isReady();
  } catch (error) {
    logger.error('Failed to check input monitoring permission:', error);
    return false;
  }
});

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
    logger.info('[Main] memo-stt service already running');
  }
});

// User name handlers
function normalizeUserName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

ipcMain.handle('user:save-name', async (_event, name: unknown) => {
  saveUserSettings({ userName: normalizeUserName(name) });
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

// Audio Source Management IPC Handlers
// Debounce timer for input-device-change restarts (avoids rapid-fire restarts when the OS
// fires multiple devicechange events during a single plug/unplug event).
let inputDeviceChangeTimer: NodeJS.Timeout | null = null;

/**
 * Schedule a restart of memo-stt to pick up the new OS default input device.
 * Debounced so back-to-back OS events collapse into a single restart.
 */
function scheduleSystemMicRestart(reason: string): void {
  const settings = loadSettings();
  if (settings.inputSource !== 'system') return; // Only applies to system mic mode

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

ipcMain.handle('settings:setStartAtLogin', async (_event, enabled: boolean) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // Start hidden (tray only)
    name: 'Memo',
    path: process.execPath
  });
  
  updateMenuState();
  
  return true;
});

ipcMain.handle('audio:get', async (_event, entryId: string) => {
  try {
    const data = await audioStorageService.read(entryId);
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
