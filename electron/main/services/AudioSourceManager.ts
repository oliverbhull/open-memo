import { EventEmitter } from 'events';
import Store from 'electron-store';
import { StoreSchema } from './StoreSchema';
import { loadSettings, saveSettings } from './SettingsService';

export type AudioSource = 'ble' | 'system';

export interface AudioSourceState {
  current: AudioSource;
  preferred: AudioSource;
  systemMicId: string | null;
  isTransitioning: boolean;
  userSelectedSystemMic: boolean; // Prevents auto-switch back to BLE
}

export class AudioSourceManager extends EventEmitter {
  private state: AudioSourceState;
  private store: Store<StoreSchema>;

  constructor(store: Store<StoreSchema>) {
    super();
    this.store = store;

    // Initialize state
    this.state = {
      current: 'system', // Always start with system mic
      preferred: 'ble',
      systemMicId: store.get('fallbackMicId') || null,
      isTransitioning: false,
      userSelectedSystemMic: false,
    };
  }

  /**
   * Get current audio source state
   */
  getState(): AudioSourceState {
    return { ...this.state };
  }

  /**
   * Get current audio source
   */
  getCurrentSource(): AudioSource {
    return this.state.current;
  }

  /**
   * Switch to BLE audio source
   */
  async switchToBle(deviceName: string): Promise<void> {
    if (this.state.current === 'ble') {
      console.log('[AudioSourceManager] Already using BLE source');
      return;
    }

    console.log('[AudioSourceManager] Switching to BLE:', deviceName);
    this.state.isTransitioning = true;

    try {
      // Send command to Rust to switch input source
      this.emit('commandSetInputSource', 'ble');

      // Wait for confirmation (handled by caller)
      // For now, assume immediate switch

      this.state.current = 'ble';
      this.state.userSelectedSystemMic = false;
      this.emit('sourceChanged', 'ble');

      console.log('[AudioSourceManager] Switched to BLE successfully');
    } catch (error) {
      console.error('[AudioSourceManager] Failed to switch to BLE:', error);
      throw error;
    } finally {
      this.state.isTransitioning = false;
    }
  }

  /**
   * Switch to system microphone
   */
  async switchToSystemMic(reason: 'disconnect' | 'manual', force: boolean = false): Promise<void> {
    // When BLE disconnects, always force the switch to ensure the command is sent
    // even if state thinks we're already using system mic (state might be out of sync)
    if (!force && this.state.current === 'system' && !this.state.isTransitioning) {
      console.log('[AudioSourceManager] Already using system mic');
      return;
    }

    const fallbackMicId = this.store.get('fallbackMicId') ||
                          this.store.get('lastUsedMicId') ||
                          'default';

    console.log('[AudioSourceManager] Switching to system mic:', fallbackMicId, 'reason:', reason, force ? '(forced)' : '');
    this.state.isTransitioning = true;

    try {
      // Send command to Rust to switch input source
      this.emit('commandSetInputSource', 'system', fallbackMicId);

      this.state.current = 'system';
      this.state.systemMicId = fallbackMicId;

      // Mark if user manually selected system mic (prevents auto-switch back)
      if (reason === 'manual') {
        this.state.userSelectedSystemMic = true;
        console.log('[AudioSourceManager] User manually selected system mic');
      }

      this.emit('sourceChanged', 'system');

      // Update settings file when switching to system mic (especially on disconnect)
      // This ensures the tray menu and UI reflect the correct state
      if (reason === 'disconnect') {
        try {
          const settings = loadSettings();
          if (settings.inputSource !== 'system') {
            settings.inputSource = 'system';
            saveSettings(settings);
            console.log('[AudioSourceManager] Updated settings to use system mic');
          }
        } catch (error) {
          console.error('[AudioSourceManager] Failed to update settings:', error);
        }
        
        this.emit('fallbackToast', {
          message: 'BLE disconnected, using system mic',
          severity: 'warning',
          duration: 3000,
        });
      }

      console.log('[AudioSourceManager] Switched to system mic successfully');
    } catch (error) {
      console.error('[AudioSourceManager] Failed to switch to system mic:', error);
      throw error;
    } finally {
      this.state.isTransitioning = false;
    }
  }

  /**
   * Handle BLE disconnect.
   * Keep BLE as the selected input source while we attempt to reconnect.
   * Fallback to system mic is handled only after reconnect attempts are exhausted.
   */
  async handleBleDisconnect(): Promise<void> {
    console.log('[AudioSourceManager] Handling BLE disconnect');

    // IMPORTANT: Do NOT switch to system mic here. If we switch inputSource to 'system',
    // memo-stt will run in system mode and BLE reconnect attempts (CONNECT_UID) won't work.
    try {
      const settings = loadSettings();
      if (settings.inputSource !== 'ble') {
        settings.inputSource = 'ble';
        saveSettings(settings);
        console.log('[AudioSourceManager] Updated settings to keep BLE as selected input source');
      }
    } catch (error) {
      console.error('[AudioSourceManager] Failed to update settings:', error);
    }
    
    // Update internal state
    this.state.current = 'ble';
    this.state.userSelectedSystemMic = false;

    // Emit dedicated BLE-disconnect event so main can force BleManager + tray to disconnected
    // before restart (ensures tray shows disconnected even if bleDisconnected was never emitted)
    this.emit('bleDisconnectRestartRequested');

    // Emit source changed event
    this.emit('sourceChanged', 'ble');
    
    // Emit settings updated event so UI can refresh
    this.emit('settingsUpdated');
    
    // Show toast notification
    this.emit('fallbackToast', {
      message: 'Bluetooth disconnected, attempting to reconnect…',
      severity: 'warning',
      duration: 3000,
    });
    
    console.log('[AudioSourceManager] BLE disconnect handled, restart requested');
  }

  /**
   * Handle BLE reconnect - auto-switch back if appropriate
   */
  async handleBleReconnect(deviceName: string): Promise<void> {
    console.log('[AudioSourceManager] Handling BLE reconnect:', deviceName);

    if (this.shouldAutoSwitchToBle()) {
      await this.switchToBle(deviceName);

      // Show success toast
      this.emit('fallbackToast', {
        message: 'Memo connected',
        severity: 'success',
        duration: 2000,
      });
    } else {
      console.log('[AudioSourceManager] Not auto-switching (user selected system mic)');
    }
  }

  /**
   * Check if we should auto-switch back to BLE
   */
  shouldAutoSwitchToBle(): boolean {
    const preferBle = this.store.get('preferBleWhenAvailable', true);
    const notManuallySelected = !this.state.userSelectedSystemMic;

    return preferBle && notManuallySelected;
  }

  /**
   * Set fallback microphone ID (browser deviceId) and optional label substring for CoreAudio matching.
   */
  setFallbackMic(micId: string, label?: string | null): void {
    this.store.set('fallbackMicId', micId);
    this.state.systemMicId = micId;
    if (label !== undefined) {
      const t = label && String(label).trim() ? String(label).trim() : null;
      this.store.set('fallbackMicLabel', t);
    }
    console.log('[AudioSourceManager] Set fallback mic:', micId, label ?? '(label unchanged)');
  }

  /**
   * Reset user selection flag (for next session)
   */
  resetUserSelection(): void {
    this.state.userSelectedSystemMic = false;
    console.log('[AudioSourceManager] Reset user selection flag');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.removeAllListeners();
  }
}
