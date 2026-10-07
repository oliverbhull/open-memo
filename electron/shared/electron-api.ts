import type { MemoEntry } from './memo-entry';
import type { RecordingHotkeyCapture } from './recordingHotkey';

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
  /** Main has already saved this entry; renderer errors must not delete its audio. */
  persisted?: boolean;
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

export interface DictationReadiness {
  hotkey: boolean;
  microphone: boolean;
  model: boolean;
  ready: boolean;
  microphoneName?: string;
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
  transport?: 'usb' | 'ble';
  endpoint?: string;
  pendingOnDevice?: number;
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

export type AsrModelId = 'conomo';

export type WritingMode = 'as-spoken' | 'clean';

export interface CleanupState {
  available: boolean;
  installed?: boolean;
  status: 'disabled' | 'not-downloaded' | 'downloading' | 'loading' | 'ready' | 'unavailable';
  detail?: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface MicrophoneInputDevice {
  name: string;
  isDefault: boolean;
}

export interface MicrophoneInputState {
  selectedDeviceName: string | null;
  defaultDeviceName: string | null;
  devices: MicrophoneInputDevice[];
}

export interface ElectronAPI {
  onTranscription(callback: (data: TranscriptionData) => void): void;
  removeTranscriptionListener(): void;
  listUsbTranscripts(): Promise<TranscriptionData[]>;
  entries: {
    initialize(): Promise<{ legacyImportComplete: boolean }>;
    importLegacy(entries: MemoEntry[]): Promise<{ imported: number }>;
    save(entry: MemoEntry): Promise<void>;
    get(id: string): Promise<MemoEntry | null>;
    list(limit: number, offset: number): Promise<MemoEntry[]>;
    getAllActive(): Promise<MemoEntry[]>;
    getTotalWordCount(): Promise<number>;
  };
  deviceSync: {
    getStatus(): Promise<DeviceSyncStatus>;
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
  openMicrophonePreferences(): Promise<void>;
  checkInputMonitoringPermission(): Promise<boolean>;
  requestInputMonitoringPermission(): Promise<boolean>;
  openInputMonitoringPreferences(): Promise<void>;
  checkAccessibilityPermission(): Promise<boolean>;
  requestAccessibilityPermission(): Promise<boolean>;
  openSystemPreferences(): Promise<void>;
  openAutomationPreferences(): Promise<void>;
  restartApp(): Promise<void>;
  startMemoSttService(): Promise<DictationReadiness>;
  saveUserName(name: string): Promise<void>;
  getUserName(): Promise<string | null>;
  isUserOnboarded(userName: string): Promise<boolean>;
  markUserOnboarded(userName: string): Promise<void>;
  interface: {
    getSettings(): Promise<{
      hotkey: string;
      lockHotkey: string;
      sayEnterToPressEnter: boolean;
      handsFreeMode: boolean;
      saveAudio: boolean;
      writingMode: WritingMode;
      experimentalEmailFormatting: boolean;
      cleanupState: CleanupState;
      vocabWords: string[];
      phraseReplacements: PhraseReplacementRule[];
      startAtLogin: boolean;
    }>;
    setVocabWords(vocabWords: string[]): Promise<boolean>;
    setPhraseReplacements(rules: PhraseReplacementRule[]): Promise<boolean>;
    setSayEnterToPressEnter(enabled: boolean): Promise<boolean>;
    setHandsFreeMode(enabled: boolean): Promise<boolean>;
    setRecordingHotkey(hotkey: string): Promise<string>;
    setRecordingLockHotkey(hotkey: string): Promise<string>;
    beginHotkeyCapture(): Promise<void>;
    endHotkeyCapture(): Promise<void>;
    onHotkeyCapture(callback: (capture: RecordingHotkeyCapture) => void): () => void;
    setSaveAudio(enabled: boolean): Promise<boolean>;
    setExperimentalEmailFormatting(enabled: boolean): Promise<boolean>;
    setWritingMode(mode: WritingMode): Promise<boolean>;
    removeCleaned(): Promise<{ writingMode: WritingMode; cleanupState: CleanupState }>;
    setStartAtLogin(enabled: boolean): Promise<boolean>;
    onCleanupStateChanged(callback: (state: CleanupState) => void): () => void;
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
