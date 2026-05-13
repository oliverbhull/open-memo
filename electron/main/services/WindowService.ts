import { app, BrowserWindow, screen } from 'electron';
import type { Display } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let overlayWindow: BrowserWindow | null = null;
let overlayRecordingState = false; // Track last recording state to prevent unnecessary updates

/**
 * BrowserWindow size must stay above ~162px width on macOS external displays or
 * Chromium composites an opaque white backing (Electron #44884 / #38630). The
 * visible waveform stays smaller; extra area is fully transparent padding.
 */
const OVERLAY_WINDOW_WIDTH = 200;
const OVERLAY_WINDOW_HEIGHT = 48;
const OVERLAY_MARGIN = 5;

function getActiveDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function getOverlayBounds(width: number, height: number, display = getActiveDisplay()) {
  const x = display.bounds.x + Math.floor((display.bounds.width - width) / 2);
  const y = display.bounds.y + display.bounds.height - height - OVERLAY_MARGIN;

  return { width, height, x, y };
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Use destroy() so the new window can be created immediately on the
    // current display without inheriting the previous display's transparency
    // context (macOS does not reliably re-evaluate transparency on move).
    overlayWindow.destroy();
  }
  overlayWindow = null;
}

async function getPrimaryColor(mainWindow: BrowserWindow | null): Promise<string> {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      return await mainWindow.webContents.executeJavaScript(`
        localStorage.getItem('primary') || '#C26D50'
      `) || '#C26D50';
    } catch {
      return '#C26D50';
    }
  }

  return '#C26D50';
}

/**
 * Create overlay window for recording indicator
 */
export function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return; // Already exists
  }

  const activeDisplay = getActiveDisplay();

  console.log('[Overlay] Display info:', {
    displayId: activeDisplay.id,
    screenWidth: activeDisplay.bounds.width
  });

  const overlayWidth = OVERLAY_WINDOW_WIDTH;
  const overlayHeight = OVERLAY_WINDOW_HEIGHT;

  // Position at bottom center
  const { x, y } = getOverlayBounds(overlayWidth, overlayHeight, activeDisplay);

  console.log('[Overlay] Position calculated:', { x, y, margin: OVERLAY_MARGIN });

  const newOverlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    roundedCorners: false,
    focusable: false, // Prevent window from becoming active
    show: false, // Create hidden, we'll show it inactive later
    backgroundColor: '#00000000', // Transparent - will be styled by HTML
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  
  overlayWindow = newOverlayWindow;
  newOverlayWindow.setBackgroundColor('#00000000');
  newOverlayWindow.setHasShadow(false);
  
  // Add error handler to log if HTML fails to load
  newOverlayWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[Overlay] Failed to load HTML:', errorCode, errorDescription, validatedURL);
  });

  // Load the overlay HTML - try multiple paths like main window
  const baseAppPath = app.getAppPath ? app.getAppPath() : process.cwd();
  const overlayHtmlDev = path.join(baseAppPath, 'electron', 'renderer', 'overlay.html');
  const overlayHtmlPaths = [
    overlayHtmlDev,
    path.join(process.resourcesPath || '', 'app.asar', 'electron', 'renderer', 'overlay.html'),
    path.join(process.resourcesPath || '', 'electron', 'renderer', 'overlay.html'),
  ];
  
  const overlayHtmlPath = overlayHtmlPaths.find(p => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || overlayHtmlDev;
  
  console.log('[Overlay] Loading overlay HTML from:', overlayHtmlPath);
  newOverlayWindow.loadFile(overlayHtmlPath).catch(err => {
    console.error('[Overlay] Failed to load overlay HTML:', err);
    console.error('[Overlay] Tried paths:', overlayHtmlPaths);
  });

  // Explicitly prevent window from getting focus or becoming active
  newOverlayWindow.setFocusable(false);
  newOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  newOverlayWindow.setIgnoreMouseEvents(true);
  
  // Ensure window never becomes active
  newOverlayWindow.on('focus', () => {
    newOverlayWindow.blur();
  });

  newOverlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

/**
 * Update overlay window visibility based on recording state
 */
export function updateOverlayVisibility(isRecording: boolean, mainWindow: BrowserWindow | null) {
  // Only update if recording state actually changed
  if (overlayRecordingState === isRecording) {
    return; // No change, skip update
  }
  overlayRecordingState = isRecording;
  
  if (isRecording) {
    // Always recreate fresh on the active display so transparency works
    // correctly on whichever monitor the user is currently looking at.
    destroyOverlay();
    createOverlayWindow();

    const currentOverlay = overlayWindow;
    if (!currentOverlay || currentOverlay.isDestroyed()) {
      return;
    }

    currentOverlay.showInactive();
    currentOverlay.setFocusable(false);
    currentOverlay.blur();

    (async () => {
      const primaryColor = await getPrimaryColor(mainWindow);

      if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) {
        return;
      }

      try {
        overlayWindow.webContents.send('memo:status', {
          isRecording: true,
          isProcessing: false,
          primaryColor,
        });
      } catch (e) {
        console.warn('[Overlay] Failed to send status:', e);
      }
    })();
  } else {
    destroyOverlay();
  }
}

/**
 * Send audio levels to overlay window
 */
export function sendAudioLevels(levels: number[]) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.webContents && !overlayWindow.webContents.isDestroyed()) {
    try {
      overlayWindow.webContents.send('memo:audioLevels', levels);
    } catch (e) {
      // Silently ignore errors
    }
  }
}

/**
 * Show a short submit/checkmark animation after BLE double-click Enter.
 */
export function sendSubmitAcceptedToOverlay() {
  destroyOverlay();
  createOverlayWindow();

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.showInactive();
  overlayWindow.setFocusable(false);
  overlayWindow.blur();

  if (overlayWindow.webContents && !overlayWindow.webContents.isDestroyed()) {
    try {
      overlayWindow.webContents.send('memo:submitAccepted');
    } catch (e) {
      // Silently ignore errors
    }
  }
}

/**
 * Send status update to overlay window
 */
export function sendStatusToOverlay(isRecording: boolean, mainWindow: BrowserWindow | null) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.webContents && !overlayWindow.webContents.isDestroyed()) {
    (async () => {
      const primaryColor = await getPrimaryColor(mainWindow);
      
      try {
        overlayWindow!.webContents.send('memo:status', { 
          isRecording: isRecording,
          isProcessing: false,
          primaryColor: primaryColor
        });
      } catch (e) {
        console.warn('[Overlay] Failed to send status:', e);
      }
    })();
  }
}

/**
 * Show a command-executed toast in the overlay, then auto-destroy.
 * The overlay is created fresh if it was already torn down after recording stopped.
 * The waveform is hidden on the HTML side the moment the toast IPC arrives.
 */
const TOAST_DISPLAY_MS = 1800; // how long the toast is visible before fade-out begins
const TOAST_FADEOUT_MS = 350;  // must match CSS fade-out transition in overlay.html

export function sendCommandToOverlay(label: string, mainWindow: BrowserWindow | null) {
  // Always start from a fresh window so we land on the correct display.
  destroyOverlay();
  createOverlayWindow();

  const win = overlayWindow;
  if (!win || win.isDestroyed()) return;

  win.showInactive();
  win.setFocusable(false);
  win.blur();

  const sendToast = async () => {
    const primaryColor = await getPrimaryColor(mainWindow);
    if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) return;
    try {
      overlayWindow.webContents.send('memo:commandToast', { label, primaryColor });
    } catch (e) {
      console.warn('[Overlay] Failed to send command toast:', e);
    }

    // Destroy after animation completes
    setTimeout(() => destroyOverlay(), TOAST_DISPLAY_MS + TOAST_FADEOUT_MS + 100);
  };

  // Give the window a tick to finish loading before sending IPC
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => sendToast());
  } else {
    sendToast();
  }
}

/**
 * Get overlay window (for external use)
 */
export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

