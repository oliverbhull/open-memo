import { EventEmitter } from 'events';
import Store from 'electron-store';
import { BleState, BleStateData, BleDevice, StoreSchema } from './StoreSchema';

export class BleStateManager extends EventEmitter {
  private state: BleStateData;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private store: Store<StoreSchema>;

  // Reconnection backoff config
  private readonly BACKOFF_DELAYS = [2000, 5000, 10000, 30000]; // ms: 2s → 5s → 10s → 30s
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly SCAN_TIMEOUT_MS = 10000; // 10 seconds

  constructor(store: Store<StoreSchema>) {
    super();
    this.store = store;

    // Initialize state
    this.state = {
      state: 'idle',
      memoUid: null,
      connectedDeviceName: null,
      reconnectAttempts: 0,
      lastConnectionTime: null,
      errorMessage: null,
    };
  }

  /**
   * Initialize the state manager and auto-start scanning if UID is saved
   */
  async initialize(): Promise<void> {
    const memoUid = this.store.get('memoUid');
    const autoReconnect = this.store.get('autoReconnect', true);

    console.log('[BleStateManager] Initializing with UID:', memoUid, 'autoReconnect:', autoReconnect);

    if (memoUid && autoReconnect) {
      // Load UID and start scanning in background
      this.state.memoUid = memoUid;
      await this.transition('scanning');
    } else {
      await this.transition('idle');
    }
  }

  /**
   * Get current state
   */
  getState(): BleStateData {
    return { ...this.state };
  }

  /**
   * Set memo UID and start scanning
   */
  async setMemoUid(uid: string): Promise<void> {
    // Validate UID format (5-char hex)
    if (!/^[0-9A-Fa-f]{5}$/.test(uid)) {
      throw new Error('Invalid UID format (expected 5-character hex code)');
    }

    const normalizedUid = uid.toUpperCase();
    console.log('[BleStateManager] Setting UID:', normalizedUid);

    // Save to store immediately
    this.store.set('memoUid', normalizedUid);
    this.state.memoUid = normalizedUid;
    this.state.errorMessage = null;

    // Start scanning
    await this.transition('scanning');
  }

  /**
   * Clear memo UID and stop all BLE operations
   */
  async clearMemoUid(): Promise<void> {
    console.log('[BleStateManager] Clearing UID');

    // Clear from store
    this.store.set('memoUid', null);
    this.state.memoUid = null;

    // Stop any ongoing operations
    this.stopScan();
    this.cancelReconnect();

    // Disconnect if connected
    if (this.state.state === 'connected') {
      this.emit('commandDisconnect');
    }

    // Transition to idle
    await this.transition('idle');
  }

  /**
   * Manual reconnect (resets backoff counter)
   */
  async reconnect(): Promise<void> {
    console.log('[BleStateManager] Manual reconnect triggered');
    this.resetReconnectBackoff();
    await this.transition('scanning');
  }

  /**
   * Disconnect from device
   */
  async disconnect(): Promise<void> {
    console.log('[BleStateManager] Manual disconnect');

    // Send disconnect command
    this.emit('commandDisconnect');

    // Cancel reconnection
    this.cancelReconnect();

    // Transition to fallback
    await this.transition('fallback');
  }

  /**
   * Handle device discovered during scan
   */
  handleDeviceDiscovered(device: BleDevice): void {
    console.log('[BleStateManager] Device discovered:', device);

    // Emit for UI
    this.emit('deviceDiscovered', device);

    // Check if this is the device we're looking for
    if (this.state.memoUid && device.uid.toUpperCase() === this.state.memoUid.toUpperCase()) {
      console.log('[BleStateManager] Found target device, initiating connection');
      this.initiateConnection(device.name);
    }
  }

  /**
   * Handle connection established
   */
  async handleConnectionEstablished(deviceName: string): Promise<void> {
    console.log('[BleStateManager] Connection established:', deviceName);

    this.state.connectedDeviceName = deviceName;
    this.state.lastConnectionTime = Date.now();
    this.resetReconnectBackoff();

    await this.transition('connected');
    this.emit('connectionEstablished', deviceName);
  }

  /**
   * Handle disconnection
   */
  async handleDisconnect(reason: 'expected' | 'unexpected'): Promise<void> {
    console.log('[BleStateManager] Disconnect:', reason);

    const previouslyConnectedDevice = this.state.connectedDeviceName;
    this.state.connectedDeviceName = null;

    this.emit('connectionLost', reason);

    if (reason === 'unexpected' && this.store.get('autoReconnect', true)) {
      console.log('[BleStateManager] Unexpected disconnect, will attempt reconnection');
      await this.transition('fallback');
      this.scheduleReconnect();
    } else {
      await this.transition('fallback');
    }
  }

  /**
   * Handle scan complete (timeout or manual stop)
   */
  handleScanComplete(): void {
    console.log('[BleStateManager] Scan complete, no device found');

    if (this.state.state === 'scanning') {
      // No device found, transition to fallback
      this.transition('fallback').then(() => {
        // Schedule reconnect if autoReconnect is enabled
        if (this.store.get('autoReconnect', true)) {
          this.scheduleReconnect();
        }
      });
    }
  }

  /**
   * State machine transition
   */
  private async transition(newState: BleState, data?: Partial<BleStateData>): Promise<void> {
    const oldState = this.state.state;

    // Validate transition
    if (!this.isValidTransition(oldState, newState)) {
      console.warn(`[BleStateManager] Invalid transition: ${oldState} -> ${newState}`);
      return;
    }

    console.log(`[BleStateManager] State transition: ${oldState} -> ${newState}`);

    // Update state
    this.state.state = newState;
    if (data) {
      Object.assign(this.state, data);
    }

    // Execute state entry actions
    switch (newState) {
      case 'idle':
        this.stopScan();
        this.cancelReconnect();
        break;

      case 'scanning':
        await this.startScan();
        break;

      case 'connected':
        this.stopScan();
        this.cancelReconnect();
        break;

      case 'fallback':
        this.stopScan();
        break;
    }

    // Emit state change event
    this.emit('stateChanged', this.state.state, { ...this.state });
  }

  /**
   * Check if state transition is valid
   */
  private isValidTransition(from: BleState, to: BleState): boolean {
    const validTransitions: Record<BleState, BleState[]> = {
      idle: ['scanning'],
      scanning: ['connected', 'fallback', 'idle'],
      connected: ['fallback', 'idle'],
      fallback: ['scanning', 'idle'],
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  /**
   * Start BLE scan
   */
  private async startScan(): Promise<void> {
    if (!this.state.memoUid) {
      console.error('[BleStateManager] Cannot start scan without UID');
      return;
    }

    console.log('[BleStateManager] Starting scan for UID:', this.state.memoUid);

    // Clear any existing scan timer
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }

    // Send scan command to Rust
    this.emit('commandScanStart', this.state.memoUid);

    // Set scan timeout
    this.scanTimer = setTimeout(() => {
      console.log('[BleStateManager] Scan timeout reached');
      this.handleScanComplete();
    }, this.SCAN_TIMEOUT_MS);
  }

  /**
   * Stop BLE scan
   */
  private stopScan(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;

      // Send stop scan command to Rust
      this.emit('commandScanStop');
    }
  }

  /**
   * Initiate connection to device
   */
  private initiateConnection(deviceName: string): void {
    console.log('[BleStateManager] Initiating connection to:', deviceName);

    // Stop scanning
    this.stopScan();

    // Send connect command to Rust
    this.emit('commandConnect', deviceName);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    // Cancel any existing timer
    this.cancelReconnect();

    // Calculate delay with exponential backoff
    const delayIndex = Math.min(this.state.reconnectAttempts, this.BACKOFF_DELAYS.length - 1);
    const delay = this.BACKOFF_DELAYS[delayIndex];

    console.log(
      `[BleStateManager] Scheduling reconnect attempt ${this.state.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
    );

    this.emit('reconnectScheduled', this.state.reconnectAttempts + 1, delay);

    // Schedule reconnection
    this.reconnectTimer = setTimeout(() => {
      this.state.reconnectAttempts++;

      // Check if we've hit the max attempts
      if (this.state.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        console.warn('[BleStateManager] Max reconnect attempts reached');
        this.state.errorMessage = 'Connection attempts failed. Device may be out of range.';
        this.emit('maxReconnectAttemptsReached');
      }

      // Transition to scanning
      this.transition('scanning');
    }, delay);
  }

  /**
   * Cancel scheduled reconnection
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      console.log('[BleStateManager] Cancelled reconnect timer');
    }
  }

  /**
   * Reset reconnect backoff counter
   */
  private resetReconnectBackoff(): void {
    this.state.reconnectAttempts = 0;
    this.state.errorMessage = null;
    console.log('[BleStateManager] Reset reconnect backoff');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopScan();
    this.cancelReconnect();
    this.removeAllListeners();
  }
}
