export interface StoreSchema {
  // BLE Configuration
  memoUid: string | null;
  preferBleWhenAvailable: boolean;
  autoReconnect: boolean;

  // Audio Configuration
  fallbackMicId: string | null;
  /** Substring matched against CoreAudio device name (e.g. "AirPods") — passed to memo-stt as MEMO_SYSTEM_INPUT_DEVICE */
  fallbackMicLabel: string | null;
  lastUsedMicId: string | null;
  /** Last system input device reported by memo-stt (MIC_INFO) — for tray display */
  lastSystemMicDevice: string | null;
  lastSystemMicSampleRate: number | null;
  /** When true, mute macOS default audio output while dictating (all apps; macOS) */
  pauseMediaWhileRecording: boolean;

  // Legacy settings (preserved during migration)
  postEnter?: boolean;
  inputSource?: 'system' | 'ble' | 'radio';
  autoConnectDeviceName?: string;
  voiceCommands?: {
    enabled: boolean;
    apps: any[];
    globalCommands?: any[];
    urlPatterns?: string[];
  };
}

export const storeDefaults: StoreSchema = {
  memoUid: null,
  preferBleWhenAvailable: true,
  autoReconnect: true,
  fallbackMicId: null,
  fallbackMicLabel: null,
  lastUsedMicId: null,
  lastSystemMicDevice: null,
  lastSystemMicSampleRate: null,
  pauseMediaWhileRecording: true,
};

export interface BleStateData {
  state: BleState;
  memoUid: string | null;
  connectedDeviceName: string | null;
  reconnectAttempts: number;
  lastConnectionTime: number | null;
  errorMessage: string | null;
}

export type BleState = 'idle' | 'scanning' | 'connected' | 'fallback';

export interface BleDevice {
  name: string;
  uid: string;
  rssi: number;
}

export interface ToastData {
  message: string;
  severity: 'success' | 'warning' | 'error' | 'info';
  duration: number;
}
