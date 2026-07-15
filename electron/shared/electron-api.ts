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

export interface TranscriptionData {
  id?: string;
  rawTranscript?: string;
  processedText?: string;
  wasProcessedByLLM?: boolean;
  timestamp?: number;
  appContext?: AppContext;
  audio?: AudioAttachment;
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

export type CommandAction =
  | { type: 'applescript'; script: string }
  | { type: 'keystroke'; keys: string }
  | { type: 'url'; template: string };

export interface AppCommand {
  trigger: string;
  aliases: string[];
  action: CommandAction;
}

export interface AppConfig {
  name: string;
  bundleId?: string;
  path?: string;
  aliases: string[];
  commands: AppCommand[];
  enabled: boolean;
}

export interface VoiceCommandSettings {
  enabled: boolean;
  apps: AppConfig[];
  globalCommands: AppCommand[];
  urlPatterns: string[];
}

export interface DeviceConnectionState {
  connected: boolean;
  deviceUid: string | null;
  deviceName: string | null;
  batteryLevel: number | null;
}

export interface ToastData {
  message: string;
  severity: 'success' | 'warning' | 'error' | 'info';
  duration: number;
}

export interface ElectronAPI {
  onTranscription(callback: (data: TranscriptionData) => void): void;
  removeTranscriptionListener(): void;
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
      pressEnterAfterPaste: boolean;
      sayEnterToPressEnter: boolean;
      pushToTalkMode: boolean;
      handsFreeMode: boolean;
      saveAudio: boolean;
      vocabWords: string[];
      phraseReplacements: PhraseReplacementRule[];
      startAtLogin: boolean;
    }>;
    setPressEnterAfterPaste(enabled: boolean): Promise<boolean>;
    setVocabWords(vocabWords: string[]): Promise<boolean>;
    setPhraseReplacements(rules: PhraseReplacementRule[]): Promise<boolean>;
    setSayEnterToPressEnter(enabled: boolean): Promise<boolean>;
    setPushToTalkMode(enabled: boolean): Promise<boolean>;
    setHandsFreeMode(enabled: boolean): Promise<boolean>;
    setSaveAudio(enabled: boolean): Promise<boolean>;
    setStartAtLogin(enabled: boolean): Promise<boolean>;
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
  voiceCommands: {
    getSettings(): Promise<VoiceCommandSettings>;
    saveSettings(settings: VoiceCommandSettings): Promise<boolean>;
    onCommandExecuted(callback: (command: { type: string }) => void): () => void;
  };
  device: {
    connectByUid(uid: string): Promise<{ success: boolean; error?: string }>;
    disconnect(): Promise<{ success: boolean; error?: string }>;
    getConnectionState(): Promise<DeviceConnectionState>;
    clearSavedDevice(): Promise<{ success: boolean; error?: string }>;
    onConnectionChanged(callback: (state: DeviceConnectionState) => void): () => void;
  };
  audioSource: {
    getSource(): Promise<{ source: 'ble' | 'system' }>;
    setFallbackMic(micId: string, label?: string | null): Promise<{ success: boolean; error?: string }>;
    switchToSystemMic(): Promise<{ success: boolean; error?: string }>;
    onSourceChanged(callback: (source: 'ble' | 'system') => void): () => void;
    onShowToast(callback: (toast: ToastData) => void): () => void;
    notifyInputDeviceChanged(): Promise<void>;
  };
  keystroke: {
    startRecording(): Promise<{ success: boolean; error?: string }>;
    stopRecording(): Promise<{
      success: boolean;
      keystroke?: { modifiers: string[]; key: string; formatted: string } | null;
      error?: string;
    }>;
    isRecording(): Promise<{ success: boolean; isRecording: boolean }>;
    record(modifiers: string[], key: string): Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
