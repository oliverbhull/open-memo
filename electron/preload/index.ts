import { contextBridge, ipcRenderer } from 'electron';
import type {
  ElectronAPI,
  MemoSttError,
  PhraseReplacementRule,
  ToastData,
  TranscriptionData,
  VoiceCommandSettings,
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
      pressEnterAfterPaste: boolean;
      sayEnterToPressEnter: boolean;
      pushToTalkMode: boolean;
      handsFreeMode: boolean;
      vocabWords: string[];
      phraseReplacements: PhraseReplacementRule[];
      startAtLogin: boolean;
    }> => {
      return ipcRenderer.invoke('settings:getInterfaceSettings');
    },
    setPressEnterAfterPaste: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setPressEnterAfterPaste', enabled);
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
    setPushToTalkMode: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setPushToTalkMode', enabled);
    },
    setHandsFreeMode: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setHandsFreeMode', enabled);
    },
    setStartAtLogin: (enabled: boolean): Promise<boolean> => {
      return ipcRenderer.invoke('settings:setStartAtLogin', enabled);
    },
  },
  voiceCommands: {
    getSettings: (): Promise<VoiceCommandSettings> => {
      return ipcRenderer.invoke('settings:getVoiceCommands');
    },
    saveSettings: (settings: VoiceCommandSettings): Promise<boolean> => {
      return ipcRenderer.invoke('settings:saveVoiceCommands', settings);
    },
    onCommandExecuted: (callback: (command: { type: string }) => void) => {
      ipcRenderer.on('command:executed', (_event, command) => callback(command));
      return () => {
        ipcRenderer.removeAllListeners('command:executed');
      };
    },
  },
  // Memo hardware connection API
  device: {
    connectByUid: (uid: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('device:connectByUid', uid);
    },
    disconnect: (): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke('device:disconnect');
    },
    getConnectionState: (): Promise<{
      connected: boolean;
      deviceUid: string | null;
      deviceName: string | null;
      batteryLevel: number | null;
    }> => {
      return ipcRenderer.invoke('device:getConnectionState');
    },
    clearSavedDevice: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('device:clearSavedDevice');
    },
    onConnectionChanged: (callback: (state: {
      connected: boolean;
      deviceUid: string | null;
      deviceName: string | null;
      batteryLevel: number | null;
    }) => void) => {
      ipcRenderer.on('device:connectionChanged', (_event, state) => callback(state));
      return () => {
        ipcRenderer.removeAllListeners('device:connectionChanged');
      };
    },
  },
  // Audio Source Management
  audioSource: {
    getSource: (): Promise<{ source: 'ble' | 'system' }> => {
      return ipcRenderer.invoke('audio:getSource');
    },
    setFallbackMic: (micId: string, label?: string | null): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('audio:setFallbackMic', micId, label);
    },
    switchToSystemMic: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('audio:switchToSystemMic');
    },
    onSourceChanged: (callback: (source: 'ble' | 'system') => void) => {
      ipcRenderer.on('audio:sourceChanged', (_event, source) => callback(source));
      return () => {
        ipcRenderer.removeAllListeners('audio:sourceChanged');
      };
    },
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
  keystroke: {
    startRecording: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('keystroke:start-recording');
    },
    stopRecording: (): Promise<{ success: boolean; keystroke?: { modifiers: string[]; key: string; formatted: string } | null; error?: string }> => {
      return ipcRenderer.invoke('keystroke:stop-recording');
    },
    isRecording: (): Promise<{ success: boolean; isRecording: boolean }> => {
      return ipcRenderer.invoke('keystroke:is-recording');
    },
    record: (modifiers: string[], key: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('keystroke:record', modifiers, key);
    },
  },
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
