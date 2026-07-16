import { app, Menu, Tray, nativeImage, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { loadSettings, saveSettings, store as persistentStore } from './SettingsService.js';
import { BrowserWindow } from 'electron';
import type { MemoSttService } from './MemoSttService';
import type { BleManager } from './BleManager';
import type { AudioSourceManager } from './AudioSourceManager';
import { audioInputService } from './AudioInputService';

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
let memoSttService: MemoSttService | null = null;
let bleManager: BleManager | null = null;
let audioSourceManager: AudioSourceManager | null = null;

/**
 * Set main window reference
 */
export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window;
}

/**
 * Set MemoSttService reference for sending commands
 */
export function setMemoSttService(service: MemoSttService | null) {
  memoSttService = service;
}

/**
 * Set BleManager reference for connection operations
 */
export function setBleManager(manager: BleManager | null) {
  bleManager = manager;
}

export function setAudioSourceManager(manager: AudioSourceManager | null) {
  audioSourceManager = manager;
}

/**
 * Set last transcript for copy functionality
 */
export function setLastTranscript(text: string | null) {
  lastTranscript = text;
}

function restartMemoStt(): void {
  memoSttService?.restart();
}

export async function refreshAudioInputDevices(): Promise<boolean> {
  const devices = await audioInputService.refresh();
  const selectedName = persistentStore.get('selectedSystemMicName');
  const settings = loadSettings();
  let fellBackToDefault = false;

  // Keep the user's preference while the device is disconnected. MemoSttService
  // omits unavailable saved names, using the system default until it returns.
  if (
    selectedName &&
    devices.length > 0 &&
    !devices.some((device) => device.name === selectedName)
  ) {
    console.log(`[Tray] Selected microphone is unavailable: ${selectedName}; using system default`);
    if (settings.inputSource === 'system') {
      restartMemoStt();
      fellBackToDefault = true;
    }
  }

  // Restart when the remembered device returns so the live session moves back
  // from the system default to the user's saved choice.
  if (
    selectedName &&
    devices.some((device) => device.name === selectedName) &&
    persistentStore.get('lastSystemMicDevice') !== selectedName &&
    settings.inputSource === 'system'
  ) {
    console.log(`[Tray] Selected microphone is available again: ${selectedName}`);
    restartMemoStt();
    fellBackToDefault = true;
  }

  updateMenuState();
  return fellBackToDefault;
}

async function selectSystemInput(deviceName: string | null): Promise<void> {
  if (deviceName && !audioInputService.getDevices().some((device) => device.name === deviceName)) {
    console.warn(`[Tray] Ignoring unavailable microphone selection: ${deviceName}`);
    return;
  }

  const settings = loadSettings();
  const previousName = persistentStore.get('selectedSystemMicName') || null;
  const changed = settings.inputSource !== 'system' || previousName !== deviceName;

  // Set the explicit-system flag before disconnecting BLE so its asynchronous
  // disconnect event cannot restore BLE as the preferred source.
  if (audioSourceManager) {
    audioSourceManager.selectSystemMic(deviceName);
  } else {
    persistentStore.set('selectedSystemMicName', deviceName);
    settings.inputSource = 'system';
    saveSettings(settings);
  }

  if ((settings.inputSource === 'ble' || isBleConnected) && bleManager) {
    try {
      await bleManager.disconnect();
    } catch (error) {
      console.error('[Tray] Failed to disconnect from BLE:', error);
    }
  }

  if (changed) restartMemoStt();
  updateMenuState();
}

async function refreshAudioInputsFromMenu(): Promise<void> {
  const alreadyRestarted = await refreshAudioInputDevices();
  const settings = loadSettings();
  if (
    !alreadyRestarted &&
    settings.inputSource === 'system' &&
    !persistentStore.get('selectedSystemMicName')
  ) {
    restartMemoStt();
  }
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
    baseIcon?.setTemplateImage(true);
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
  void refreshAudioInputDevices();
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

function openSettings() {
  openMainWindow();
  mainWindow?.webContents.send('settings:open');
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
  const statusText = `Memo — ${isProcessing ? 'Processing' : (isRecording ? 'Recording' : 'Ready')}`;
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
  const selectedSystemMic = persistentStore.get('selectedSystemMicName') || null;
  const availableSystemMics = audioInputService.getDevices();
  const defaultSystemMic = audioInputService.getDefaultDevice();
  const lastMic = persistentStore.get('lastSystemMicDevice') as string | null | undefined;
  const lastRate = persistentStore.get('lastSystemMicSampleRate') as number | null | undefined;
  let currentInputSummary = defaultSystemMic
    ? `System Default — ${defaultSystemMic.name}`
    : 'System Default';
  if (inputSrc === 'ble') {
    currentInputSummary = isBleConnected && bleDeviceName ? bleDeviceName : 'Bluetooth (not connected)';
  } else if (inputSrc === 'radio') {
    currentInputSummary = 'Aux / line-in';
  } else if (selectedSystemMic && availableSystemMics.some((device) => device.name === selectedSystemMic)) {
    currentInputSummary = selectedSystemMic;
  } else if (selectedSystemMic) {
    currentInputSummary = `${selectedSystemMic} (unavailable) — System Default`;
  } else if (!defaultSystemMic && lastMic) {
    currentInputSummary = lastRate ? `${lastMic} @ ${lastRate} Hz` : lastMic;
  }

  const systemMicrophoneItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: defaultSystemMic
        ? `System Default — ${defaultSystemMic.name}`
        : 'System Default',
      type: 'radio',
      checked: inputSrc === 'system' && !selectedSystemMic,
      click: () => { void selectSystemInput(null); },
    },
    ...availableSystemMics.map((device): Electron.MenuItemConstructorOptions => ({
      label: device.name,
      type: 'radio',
      checked: inputSrc === 'system' && selectedSystemMic === device.name,
      click: () => { void selectSystemInput(device.name); },
    })),
  ];
  if (availableSystemMics.length === 0) {
    systemMicrophoneItems.push({ label: 'Loading audio inputs…', enabled: false });
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: statusText, enabled: false },
    { label: 'Open Memo', click: () => openMainWindow() },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Copy Last Dictation', click: () => copyLastTranscript(), enabled: !!lastTranscript },
    {
      label: 'Microphone',
      submenu: [
        {
          label: `Current: ${currentInputSummary}`,
          enabled: false,
        },
        { type: 'separator' },
        ...systemMicrophoneItems,
        { type: 'separator' },
        {
          label: 'Memo Bluetooth Device',
          type: 'radio',
          checked: (s.inputSource || 'system') === 'ble',
          click: async () => {
            const cfg = loadSettings();
            if (cfg.inputSource !== 'ble') {
              audioSourceManager?.resetUserSelection();
              cfg.inputSource = 'ble';
              saveSettings(cfg);
              
              // Restart memo-stt service with new input source
              restartMemoStt();
              
              // Connect/reconnect to BLE device if not already connected
              if (bleManager) {
                const manager = bleManager;
                const savedUid = persistentStore.get('memoUid');
                if (savedUid && !isBleConnected) {
                  // Wait a moment for the service to restart, then connect
                  setTimeout(async () => {
                    try {
                      const result = await manager.connect(savedUid);
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
            } else if (cfg.inputSource === 'ble' && !isBleConnected && bleManager) {
              // Already set to BLE but not connected - try to reconnect
              const savedUid = persistentStore.get('memoUid');
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
          label: 'Aux / Line In',
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
              restartMemoStt();
              updateMenuState();
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Refresh Audio Inputs',
          click: () => { void refreshAudioInputsFromMenu(); },
        },
      ]
    },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: () => toggleAutoStart(),
    },
    { label: 'Quit Memo', role: 'quit', accelerator: 'Command+Q' },
  ]);
  
  tray.setContextMenu(contextMenu);
  
  // Track menu open/close events to prevent rebuilding while open
  contextMenu.on('menu-will-show', () => {
    menuIsOpen = true;
  });
  
  contextMenu.on('menu-will-close', () => {
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
