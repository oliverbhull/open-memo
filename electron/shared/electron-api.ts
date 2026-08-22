export interface AppContext {
  appName: string;
  windowTitle: string;
  bundleId?: string;
}

export interface AudioAttachment {
  fileName: string;
  mimeType: 'audio/wav';
  duration?: number;
}

export interface TranscriptionExportEntry {
  id: string;
  text: string;
  createdAt: number;
  createdAtIso: string;
  updatedAt: number;
  updatedAtIso: string;
  context: Record<string, unknown>;
}

export interface TranscriptionExportDocument {
  format: 'open-memo-transcriptions';
  version: 1;
  exportedAt: string;
  range: { from: string | null; to: string | null };
  count: number;
  transcriptions: TranscriptionExportEntry[];
}

export interface TranscriptionData {
  id?: string;
  rawTranscript?: string;
  processedText?: string;
  wasProcessedByLLM?: boolean;
  timestamp?: number;
  appContext?: AppContext;
  audio?: AudioAttachment;
  context?: Record<string, unknown>;
}

export interface MemoSttError {
  message: string;
  name: string;
}

export interface PhraseReplacementRule {
  id: string;
  find: string;
  replace: string;
  enabled?: boolean;
}

export type DeviceSyncState =
  | 'disconnected'
  | 'connected'
  | 'transferring'
  | 'transcribing'
  | 'verifying'
  | 'complete'
  | 'checking-update'
  | 'updating-firmware'
  | 'firmware-updated'
  | 'update-error'
  | 'error';

export interface DeviceSyncStatus {
  state: DeviceSyncState;
  completed: number;
  total: number;
  batchId?: string;
  deviceUid?: string;
  firmwareVersion?: string;
  targetFirmwareVersion?: string;
  protocolVersion?: number;
  port?: string;
  requestedModel?: AsrModelId;
  actualModel?: AsrModelId;
  error?: string;
  code?: string;
}

export interface ToastData {
  message: string;
  severity: 'success' | 'warning' | 'error' | 'info';
  duration: number;
}

export type AsrModelId = 'nemotron' | 'whisper';

export type AsrModelInstallState =
  | 'included'
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface AsrModelStatus {
  id: AsrModelId;
  name: string;
  installState: AsrModelInstallState;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface AsrState {
  selectedModel: AsrModelId;
  models: Record<AsrModelId, AsrModelStatus>;
}

export interface AsrSelectionResult {
  success: boolean;
  state: AsrState;
  error?: string;
}

export interface MicrophoneInputDevice {
  name: string;
  isDefault: boolean;
}

export interface MicrophoneInputState {
  inputSource: 'system' | 'ble' | 'radio';
  selectedDeviceName: string | null;
  defaultDeviceName: string | null;
  devices: MicrophoneInputDevice[];
}

export interface ElectronAPI {
  onTranscription(callback: (data: TranscriptionData) => void): void;
  removeTranscriptionListener(): void;
  listUsbTranscripts(): Promise<TranscriptionData[]>;
  deviceSync: {
    getStatus(): Promise<DeviceSyncStatus>;
    openRecordingsFolder(): Promise<{ success: boolean; error?: string }>;
    onStatus(callback: (status: DeviceSyncStatus) => void): () => void;
  };
  onStatus(callback: (status: string) => void): void;
  removeStatusListener(): void;
  onError(callback: (error: MemoSttError) => void): void;
  removeErrorListener(): void;
  getStatus(): Promise<string>;
  restart(): Promise<void>;
  checkMicrophonePermission(): Promise<boolean>;
  requestMicrophonePermission(): Promise<boolean>;
  checkInputMonitoringPermission(): Promise<boolean>;
  openInputMonitoringPreferences(): Promise<void>;
  checkAccessibilityPermission(): Promise<boolean>;
  openSystemPreferences(): Promise<void>;
  restartApp(): Promise<void>;
  startMemoSttService(): Promise<void>;
  saveUserName(name: string): Promise<void>;
  getUserName(): Promise<string | null>;
  isUserOnboarded(userName: string): Promise<boolean>;
  markUserOnboarded(userName: string): Promise<void>;
  interface: {
    getSettings(): Promise<{
      sayEnterToPressEnter: boolean;
      handsFreeMode: boolean;
      saveAudio: boolean;
      vocabWords: string[];
      phraseReplacements: PhraseReplacementRule[];
      startAtLogin: boolean;
    }>;
    setVocabWords(vocabWords: string[]): Promise<boolean>;
    setPhraseReplacements(rules: PhraseReplacementRule[]): Promise<boolean>;
    setSayEnterToPressEnter(enabled: boolean): Promise<boolean>;
    setHandsFreeMode(enabled: boolean): Promise<boolean>;
    setSaveAudio(enabled: boolean): Promise<boolean>;
    setStartAtLogin(enabled: boolean): Promise<boolean>;
  };
  asr: {
    getState(): Promise<AsrState>;
    selectModel(model: AsrModelId): Promise<AsrSelectionResult>;
    onStateChanged(callback: (state: AsrState) => void): () => void;
  };
  microphone: {
    getState(): Promise<MicrophoneInputState>;
    selectSystemInput(deviceName: string | null): Promise<MicrophoneInputState>;
    onStateChanged(callback: (state: MicrophoneInputState) => void): () => void;
  };
  audio: {
    get(entryId: string): Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
    delete(entryId: string): Promise<{ success: boolean; error?: string }>;
    openFolder(): Promise<{ success: boolean; error?: string }>;
  };
  appIcons: {
    get(appName: string, bundleId?: string): Promise<string | null>;
  };
  onOpenSettings(callback: () => void): () => void;
  exportJson(document: TranscriptionExportDocument): Promise<{
    success: boolean;
    canceled?: boolean;
    error?: string;
  }>;
  audioSource: {
    onShowToast(callback: (toast: ToastData) => void): () => void;
    notifyInputDeviceChanged(): Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
