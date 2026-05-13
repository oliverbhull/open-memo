import { app, BrowserWindow, ipcMain, systemPreferences, shell, Menu, clipboard } from 'electron';
import { MemoSttService, TranscriptionData } from './services/MemoSttService';
import { syncOrchestrator } from './services/SyncOrchestrator';
import { connectionService } from './services/ConnectionService';
import { createTray, setMainWindow, setLastTranscript, setRecordingState, setProcessingState, setBleConnectionState, updateMenuState, setBleManager } from './services/TrayService';
import { loadSettings, saveSettings, Settings, AppConfig, store, migrateToElectronStore } from './services/SettingsService';
import { applyPhraseReplacements, clampPhraseReplacementRulesFromInput } from './services/phraseReplacement';
import { DEFAULT_APPS } from './services/DefaultApps';
import { BleManager } from './services/BleManager';
import { AudioSourceManager } from './services/AudioSourceManager';
import { updateOverlayVisibility, sendAudioLevels, sendStatusToOverlay, sendCommandToOverlay } from './services/WindowService';
// Audio storage disabled for open-source release (can be re-enabled)
// import { audioStorageService } from './services/AudioStorageService';
// License system removed for open-source release
// import { licenseService } from './services/LicenseService';
import { KeystrokeRecorder } from './services/KeystrokeRecorder';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger } from './utils/logger';
import { pauseCompanionMedia, resumeCompanionMedia } from './services/CompanionMediaPause';

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
  return match ? match[1].toUpperCase() : null;
}

/**
 * Strip leading dash and space(s) from transcript (e.g. Whisper bullet-style "- Can you...").
 */
function stripLeadingDashSpace(text: string): string {
  const t = text.trim();
  if (t.startsWith('-')) {
    return t.slice(1).trimStart();
  }
  return t;
}

/**
 * If text ends with "enter" (fuzzy: case-insensitive, optional punctuation), strip it and return true for pressEnter.
 * Used when "Say 'enter' to press Enter" is enabled.
 */
function stripTrailingEnter(
  text: string,
  sayEnterToPressEnter: boolean
): { textToPaste: string; pressEnter: boolean } {
  if (!sayEnterToPressEnter || !text || typeof text !== 'string') {
    return { textToPaste: text.trim(), pressEnter: false };
  }
  const trimmed = text.trim();
  // Fuzzy match: trailing "enter" (optional punct)
  const match = trimmed.match(/\s+enter\s*[,.]?\s*$/i);
  if (match) {
    const stripped = trimmed.slice(0, -match[0].length).trimEnd();
    return { textToPaste: stripped, pressEnter: true };
  }
  return { textToPaste: trimmed, pressEnter: false };
}

app.setName('Memo');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
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
  const { execSync } = require('child_process');
  execSync('osascript -e \'tell application "System Events" to key code 36\'', { stdio: 'ignore' });
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
    },
    // Removed vibrancy to allow CSS backdrop-filter to control blur
    // ...(process.platform === 'darwin' && {
    //   vibrancy: 'ultra-dark',
    //   visualEffectState: 'active',
    // }),
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, dist-react is bundled in app.asar
    const htmlPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    mainWindow.loadFile(htmlPath);
  }

  // Show and focus the window
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  mainWindow.on('closed', () => {
    connectionService.setMainWindow(null);
    setMainWindow(null);
    mainWindow = null;
  });

  // Set main window in connection service and tray service
  connectionService.setMainWindow(mainWindow);
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
  const { setMemoSttService } = require('./services/TrayService');
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
        const settings = loadSettings();
        settings.memoUid = state.deviceUid;
        saveSettings(settings);
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
  }

  logger.info('Creating new MemoSttService instance');
  memoSttService = new MemoSttService(null, audioSourceManager);
  
  // Set MemoSttService in BleManager
  if (bleManager) {
    bleManager.setMemoSttService(memoSttService);
  }
  
  // Set service reference in TrayService for command sending
  setMemoSttServiceForTray(memoSttService);
  
  // Set BleManager reference in TrayService for connection operations
  if (bleManager) {
    setBleManager(bleManager, store);
  }
  
  // Load hotkey from settings, default to 'function'
  const userSettings = loadUserSettings();
  const hotkey = userSettings.hotkey || 'function';
  memoSttService.setHotkey(hotkey);
  
  // Auto-start service if BLE is the input source and we have a saved device name
  const settings = loadSettings();
  const devUid = devAutoConnectUid();
  if (devUid) {
    logger.info(`[Main] Dev auto-connect requested for memo_${devUid}`);
    memoSttService.start();
  } else if (settings.inputSource === 'ble' && settings.autoConnectDeviceName) {
    logger.info(`[Main] Auto-starting service with BLE input source and saved device: ${settings.autoConnectDeviceName}`);
    memoSttService.start();
  }
  
  // Note: postEnter setting is automatically sent by MemoSttService
  // after the process starts (with a delay to ensure stdin is ready)

  // Audio storage disabled for open-source release
  // let pendingAudioData: { opusBuffer: Buffer; wavBuffer?: Buffer; duration: number; timestamp: number } | null = null;
  // memoSttService.on('audioData', (audioData) => {
  //   pendingAudioData = audioData;
  // });

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
        const { execSync } = require('child_process');
        execSync('osascript -e \'tell application "System Events" to keystroke "v" using command down\'', { stdio: 'ignore' });
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

    // Generate entry ID in main process so we can save audio with it
    const { randomUUID } = require('crypto');
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
    
    // Audio storage disabled for open-source release
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
      // Do not unmute here — wait until Whisper finishes (transcription / processingCompleted / processingFailed).
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

  // Handle BLE device discovery events (from memo-stt scanning)
  // Note: This is a global handler that forwards all discoveries
  // The scan handler also sets up its own temporary handler
  memoSttService.on('deviceDiscovered', (device: { name: string; id: string; rssi: number }) => {
    logger.debug('[Main] Device discovered:', device.name);
    // Forward to renderer immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('device:deviceFound', device);
    }
  });

  // BLE connection events are now handled by BleManager
  // MemoSttService just emits events, BleManager manages state

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

app.whenReady().then(() => {
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
  
  // Audio storage disabled for open-source release
  // audioStorageService.initialize()

  // License system removed for open-source release
  // licenseService.initialize()

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

// Cleanup function to ensure Whisper is closed
const cleanupMemoStt = () => {
  if (memoSttService) {
    logger.info('Cleaning up memo-stt service...');
    memoSttService.stop();
    memoSttService = null;
  }

  // Also cleanup connection service
  connectionService.stopListening();

  // Audio storage disabled for open-source release
  // audioStorageService.shutdown()
};

app.on('window-all-closed', () => {
  cleanupMemoStt();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  cleanupMemoStt();
});

app.on('will-quit', (event) => {
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
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  cleanupMemoStt();
});

// User settings file path
const getUserSettingsPath = (): string => {
  return path.join(os.homedir(), '.memo-web-settings.json');
};

// Load user settings
const loadUserSettings = (): { userName?: string; onboardedUsers?: string[]; hotkey?: string } => {
  try {
    const settingsPath = getUserSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.error('Failed to load user settings:', error);
  }
  return {};
};

// Save user settings with atomic write to prevent race conditions
const saveUserSettings = (settings: { userName?: string; onboardedUsers?: string[]; hotkey?: string }): void => {
  try {
    const settingsPath = getUserSettingsPath();
    const tempPath = `${settingsPath}.tmp`;
    const existing = loadUserSettings();
    const updated = { ...existing, ...settings };
    
    // Write to temporary file first
    fs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8');
    
    // Atomic rename (rename is atomic on most filesystems)
    fs.renameSync(tempPath, settingsPath);
  } catch (error) {
    logger.error('Failed to save user settings:', error);
    // Clean up temp file if it exists
    try {
      const tempPath = `${getUserSettingsPath()}.tmp`;
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (cleanupError) {
      logger.error('Failed to cleanup temp settings file:', cleanupError);
    }
  }
};

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
    if (app.isReady() && systemPreferences.isTrustedAccessibilityClient) {
      // Input Monitoring is separate from Accessibility, but we can't directly check it
      // Return true if we can't determine (user will need to check manually)
      // The memo-stt binary will fail if permission isn't granted, which we'll detect
      return true; // We'll detect the actual status when memo-stt tries to start
    }
    return false;
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
ipcMain.handle('user:save-name', async (_event, name: string) => {
  saveUserSettings({ userName: name });
});

ipcMain.handle('user:get-name', async () => {
  const settings = loadUserSettings();
  return settings.userName || null;
});

ipcMain.handle('user:is-onboarded', async (_event, userName: string) => {
  const settings = loadUserSettings();
  const onboardedUsers = settings.onboardedUsers || [];
  return onboardedUsers.includes(userName);
});

ipcMain.handle('user:mark-onboarded', async (_event, userName: string) => {
  const settings = loadUserSettings();
  const onboardedUsers = settings.onboardedUsers || [];
  
  if (!onboardedUsers.includes(userName)) {
    saveUserSettings({
      ...settings,
      onboardedUsers: [...onboardedUsers, userName],
    });
  }
});

// Sync handlers
ipcMain.handle('sync:start-listening', () => {
  return syncOrchestrator.startListening();
});

ipcMain.handle('sync:stop-listening', () => {
  syncOrchestrator.stopListening();
});

ipcMain.handle('sync:get-connection-info', () => {
  return syncOrchestrator.getConnectionInfo();
});

ipcMain.handle('sync:sync-now', async () => {
  return syncOrchestrator.syncNow();
});

ipcMain.handle('sync:get-status', () => {
  return syncOrchestrator.getStatus();
});

ipcMain.handle('sync:get-last-sync-time', () => {
  return syncOrchestrator.getLastSyncTime();
});

ipcMain.handle('sync:is-connected', () => {
  return syncOrchestrator.isConnected();
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
        if (typeof memoSttService.restart === 'function') {
          memoSttService.restart();
        } else if (typeof memoSttService.stop === 'function' && typeof memoSttService.start === 'function') {
          memoSttService.stop();
          setTimeout(() => {
            memoSttService?.start();
          }, 500);
        }
        
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

// Legacy BLE IPC Handlers - Updated to use BleManager for backward compatibility
ipcMain.handle('ble:setUid', async (_event, uid: string) => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    // Connect using the new simplified API
    return await bleManager.connect(uid);
  } catch (error) {
    logger.error('[BLE] Failed to set UID:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('ble:clearUid', async () => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    await bleManager.disconnect();
    // Clear UID from store
    store.set('memoUid', null);
    return { success: true };
  } catch (error) {
    logger.error('[BLE] Failed to clear UID:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('ble:getState', () => {
  if (!bleManager) {
    return {
      state: 'idle',
      memoUid: null,
      connectedDeviceName: null,
      batteryLevel: null,
      reconnectAttempts: 0,
      lastConnectionTime: null,
      errorMessage: 'BLE Manager not initialized',
    };
  }
  const state = bleManager.getState();
  // Return in old format for backward compatibility
  return {
    state: state.connected ? 'connected' : 'idle',
    memoUid: state.deviceUid,
    connectedDeviceName: state.deviceName,
    batteryLevel: state.batteryLevel,
    reconnectAttempts: 0,
    lastConnectionTime: null,
    errorMessage: null,
  };
});

ipcMain.handle('ble:reconnect', async () => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    const state = bleManager.getState();
    if (state.deviceUid) {
      return await bleManager.connect(state.deviceUid);
    }
    return { success: false, error: 'No UID to reconnect with' };
  } catch (error) {
    logger.error('[BLE] Failed to reconnect:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('ble:disconnect', async () => {
  try {
    if (!bleManager) {
      return { success: false, error: 'BLE Manager not initialized' };
    }
    return await bleManager.disconnect();
  } catch (error) {
    logger.error('[BLE] Failed to disconnect:', error);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('ble:setAutoReconnect', async (_event, enabled: boolean) => {
  try {
    store.set('autoReconnect', enabled);
    return { success: true };
  } catch (error) {
    logger.error('[BLE] Failed to set auto-reconnect:', error);
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

  // Update memo-stt vocabulary (Whisper prompt hints)
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
  if (trayService) {
    updateMenuState();
  }
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
  
  // Update tray menu to reflect the change
  if (trayService) {
    updateMenuState();
  }
  
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

// Sync status events
syncOrchestrator.on('status', (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync:status', status);
  }
});

// Handle incoming sync messages from renderer (responses to WebSocket)
ipcMain.on('sync:outgoing-message', (_event, message) => {
  logger.info('Received outgoing message from renderer:', message.type);
  try {
    if (connectionService.isConnected()) {
      logger.info('Forwarding message to WebSocket client:', message.type);
      connectionService.sendMessage(message);
    } else {
      logger.warn('Cannot send message: not connected to client');
    }
  } catch (error) {
    logger.error('Error forwarding message to WebSocket:', error);
  }
});

// Handle incoming WebSocket messages - forward to renderer
ipcMain.handle('sync:handle-message', async (_event, message) => {
  // This will be called by renderer after processing
  // Return response to send back via WebSocket
  return message; // Renderer will send the response via sync:outgoing-message
});

// Clear IndexedDB storage (for corrupted database recovery)
ipcMain.handle('storage:clear-indexeddb', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window not available');
  }
  
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  try {
    // First, try Electron's session API
    await mainWindow.webContents.session.clearStorageData({
      storages: ['indexeddb'],
    });
    logger.info('IndexedDB storage cleared via session API');
    
    // In development, also try to delete the LOCK file directly
    if (isDev) {
      const userDataPath = app.getPath('userData');
      const indexedDBPath = path.join(userDataPath, 'IndexedDB');
      
      // Wait a bit for session clear to complete
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Try to remove LOCK files in development
      try {
        const indexedDBDir = path.join(indexedDBPath, 'http_localhost_5173.indexeddb.leveldb');
        if (fs.existsSync(indexedDBDir)) {
          const lockFile = path.join(indexedDBDir, 'LOCK');
          if (fs.existsSync(lockFile)) {
            logger.warn('Removing stuck LOCK file in development mode...');
            fs.unlinkSync(lockFile);
            logger.info('LOCK file removed');
          }
          
          // Also try to remove the entire directory if it's still problematic
          // (we'll recreate it on next open)
          try {
            fs.rmSync(indexedDBDir, { recursive: true, force: true });
            logger.info('Removed IndexedDB directory in development mode');
          } catch (rmError) {
            // Directory might be in use, that's okay
            logger.debug('Could not remove IndexedDB directory:', rmError);
          }
        }
      } catch (fileError) {
        logger.warn('Could not remove LOCK file (may be in use):', fileError);
        // Not critical, session clear should have worked
      }
    }
    
    return true;
  } catch (error) {
    logger.error('Failed to clear IndexedDB storage:', error);
    throw error;
  }
});

// Audio storage and license IPC handlers removed for open-source release.
// See AudioStorageService.ts to re-enable audio storage.

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


