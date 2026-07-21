import { EventEmitter } from 'events';
import Store from 'electron-store';
import { StoreSchema } from './StoreSchema';
import { loadSettings, saveSettings } from './SettingsService';

export type AudioSource = 'ble' | 'system';

export interface AudioSourceState {
  current: AudioSource;
  systemMicName: string | null;
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
      systemMicName: store.get('selectedSystemMicName') || null,
      isTransitioning: false,
      userSelectedSystemMic: false,
    };
  }

  /**
   * Persist a specific CoreAudio input name, or null to follow the macOS default.
   * The caller owns restarting memo-stt after any BLE disconnect has been requested.
   */
  selectSystemMic(deviceName: string | null): boolean {
    const normalizedName = deviceName?.trim().slice(0, 200) || null;
    const settings = loadSettings();
    const previousName = this.store.get('selectedSystemMicName') || null;
    const changed = settings.inputSource !== 'system' || previousName !== normalizedName;

    this.store.set('selectedSystemMicName', normalizedName);
    this.state.current = 'system';
    this.state.systemMicName = normalizedName;
    this.state.userSelectedSystemMic = true;

    if (settings.inputSource !== 'system') {
      settings.inputSource = 'system';
      saveSettings(settings);
    }

    this.emit('settingsUpdated');
    console.log(
      `[AudioSourceManager] Selected ${normalizedName || 'macOS system default'} microphone`,
    );
    return changed;
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

    const selectedMicName = this.store.get('selectedSystemMicName') || 'default';

    console.log('[AudioSourceManager] Switching to system mic:', selectedMicName, 'reason:', reason, force ? '(forced)' : '');
    this.state.isTransitioning = true;

    try {
      // Send command to Rust to switch input source
      this.emit('commandSetInputSource', 'system');

      this.state.current = 'system';
      this.state.systemMicName = selectedMicName === 'default' ? null : selectedMicName;

      // Mark if user manually selected system mic (prevents auto-switch back)
      if (reason === 'manual') {
        this.state.userSelectedSystemMic = true;
        console.log('[AudioSourceManager] User manually selected system mic');
      }

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

    // A tray selection sets this flag before intentionally disconnecting BLE.
    // Do not overwrite that explicit system-microphone choice with BLE fallback state.
    if (this.state.userSelectedSystemMic) {
      this.state.current = 'system';
      this.emit('settingsUpdated');
      console.log('[AudioSourceManager] BLE disconnected after explicit system mic selection');
      return;
    }

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
