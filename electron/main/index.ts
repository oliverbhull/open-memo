import { app, BrowserWindow, ipcMain, systemPreferences, shell, Menu, clipboard } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MemoSttService, TranscriptionData } from './services/MemoSttService';
import { createTray, setMainWindow, setLastTranscript, setRecordingState, setProcessingState, setBleConnectionState, updateMenuState, setBleManager, setMemoSttService } from './services/TrayService';
import {
  loadSettings,
  loadUserSettings,
  migrateToElectronStore,
  saveSettings,
  saveUserSettings,
  Settings,
  store,
} from './services/SettingsService';
import { applyPhraseReplacements, clampPhraseReplacementRulesFromInput } from './services/phraseReplacement';
import { DEFAULT_APPS } from './services/DefaultApps';
import { BleManager } from './services/BleManager';
import { AudioSourceManager } from './services/AudioSourceManager';
import { updateOverlayVisibility, sendAudioLevels, sendStatusToOverlay, sendCommandToOverlay } from './services/WindowService';
import { KeystrokeRecorder } from './services/KeystrokeRecorder';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'node:url';
import { logger } from './utils/logger';
import { pauseCompanionMedia, resumeCompanionMedia } from './services/CompanionMediaPause';
import { stripLeadingDashSpace, stripTrailingEnter } from './services/textProcessing';
import { runMemoExport } from './exportMemos';

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

/** Mute system default output (any app) while holding dictation hotkey — see tray “Mute all output while dictating”. */
function shouldMuteSystemOutputWhileDictating(): boolean {
  if (process.platform !== 'darwin') return false;
  return store.get('pauseMediaWhileRecording', true) !== false;
}

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

app.setName('Memo');

const gotSingleInstanceLock = isExportMode || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let memoSttService: MemoSttService | null = null;
let bleManager: BleManager | null = null;
let audioSourceManager: AudioSourceManager | null = null;
let keystrokeRecorder: KeystrokeRecorder | null = null;
let isRecording = false;
let pendingBlePostStopEnter = false;
let lastTextPasteAtMs = 0;
let awaitingTranscriptionAfterStop = false;

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
  }
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

  // Show and focus the window
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  // Set main window in tray service
  setMainWindow(mainWindow);
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

function setupMemoSttService(): void {
  // Guard against multiple service instances
  if (memoSttService) {
    logger.warn('MemoSttService already exists, stopping existing instance before creating new one');
    memoSttService.stop();
    memoSttService = null;
  }

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
      
      // Send to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('device:connectionChanged', {
          connected: state.connected,
          deviceUid: state.deviceUid,
          deviceName: state.deviceName,
          batteryLevel: state.batteryLevel,
        });
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

    audioSourceManager.on('sourceChanged', (source) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:sourceChanged', source);
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

    // When AudioSourceManager signals a system mic device change, do a debounced restart
    audioSourceManager.on('systemMicDeviceChanged', () => {
      scheduleSystemMicRestart('AudioSourceManager systemMicDeviceChanged');
    });
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
  
  // Resolve connection settings before starting the service once below.
  const settings = loadSettings();
  const devUid = devAutoConnectUid();
  if (devUid) {
    logger.info(`[Main] Dev auto-connect requested for memo_${devUid}`);
  }
  
  // Note: postEnter setting is automatically sent by MemoSttService
  // after the process starts (with a delay to ensure stdin is ready)

  memoSttService.on('commandExecuted', (command: { type: string; app?: string; command?: string; url?: string }) => {
    logger.info(`[Main] Command executed: ${command.type}`, command);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('command:executed', command);
    }

    // Derive a short human-readable label for the overlay toast
    let toastLabel: string;
    if (command.type === 'open_app' && command.app) {
      toastLabel = `Open ${command.app}`;
    } else if (command.type === 'app_command' && command.command) {
      toastLabel = command.command;
    } else if (command.type === 'url' && command.url) {
      try {
        toastLabel = new URL(command.url).hostname.replace(/^www\./, '');
      } catch {
        toastLabel = command.url;
      }
    } else {
      toastLabel = command.type;
    }

    sendCommandToOverlay(toastLabel, mainWindow);
  });

  memoSttService.on('transcription', async (data: TranscriptionData) => {
    // System output unmute is handled once in processingCompleted / processingFailed / status
    // (MemoSttService emits processingCompleted after every transcription). Do not resume here
    // or we double-call resumeCompanionMedia and confuse mute depth / Bluetooth timing.
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
    const rawText = data.processedText || data.rawTranscript || '';
    const normalized = stripLeadingDashSpace(rawText);
    const settings = loadSettings();
    const afterPhrases = applyPhraseReplacements(normalized, settings.phraseReplacements);
    const { textToPaste, pressEnter: pressEnterThisTime } = stripTrailingEnter(afterPhrases, settings.sayEnterToPressEnter ?? false);
    const pressEnter = pressEnterThisTime || pendingBlePostStopEnter;

    if (textToPaste) {
      setLastTranscript(textToPaste);
      // Prepend space so consecutive dictations don't run together
      const pasteText = ' ' + textToPaste;
      try {
        clipboard.writeText(pasteText);
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

    // Generate the canonical entry ID before sending the memo to the renderer.
    const entryId = randomUUID();

    // Send transcription to renderer (use stripped text so feed does not show "enter")
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription:new', {
        ...data,
        processedText: textToPaste,
        rawTranscript: pressEnterThisTime ? textToPaste : (data.rawTranscript ?? ''),
        id: entryId,
        timestamp: Date.now(),
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
        if (shouldMuteSystemOutputWhileDictating()) {
          resumeCompanionMedia();
        }
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
      if (shouldMuteSystemOutputWhileDictating()) {
        pauseCompanionMedia();
      }
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
      // Do not unmute here — wait until ASR finishes (transcription / processingCompleted / processingFailed).
    } else {
      logger.warn('[Main] Recording stopped event received but not recording');
    }
  });

  // Handle processing started event
  memoSttService.on('processingStarted', () => {
    logger.debug('[Main] Processing started event received');
    setProcessingState(true);
  });

  // Handle processing completed event - clear processing state when transcription completes or command executes
  memoSttService.on('processingCompleted', () => {
    logger.debug('[Main] Processing completed event received');
    setProcessingState(false);
    // No-speech path and voice-command-only path emit this without a transcription event
    pendingBlePostStopEnter = false;
    awaitingTranscriptionAfterStop = false;
    if (shouldMuteSystemOutputWhileDictating()) {
      resumeCompanionMedia();
    }
  });

  // Handle processing failed event - clear processing state when transcription fails
  memoSttService.on('processingFailed', () => {
    logger.debug('[Main] Processing failed event received');
    setProcessingState(false);
    pendingBlePostStopEnter = false;
    awaitingTranscriptionAfterStop = false;
    if (shouldMuteSystemOutputWhileDictating()) {
      resumeCompanionMedia();
    }
    if (isRecording) {
      logger.warn('[Main] Recording state still set when processing failed, clearing it');
      isRecording = false;
      setRecordingState(false);
      updateOverlayVisibility(false, mainWindow);
      sendStatusToOverlay(false, mainWindow);
    }
  });

  // Handle audio device errors from memo-stt (e.g. headphones disconnected mid-session
  // or a saved device label that no longer matches any CoreAudio device).
  // Clear the pinned device label so the next start uses the OS default input, then restart.
  memoSttService.on('micDeviceError', (detail: string) => {
    logger.warn(`[Main] mic device error: ${detail} — clearing fallback device and restarting`);
    audioSourceManager?.clearFallbackDevice();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:showToast', {
        message: 'Microphone reconnecting…',
        severity: 'warning',
        duration: 3000,
      });
    }
    // Brief delay so any pending stderr/exit events flush before we restart
    setTimeout(() => memoSttService?.restart(), 800);
  });

  // Start memo-stt service
  memoSttService.start();
  
  // If a dev exact-device UID is provided, it wins over any saved UID.
  // Wait a moment for service to be ready, then connect
  if (devUid && bleManager) {
    logger.info(`[Main] Will connect to dev UID: ${devUid} after service starts`);
    setTimeout(() => {
      bleManager?.connect(devUid).catch((err) => {
        logger.error(`[Main] Failed to connect dev UID ${devUid}: ${err}`);
      });
    }, 500);
  } else if (settings.inputSource === 'ble') {
    const savedUid = store.get('memoUid');
    if (savedUid && bleManager) {
      logger.info(`[Main] Will connect to saved UID: ${savedUid} after service starts`);
      // Wait for service to be ready (Rust process started)
      setTimeout(() => {
        bleManager?.connect(savedUid).catch((err) => {
          logger.error(`[Main] Failed to connect: ${err}`);
        });
      }, 500);
    }
  }
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

  createWindow();

  // Only start memo-stt service if user is onboarded
  // This prevents the Input Monitoring dialog from appearing before onboarding
  const userSettings = loadUserSettings();
  const userName = userSettings.userName;
  const isOnboarded = userName && (userSettings.onboardedUsers || []).includes(userName);

  if (isOnboarded) {
    setupMemoSttService();
  } else {
    logger.info('[Main] User not onboarded yet, skipping memo-stt service start');
  }
  
  // Initialize tray. The overlay window is created on demand when recording
  // starts so its transparency context is fresh for the active display.
  createTray();
  
  // Ensure app is active and window is in front
  if (process.platform === 'darwin') {
    app.dock?.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      // Bring window to front
      mainWindow.moveTop();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      // Bring existing window to front
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
      }
    }
  });
});

// Cleanup function to ensure the local ASR process is closed
let cleanupComplete = false;
const cleanupMemoStt = () => {
  if (cleanupComplete) return;
  cleanupComplete = true;

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

ipcMain.handle('memo-stt:restart', () => {
  if (memoSttService) {
    memoSttService.stop();
    setTimeout(() => {
      memoSttService?.start();
    }, 500);
  }
});

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
ipcMain.handle('app:start-memo-stt-service', () => {
  if (!memoSttService) {
    logger.info('[Main] Starting memo-stt service on demand');
    setupMemoSttService();
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

// Device IPC Handlers - Simplified UID-only connection
ipcMain.handle('device:connectByUid', async (_event, uid: string) => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    
    // Check if input source is set to 'ble', if not, switch it
    const settings = loadSettings();
    if (settings.inputSource !== 'ble') {
      logger.info('[Device] Switching input source to BLE before connecting');
      settings.inputSource = 'ble';
      saveSettings(settings);
      
      // Restart memo-stt service with new input source
      if (memoSttService) {
        memoSttService.restart();
        
        // Wait a moment for the service to restart before connecting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Now connect to the BLE device
    return await bleManager.connect(uid);
  } catch (error) {
    logger.error('[Device] Failed to connect by UID:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('device:disconnect', async () => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    return await bleManager.disconnect();
  } catch (error) {
    logger.error('[Device] Failed to disconnect:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('device:getConnectionState', () => {
  return bleManager?.getState() || { connected: false, deviceUid: null, deviceName: null, batteryLevel: null };
});

ipcMain.handle('device:clearSavedDevice', async () => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    return await bleManager.clearSavedDevice();
  } catch (error) {
    logger.error('[Device] Failed to clear saved device:', error);
    return { success: false, error: String(error) };
  }
});

// Audio Source Management IPC Handlers
ipcMain.handle('audio:getSource', () => {
  if (!audioSourceManager) {
    return { source: 'system' };
  }

  return { source: audioSourceManager.getCurrentSource() };
});

ipcMain.handle('audio:setFallbackMic', async (_event, micId: string, label?: string | null) => {
  try {
    if (!audioSourceManager) {
      return { success: false, error: 'Audio Source Manager not initialized' };
    }

    audioSourceManager.setFallbackMic(micId, label);
    return { success: true };
  } catch (error) {
    logger.error('[Audio] Failed to set fallback mic:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('audio:switchToSystemMic', async () => {
  try {
    if (!audioSourceManager) {
      return { success: false, error: 'Audio Source Manager not initialized' };
    }

    await audioSourceManager.switchToSystemMic('manual');
    return { success: true };
  } catch (error) {
    logger.error('[Audio] Failed to switch to system mic:', error);
    return { success: false, error: String(error) };
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

ipcMain.handle('audio:inputDeviceChanged', () => {
  scheduleSystemMicRestart('devicechange event');
});

// Interface settings handlers
ipcMain.handle('settings:getInterfaceSettings', () => {
  const settings = loadSettings();
  const loginItemSettings = app.getLoginItemSettings();
  return {
    pressEnterAfterPaste: settings.postEnter || false,
    sayEnterToPressEnter: settings.sayEnterToPressEnter ?? false,
    pushToTalkMode: settings.pushToTalkMode ?? false,
    handsFreeMode: settings.handsFreeMode ?? false,
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

ipcMain.handle('settings:setPressEnterAfterPaste', async (_event, enabled: boolean) => {
  const settings = loadSettings();
  settings.postEnter = enabled;
  saveSettings(settings);
  
  // Send command to memo-stt process
  if (memoSttService && typeof memoSttService.setPressEnterAfterPaste === 'function') {
    memoSttService.setPressEnterAfterPaste(enabled);
  }
  
  return true;
});

ipcMain.handle('settings:setPushToTalkMode', async (_event, enabled: boolean) => {
  const settings = loadSettings();
  settings.pushToTalkMode = enabled;
  saveSettings(settings);

  if (memoSttService && typeof memoSttService.setPushToTalkMode === 'function') {
    memoSttService.setPushToTalkMode(enabled);
  }

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

// Voice command handlers
ipcMain.handle('settings:getVoiceCommands', () => {
  const settings = loadSettings();
  return settings.voiceCommands || {
    enabled: false,
    apps: DEFAULT_APPS,
    globalCommands: [],
    urlPatterns: [],
  };
});

ipcMain.handle('settings:saveVoiceCommands', async (_event, voiceCommands: Settings['voiceCommands']) => {
  const settings = loadSettings();
  const updated: Settings = {
    ...settings,
    voiceCommands,
  };
  saveSettings(updated);
  
  // Update vocabulary in memo-stt service
  if (memoSttService) {
    memoSttService.updateVocabulary();
  }
  
  return true;
});

// Keystroke recording handlers
if (!keystrokeRecorder) {
  keystrokeRecorder = new KeystrokeRecorder();
}

ipcMain.handle('keystroke:start-recording', () => {
  try {
    if (keystrokeRecorder) {
      keystrokeRecorder.startRecording();
      return { success: true };
    }
    return { success: false, error: 'Keystroke recorder not initialized' };
  } catch (error) {
    logger.error('[IPC] Failed to start keystroke recording:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('keystroke:stop-recording', () => {
  try {
    if (keystrokeRecorder) {
      const result = keystrokeRecorder.stopRecording();
      return { success: true, keystroke: result };
    }
    return { success: false, error: 'Keystroke recorder not initialized' };
  } catch (error) {
    logger.error('[IPC] Failed to stop keystroke recording:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('keystroke:is-recording', () => {
  try {
    if (keystrokeRecorder) {
      return { success: true, isRecording: keystrokeRecorder.isCurrentlyRecording() };
    }
    return { success: false, isRecording: false };
  } catch (error) {
    logger.error('[IPC] Failed to check recording status:', error);
    return { success: false, isRecording: false };
  }
});

ipcMain.handle('keystroke:record', (_event, modifiers: string[], key: string) => {
  try {
    if (keystrokeRecorder) {
      keystrokeRecorder.recordKeystroke(modifiers, key);
      return { success: true };
    }
    return { success: false, error: 'Keystroke recorder not initialized' };
  } catch (error) {
    logger.error('[IPC] Failed to record keystroke:', error);
    return { success: false, error: String(error) };
  }
});
