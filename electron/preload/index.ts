import { contextBridge, ipcRenderer } from 'electron';
import type {
  AsrModelId,
  AsrSelectionResult,
  AsrState,
  DeviceSyncStatus,
  ElectronAPI,
  MemoSttError,
  MicrophoneInputState,
  PhraseReplacementRule,
  ToastData,
  TranscriptionData,
  TranscriptionExportDocument,
} from '../shared/electron-api';

// Store callback references for proper cleanup
const transcriptionCallbacks = new Set<(data: TranscriptionData) => void>();
const statusCallbacks = new Set<(status: string) => void>();
const errorCallbacks = new Set<(error: MemoSttError) => void>();

// Wrapper functions that can be properly removed
const transcriptionHandler = (_event: Electron.IpcRendererEvent, data: TranscriptionData) => {
  transcriptionCallbacks.forEach(callback => callback(data));
};

const statusHandler = (_event: Electron.IpcRendererEvent, status: string) => {
  statusCallbacks.forEach(callback => callback(status));
};

const errorHandler = (_event: Electron.IpcRendererEvent, error: MemoSttError) => {
  errorCallbacks.forEach(callback => callback(error));
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const electronAPI = {
  // Transcription events
  onTranscription: (callback: (data: TranscriptionData) => void) => {
    // Remove existing listener to prevent duplicates, then re-add if needed
    ipcRenderer.removeListener('transcription:new', transcriptionHandler);
    transcriptionCallbacks.add(callback);
    // Add listener now that we have at least one callback
    ipcRenderer.on('transcription:new', transcriptionHandler);
  },
  
  removeTranscriptionListener: () => {
    transcriptionCallbacks.clear();
    ipcRenderer.removeListener('transcription:new', transcriptionHandler);
  },

  listUsbTranscripts: (): Promise<TranscriptionData[]> => {
    return ipcRenderer.invoke('usb-transcripts:list');
  },

  deviceSync: {
    getStatus: (): Promise<DeviceSyncStatus> => ipcRenderer.invoke('device-sync:get-status'),
    openRecordingsFolder: (): Promise<{ success: boolean; error?: string }> => (
      ipcRenderer.invoke('device-sync:open-recordings-folder')
    ),
    onStatus: (callback: (status: DeviceSyncStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: DeviceSyncStatus) => callback(status);
      ipcRenderer.on('device-sync:status', handler);
      return () => ipcRenderer.removeListener('device-sync:status', handler);
    },
  },

  // Status events
  onStatus: (callback: (status: string) => void) => {
    // Remove existing listener to prevent duplicates, then re-add if needed
    ipcRenderer.removeListener('memo-stt:status', statusHandler);
    statusCallbacks.add(callback);
    // Add listener now that we have at least one callback
    ipcRenderer.on('memo-stt:status', statusHandler);
  },

  removeStatusListener: () => {
    statusCallbacks.clear();
    ipcRenderer.removeListener('memo-stt:status', statusHandler);
  },

  // Error events
  onError: (callback: (error: MemoSttError) => void) => {
    // Remove existing listener to prevent duplicates, then re-add if needed
    ipcRenderer.removeListener('memo-stt:error', errorHandler);
    errorCallbacks.add(callback);
    // Add listener now that we have at least one callback
    ipcRenderer.on('memo-stt:error', errorHandler);
  },

  removeErrorListener: () => {
    errorCallbacks.clear();
    ipcRenderer.removeListener('memo-stt:error', errorHandler);
  },

  // Commands
  getStatus: (): Promise<string> => {
    return ipcRenderer.invoke('memo-stt:get-status');
  },

  restart: (): Promise<void> => {
    return ipcRenderer.invoke('memo-stt:restart');
  },

  // Permission handlers
  checkMicrophonePermission: (): Promise<boolean> => {
    return ipcRenderer.invoke('permissions:check-microphone');
  },

  requestMicrophonePermission: (): Promise<boolean> => {
    return ipcRenderer.invoke('permissions:request-microphone');
  },

  checkInputMonitoringPermission: (): Promise<boolean> => {
    return ipcRenderer.invoke('permissions:check-input-monitoring');
  },

  openInputMonitoringPreferences: (): Promise<void> => {
    return ipcRenderer.invoke('permissions:open-input-monitoring-preferences');
  },

  checkAccessibilityPermission: (): Promise<boolean> => {
    return ipcRenderer.invoke('permissions:check-accessibility');
  },

  openSystemPreferences: (): Promise<void> => {
    return ipcRenderer.invoke('permissions:open-system-preferences');
  },

  restartApp: (): Promise<void> => {
    return ipcRenderer.invoke('app:restart');
  },

  startMemoSttService: (): Promise<void> => {
    return ipcRenderer.invoke('app:start-memo-stt-service');
  },

  // User name handlers
  saveUserName: (name: string): Promise<void> => {
    return ipcRenderer.invoke('user:save-name', name);
  },

  getUserName: (): Promise<string | null> => {
    return ipcRenderer.invoke('user:get-name');
  },

  isUserOnboarded: (userName: string): Promise<boolean> => {
    return ipcRenderer.invoke('user:is-onboarded', userName);
  },

  markUserOnboarded: (userName: string): Promise<void> => {
    return ipcRenderer.invoke('user:mark-onboarded', userName);
  },

  interface: {
    getSettings: (): Promise<{
      sayEnterToPressEnter: boolean;
      handsFreeMode: boolean;
      saveAudio: boolean;
      vocabWords: string[];
      phraseReplacements: PhraseReplacementRule[];
      startAtLogin: boolean;
    }> => {
      return ipcRenderer.invoke('settings:getInterfaceSettings');
    },
    setVocabWords: (vocabWords: string[]): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setVocabWords', vocabWords);
    },
    setPhraseReplacements: (rules: PhraseReplacementRule[]): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setPhraseReplacements', rules);
    },
    setSayEnterToPressEnter: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setSayEnterToPressEnter', enabled);
    },
    setHandsFreeMode: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setHandsFreeMode', enabled);
    },
    setSaveAudio: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setSaveAudio', enabled);
    },
    setStartAtLogin: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setStartAtLogin', enabled);
    },
  },
  asr: {
    getState: (): Promise<AsrState> => ipcRenderer.invoke('asr:get-state'),
    selectModel: (model: AsrModelId): Promise<AsrSelectionResult> => (
      ipcRenderer.invoke('asr:select-model', model)
    ),
    onStateChanged: (callback: (state: AsrState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AsrState) => callback(state);
      ipcRenderer.on('asr:state-changed', handler);
      return () => ipcRenderer.removeListener('asr:state-changed', handler);
    },
  },
  microphone: {
    getState: (): Promise<MicrophoneInputState> => ipcRenderer.invoke('microphone:get-state'),
    selectSystemInput: (deviceName: string | null): Promise<MicrophoneInputState> => (
      ipcRenderer.invoke('microphone:select-system-input', deviceName)
    ),
    onStateChanged: (callback: (state: MicrophoneInputState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: MicrophoneInputState) => callback(state);
      ipcRenderer.on('microphone:state-changed', handler);
      return () => ipcRenderer.removeListener('microphone:state-changed', handler);
    },
  },
  audio: {
    get: (entryId: string): Promise<{ success: boolean; data?: Uint8Array; error?: string }> => (
      ipcRenderer.invoke('audio:get', entryId)
    ),
    delete: (entryId: string): Promise<{ success: boolean; error?: string }> => (
      ipcRenderer.invoke('audio:delete', entryId)
    ),
    openFolder: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('audio:openFolder'),
  },
  appIcons: {
    get: (appName: string, bundleId?: string): Promise<string | null> => (
      ipcRenderer.invoke('app-icon:get', appName, bundleId)
    ),
  },
  onOpenSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('settings:open', handler);
    return () => ipcRenderer.removeListener('settings:open', handler);
  },
  exportJson: (document: TranscriptionExportDocument): Promise<{
    success: boolean;
    canceled?: boolean;
    error?: string;
  }> => ipcRenderer.invoke('export:json', document),
  // Audio Source Management
  audioSource: {
    onShowToast: (callback: (toast: ToastData) => void) => {
      ipcRenderer.on('audio:showToast', (_event, toast) => callback(toast));
      return () => {
        ipcRenderer.removeAllListeners('audio:showToast');
      };
    },
    /** Called by the renderer's devicechange listener when an audio input device is added or removed. */
    notifyInputDeviceChanged: (): Promise<void> => {
      return ipcRenderer.invoke('audio:inputDeviceChanged');
    },
  },
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
