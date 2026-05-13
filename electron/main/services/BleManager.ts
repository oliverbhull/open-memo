import { EventEmitter } from 'events';
import { MemoSttService } from './MemoSttService';
import Store from 'electron-store';
import { StoreSchema } from './StoreSchema';

/**
 * BLE Manager with optional auto-reconnect on disconnect.
 * - Connect by UID, disconnect, getState, setDisconnected
 * - When autoReconnect is enabled and we have a saved UID, schedules reconnect
 *   attempts with backoff after disconnect (e.g. user leaves range and returns).
 */
export class BleManager extends EventEmitter {
  private state = {
    connected: false,
    deviceUid: null as string | null,
    deviceName: null as string | null,
    batteryLevel: null as number | null,
  };

  private memoSttService: MemoSttService | null = null;
  private store: Store<StoreSchema>;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private userRequestedDisconnect = false;
  private readonly BACKOFF_DELAYS = [2000, 5000, 10000, 30000]; // ms
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(store: Store<StoreSchema>) {
    super();
    this.store = store;
    
    // Load saved UID from store
    const savedUid = this.store.get('memoUid');
    if (savedUid) {
      this.state.deviceUid = savedUid;
    }
  }

  setMemoSttService(service: MemoSttService) {
    this.memoSttService = service;
    this.setupListeners();
  }

  /**
   * Connect to device by UID
   * Returns immediately - connection happens async
   */
  async connect(uid: string): Promise<{ success: boolean; error?: string }> {
    // Validate UID format
    if (!/^[0-9A-Fa-f]{5}$/.test(uid)) {
      return { success: false, error: 'Invalid UID format (must be 5 hex digits)' };
    }

    if (!this.memoSttService) {
      return { success: false, error: 'Service not available' };
    }

    const normalizedUid = uid.toUpperCase();
    const isDevAutoConnectUid =
      process.env.MEMO_DEV_AUTO_CONNECT_UID?.trim().toUpperCase() === normalizedUid;
    
    // If already connected to the same device, do nothing
    if (this.state.connected && this.state.deviceUid === normalizedUid) {
      console.log(`[BleManager] Already connected to ${normalizedUid}`);
      return { success: true };
    }
    
    // Ensure memo-stt process is running before attempting connection
    const status = this.memoSttService.getStatus();
    if (status === 'stopped' || status === 'error') {
      console.log(`[BleManager] memo-stt process is ${status}, starting it...`);
      this.memoSttService.start();
      // Wait a moment for the process to start before sending the connect command
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Store UID
    this.state.deviceUid = normalizedUid;
    if (!isDevAutoConnectUid) {
      this.store.set('memoUid', normalizedUid);
    }
    
    // Send connect command to Rust
    this.memoSttService.sendCommand(`CONNECT_UID:${normalizedUid}`);
    
    return { success: true };
  }

  /**
   * Disconnect from device (user-initiated; does not schedule auto-reconnect).
   */
  async disconnect(): Promise<{ success: boolean }> {
    if (!this.memoSttService) {
      return { success: false };
    }

    this.userRequestedDisconnect = true;
    this.cancelReconnect();
    this.memoSttService.sendCommand('DISCONNECT');
    this.setState({ connected: false, deviceName: null, batteryLevel: null });

    return { success: true };
  }

  /**
   * Get current connection state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Force state to disconnected and optionally start reconnect loop (e.g. when BLE-disconnect
   * restart path runs and we need to ensure tray/UI show disconnected even if bleDisconnected
   * was never emitted). Schedules reconnect if autoReconnect and deviceUid are set.
   */
  setDisconnectedAndMaybeScheduleReconnect(): void {
    this.setState({ connected: false, deviceName: null, batteryLevel: null });
    this.userRequestedDisconnect = false;
    const autoReconnect = this.store.get('autoReconnect', true);
    const uid = this.state.deviceUid;
    if (autoReconnect && uid && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.scheduleReconnect();
    }
  }

  /**
   * Clear saved device (UID) from state and store. Disconnects if currently connected.
   * Cancels any scheduled reconnect.
   */
  async clearSavedDevice(): Promise<{ success: boolean }> {
    this.userRequestedDisconnect = true;
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    if (this.memoSttService && this.state.connected) {
      this.memoSttService.sendCommand('DISCONNECT');
    }
    this.store.set('memoUid', null);
    this.setState({ connected: false, deviceUid: null, deviceName: null, batteryLevel: null });
    return { success: true };
  }

  // PRIVATE

  private setState(updates: Partial<typeof this.state>) {
    const oldState = { ...this.state };
    Object.assign(this.state, updates);
    
    // Always emit stateChanged - let listeners decide if they care about the change
    // This ensures UI always reflects current state
    console.log(`[BleManager] State updated:`, {
      old: oldState,
      new: this.getState(),
    });
    this.emit('stateChanged', this.getState());
  }

  private setupListeners() {
    if (!this.memoSttService) return;

    // Listen to Rust connection events
    this.memoSttService.on('bleConnected', (deviceName?: string) => {
      console.log(`[BleManager] Received bleConnected event with deviceName: ${deviceName}`);

      this.cancelReconnect();
      this.reconnectAttempts = 0;
      this.userRequestedDisconnect = false;

      // Extract UID from device name (format: memo_XXXXX)
      let deviceUid = this.state.deviceUid; // Keep existing UID
      if (deviceName && deviceName.startsWith('memo_')) {
        const uid = deviceName.slice(5).toUpperCase(); // Extract XXXXX from memo_XXXXX
        if (/^[0-9A-F]{5}$/.test(uid)) {
          deviceUid = uid;
          this.state.deviceUid = uid;
          if (process.env.MEMO_DEV_AUTO_CONNECT_UID?.trim().toUpperCase() !== uid) {
            this.store.set('memoUid', uid);
          }
        }
      }

      const newState = {
        connected: true,
        deviceUid: deviceUid,
        deviceName: deviceName || null,
      };
      console.log('[BleManager] Setting state to connected:', newState);
      this.setState(newState);
    });

    this.memoSttService.on('bleDisconnected', () => {
      console.log('[BleManager] Received bleDisconnected event');
      const wasUserRequested = this.userRequestedDisconnect;
      this.userRequestedDisconnect = false;

      this.setState({
        connected: false,
        deviceName: null,
        batteryLevel: null,
      });
      // Keep deviceUid for potential reconnection

      if (wasUserRequested) return;

      const autoReconnect = this.store.get('autoReconnect', true);
      const uid = this.state.deviceUid;
      if (autoReconnect && uid && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        this.scheduleReconnect();
      } else if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        console.log('[BleManager] Max reconnect attempts reached, not scheduling');
        this.emit('maxReconnectAttemptsReached');
      }
    });

    this.memoSttService.on('batteryLevelChanged', (batteryLevel: number) => {
      this.setState({ batteryLevel });
    });
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      console.log('[BleManager] Cancelled reconnect timer');
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    const uid = this.state.deviceUid;
    if (!uid) return;

    const delayIndex = Math.min(this.reconnectAttempts, this.BACKOFF_DELAYS.length - 1);
    const delay = this.BACKOFF_DELAYS[delayIndex];
    const attempt = this.reconnectAttempts + 1;

    console.log(
      `[BleManager] Scheduling reconnect attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
    );
    this.emit('reconnectScheduled', attempt, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      console.log(`[BleManager] Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`);
      this.connect(uid).catch((err) => {
        console.warn('[BleManager] Reconnect connect() failed:', err);
      });
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        this.scheduleReconnect();
      } else {
        console.log('[BleManager] Max reconnect attempts reached');
        this.emit('maxReconnectAttemptsReached');
      }
    }, delay);
  }
}
