import { app, Menu, Tray, nativeImage, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { loadSettings, saveSettings, store as persistentStore } from './SettingsService.js';
import { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { StoreSchema } from './StoreSchema';

// Track menu open state to prevent rebuilding while open
let menuIsOpen = false;
let pendingMenuUpdate = false;

// Tray and icon references
let tray: Tray | null = null;
let trayBaseIcon: Electron.NativeImage | null = null;
let trayConnectedIcon: Electron.NativeImage | null = null;
let trayRecordingIcon: Electron.NativeImage | null = null;
let trayProcessingIcon: Electron.NativeImage | null = null;

// State tracking
let isRecording = false;
let isProcessing = false;
let isBleConnected = false;
let bleDeviceName: string | null = null;
let lastTranscript: string | null = null;
let mainWindow: BrowserWindow | null = null;
let memoSttService: any = null; // MemoSttService instance
let bleManager: any = null; // BleManager instance
let store: Store<StoreSchema> | null = null; // Store instance for accessing saved UID

/**
 * Set main window reference
 */
export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window;
}

/**
 * Set MemoSttService reference for sending commands
 */
export function setMemoSttService(service: any) {
  memoSttService = service;
}

/**
 * Set BleManager reference for connection operations
 */
export function setBleManager(manager: any, storeInstance: Store<StoreSchema>) {
  bleManager = manager;
  store = storeInstance;
}

/**
 * Set last transcript for copy functionality
 */
export function setLastTranscript(text: string | null) {
  lastTranscript = text;
}

/**
 * Create system tray icon and menu
 */
export function createTray() {
  // Load properly sized tray icons (16×16 @ 1x, 32×32 @ 2x for Retina)
  let baseIcon: Electron.NativeImage | null = null;
  let connectedIcon: Electron.NativeImage | null = null;
  let recordingIcon: Electron.NativeImage | null = null;
  let processingIcon: Electron.NativeImage | null = null;
  
  try {
    const assetsPath = path.join(app.getAppPath(), 'assets');
    
    // Use @2x naming convention for Retina support
    baseIcon = nativeImage.createFromPath(path.join(assetsPath, 'icon-16.png'));
    if (!baseIcon.isEmpty()) {
      const icon2xPath = path.join(assetsPath, 'icon-16@2x.png');
      if (fs.existsSync(icon2xPath)) {
        baseIcon.addRepresentation({ scaleFactor: 2.0, dataURL: nativeImage.createFromPath(icon2xPath).toDataURL() });
      }
    }
    
    connectedIcon = nativeImage.createFromPath(path.join(assetsPath, 'icon_green-16.png'));
    if (!connectedIcon.isEmpty()) {
      const icon2xPath = path.join(assetsPath, 'icon_green-16@2x.png');
      if (fs.existsSync(icon2xPath)) {
        connectedIcon.addRepresentation({ scaleFactor: 2.0, dataURL: nativeImage.createFromPath(icon2xPath).toDataURL() });
      }
    }
    
    recordingIcon = nativeImage.createFromPath(path.join(assetsPath, 'icon_red-16.png'));
    if (!recordingIcon.isEmpty()) {
      // Note: icon_red-16@2x.png may not exist, that's okay
      const icon2xPath = path.join(assetsPath, 'icon_red-16@2x.png');
      if (fs.existsSync(icon2xPath)) {
        recordingIcon.addRepresentation({ scaleFactor: 2.0, dataURL: nativeImage.createFromPath(icon2xPath).toDataURL() });
      }
    }
    
    processingIcon = nativeImage.createFromPath(path.join(assetsPath, 'icon_blue-16.png'));
    if (!processingIcon.isEmpty()) {
      const icon2xPath = path.join(assetsPath, 'icon_blue-16@2x.png');
      if (fs.existsSync(icon2xPath)) {
        processingIcon.addRepresentation({ scaleFactor: 2.0, dataURL: nativeImage.createFromPath(icon2xPath).toDataURL() });
      }
    }
  } catch (e) {
    console.error('[Tray] Failed to load tray icons:', e);
  }
  
  // Fallback to system icons if custom icons fail to load
  if (!baseIcon || baseIcon.isEmpty()) {
    try { baseIcon = nativeImage.createFromNamedImage('NSStatusAvailable', [16, 18, 22]); } catch {}
  }
  if (!baseIcon || baseIcon.isEmpty()) {
    try { baseIcon = nativeImage.createFromNamedImage('NSApplicationIcon'); } catch {}
  }
  if (!baseIcon || baseIcon.isEmpty()) {
    baseIcon = nativeImage.createEmpty();
  }
  
  // Use base icon as fallback for colored icons if they fail to load
  if (!connectedIcon || connectedIcon.isEmpty()) connectedIcon = baseIcon;
  if (!recordingIcon || recordingIcon.isEmpty()) recordingIcon = baseIcon;
  if (!processingIcon || processingIcon.isEmpty()) processingIcon = baseIcon;
  
  trayBaseIcon = baseIcon;
  trayConnectedIcon = connectedIcon;
  trayRecordingIcon = recordingIcon;
  trayProcessingIcon = processingIcon;
  
  // ONLY set template image on the base white icon
  // Colored icons should NOT be template images (they need to show color!)
  try {
    if (baseIcon && (baseIcon as any).setTemplateImage) {
      (baseIcon as any).setTemplateImage(true);
    }
  } catch (e) {
    console.error('[Tray] Failed to set template images:', e);
  }
  
  if (tray) {
    // Update existing tray
    tray.setImage(baseIcon);
  } else {
    // Create new tray
    tray = new Tray(baseIcon);
    tray.setToolTip('Memo');
  }
  
  updateMenuState();
}

/**
 * Copy last transcript to clipboard
 */
function copyLastTranscript() {
  if (lastTranscript) {
    clipboard.writeText(lastTranscript);
  }
}

/**
 * Toggle auto-start at login
 */
function toggleAutoStart() {
  try {
    const currentSettings = app.getLoginItemSettings();
    const newOpenAtLogin = !currentSettings.openAtLogin;
    
    app.setLoginItemSettings({
      openAtLogin: newOpenAtLogin,
      openAsHidden: true, // Start hidden (tray only)
      name: 'Memo',
      path: process.execPath
    });
    
    console.log(`[LoginItem] Auto-start ${newOpenAtLogin ? 'enabled' : 'disabled'}`);
    
    // Update the tray menu to reflect the change
    updateMenuState();
  } catch (e) {
    console.error('[LoginItem] Failed to toggle auto-start:', e);
  }
}

/**
 * Open main window
 */
function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * Update tray menu state based on current application state
 */
export function updateMenuState() {
  if (!tray) return;
  
  // If menu is open, defer the update until it closes
  if (menuIsOpen) {
    pendingMenuUpdate = true;
    return;
  }
  
  const s = loadSettings();
  
  // Build status text (transcription state)
  const statusText = `Status: ${isProcessing ? 'Processing' : (isRecording ? 'Recording' : 'Idle')}  ●`;
  // Bluetooth connection status for visibility
  const bleStatusText = isBleConnected && bleDeviceName
    ? `Bluetooth: Connected (${bleDeviceName})`
    : 'Bluetooth: Disconnected';
  
  // Update tray icon based on state
  // Priority: Processing > Recording > BLE Connected > Base
  try {
    if (isProcessing && trayProcessingIcon) {
      tray.setImage(trayProcessingIcon);
    } else if (isRecording && trayRecordingIcon) {
      tray.setImage(trayRecordingIcon);
    } else if (isBleConnected && trayConnectedIcon) {
      tray.setImage(trayConnectedIcon);
    } else if (trayBaseIcon) {
      tray.setImage(trayBaseIcon);
    }
  } catch (e) {
    console.error('[Tray] Failed to set icon:', e);
  }
  
  const inputSrc = s.inputSource || 'system';
  const lastMic = persistentStore.get('lastSystemMicDevice') as string | null | undefined;
  const lastRate = persistentStore.get('lastSystemMicSampleRate') as number | null | undefined;
  let currentInputSummary = 'Default microphone';
  if (inputSrc === 'ble') {
    currentInputSummary = isBleConnected && bleDeviceName ? bleDeviceName : 'Bluetooth (not connected)';
  } else if (inputSrc === 'radio') {
    currentInputSummary = 'Aux / line-in';
  } else if (lastMic) {
    currentInputSummary = lastRate ? `${lastMic} @ ${lastRate} Hz` : lastMic;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: statusText, enabled: false },
    { label: 'Dashboard', accelerator: 'Command+,', click: () => openMainWindow() },
    { type: 'separator' },
    { label: 'Copy Last Transcript', click: () => copyLastTranscript(), enabled: !!lastTranscript },
    {
      label: 'Audio Input',
      submenu: [
        {
          label: `Current: ${currentInputSummary}`,
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'System Microphone',
          type: 'radio',
          checked: (s.inputSource || 'system') === 'system',
          click: async () => {
            const cfg = loadSettings();
            if (cfg.inputSource !== 'system') {
              cfg.inputSource = 'system';
              saveSettings(cfg);
              
              // Disconnect from BLE if connected
              if (isBleConnected && bleManager) {
                try {
                  await bleManager.disconnect();
                } catch (error) {
                  console.error('[Tray] Failed to disconnect from BLE:', error);
                }
              }
              
              // Restart memo-stt service with new input source
              if (memoSttService && typeof memoSttService.restart === 'function') {
                memoSttService.restart();
              } else if (memoSttService && typeof memoSttService.stop === 'function' && typeof memoSttService.start === 'function') {
                memoSttService.stop();
                setTimeout(() => {
                  memoSttService?.start();
                }, 500);
              }
              updateMenuState();
            }
          }
        },
        {
          label: 'Bluetooth Device',
          type: 'radio',
          checked: (s.inputSource || 'system') === 'ble',
          click: async () => {
            const cfg = loadSettings();
            if (cfg.inputSource !== 'ble') {
              cfg.inputSource = 'ble';
              saveSettings(cfg);
              
              // Restart memo-stt service with new input source
              if (memoSttService && typeof memoSttService.restart === 'function') {
                memoSttService.restart();
              } else if (memoSttService && typeof memoSttService.stop === 'function' && typeof memoSttService.start === 'function') {
                memoSttService.stop();
                setTimeout(() => {
                  memoSttService?.start();
                }, 500);
              }
              
              // Connect/reconnect to BLE device if not already connected
              if (bleManager && store) {
                const savedUid = store.get('memoUid');
                if (savedUid && !isBleConnected) {
                  // Wait a moment for the service to restart, then connect
                  setTimeout(async () => {
                    try {
                      const result = await bleManager.connect(savedUid);
                      if (!result.success) {
                        console.error('[Tray] Failed to connect to BLE device:', result.error);
                      }
                    } catch (error) {
                      console.error('[Tray] Failed to connect to BLE device:', error);
                    }
                  }, 1000);
                }
              }
              
              updateMenuState();
            } else if (cfg.inputSource === 'ble' && !isBleConnected && bleManager && store) {
              // Already set to BLE but not connected - try to reconnect
              const savedUid = store.get('memoUid');
              if (savedUid) {
                try {
                  const result = await bleManager.connect(savedUid);
                  if (!result.success) {
                    console.error('[Tray] Failed to reconnect:', result.error);
                  }
                } catch (error) {
                  console.error('[Tray] Failed to reconnect:', error);
                }
                updateMenuState();
              }
            }
          }
        },
        {
          label: 'Aux',
          type: 'radio',
          checked: (s.inputSource || 'system') === 'radio',
          click: async () => {
            const cfg = loadSettings();
            if (cfg.inputSource !== 'radio') {
              cfg.inputSource = 'radio';
              saveSettings(cfg);

              // Disconnect from BLE if connected
              if (isBleConnected && bleManager) {
                try {
                  await bleManager.disconnect();
                } catch (error) {
                  console.error('[Tray] Failed to disconnect from BLE:', error);
                }
              }

              // Restart memo-stt service with new input source
              if (memoSttService && typeof memoSttService.restart === 'function') {
                memoSttService.restart();
              } else if (memoSttService && typeof memoSttService.stop === 'function' && typeof memoSttService.start === 'function') {
                memoSttService.stop();
                setTimeout(() => {
                  memoSttService?.start();
                }, 500);
              }
              updateMenuState();
            }
          }
        }
      ]
    },
    {
      label: 'Options',
      submenu: [
        { 
          label: 'Start at Login', 
          type: 'checkbox', 
          checked: app.getLoginItemSettings().openAtLogin,
          click: () => toggleAutoStart()
        },
        { 
          label: 'Press Enter After Paste', 
          type: 'checkbox', 
          checked: s.postEnter || false,
          click: () => {
            const cfg = loadSettings();
            cfg.postEnter = !cfg.postEnter;
            saveSettings(cfg);
            // Send command to memo-stt process
            if (memoSttService && typeof memoSttService.setPressEnterAfterPaste === 'function') {
              memoSttService.setPressEnterAfterPaste(cfg.postEnter);
            }
            updateMenuState(); // Refresh menu to show new state
          }
        },
        {
          label: "Say 'enter' to press Enter",
          type: 'checkbox',
          checked: s.sayEnterToPressEnter ?? false,
          click: () => {
            const cfg = loadSettings();
            cfg.sayEnterToPressEnter = !(cfg.sayEnterToPressEnter ?? false);
            saveSettings(cfg);
            updateMenuState();
          }
        },
        {
          label: 'Hands Free',
          type: 'checkbox',
          checked: s.handsFreeMode ?? false,
          click: () => {
            const cfg = loadSettings();
            const next = !(cfg.handsFreeMode ?? false);
            cfg.handsFreeMode = next;
            saveSettings(cfg);
            if (memoSttService && typeof memoSttService.restart === 'function') {
              memoSttService.restart();
            }
            updateMenuState();
          }
        },
        {
          label: 'Mute all output while dictating',
          type: 'checkbox',
          checked: persistentStore.get('pauseMediaWhileRecording', true) !== false,
          click: () => {
            const next = !(persistentStore.get('pauseMediaWhileRecording', true) !== false);
            persistentStore.set('pauseMediaWhileRecording', next);
            updateMenuState();
          }
        }
      ]
    },
    { type: 'separator' },
    { role: 'quit', accelerator: 'Command+Q' },
  ]);
  
  tray.setContextMenu(contextMenu);
  
  // Track menu open/close events to prevent rebuilding while open
  // Remove existing listeners to avoid duplicates
  tray.removeAllListeners('menu-will-show');
  tray.removeAllListeners('menu-will-hide');
  
  tray.on('menu-will-show', () => {
    menuIsOpen = true;
  });
  
  tray.on('menu-will-hide', () => {
    menuIsOpen = false;
    // If there was a pending update, apply it now
    if (pendingMenuUpdate) {
      pendingMenuUpdate = false;
      // Small delay to ensure menu is fully closed before rebuilding
      setTimeout(() => {
        updateMenuState();
      }, 50);
    }
  });
}

/**
 * Update recording state
 */
export function setRecordingState(recording: boolean) {
  isRecording = recording;
  updateMenuState();
}

/**
 * Update processing state
 */
export function setProcessingState(processing: boolean) {
  isProcessing = processing;
  updateMenuState();
}

/**
 * Update BLE connection state
 */
export function setBleConnectionState(connected: boolean, deviceName?: string) {
  isBleConnected = connected;
  bleDeviceName = connected && deviceName ? deviceName : null;
  updateMenuState();
}

/**
 * Get tray instance
 */
export function getTray(): Tray | null {
  return tray;
}

