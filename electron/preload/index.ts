import { contextBridge, ipcRenderer } from 'electron';

export interface AppContext {
  appName: string;
  windowTitle: string;
}

export interface TranscriptionData {
  rawTranscript: string;
  processedText: string;
  wasProcessedByLLM: boolean;
  timestamp: number;
  appContext?: AppContext;
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
contextBridge.exposeInMainWorld('electronAPI', {
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

  // Sync handlers
  sync: {
    startListening: (): Promise<{ ip: string; port: number; token: string }> => {
      return ipcRenderer.invoke('sync:start-listening');
    },
    stopListening: (): Promise<void> => {
      return ipcRenderer.invoke('sync:stop-listening');
    },
    getConnectionInfo: (): Promise<{ ip: string; port: number; token: string } | null> => {
      return ipcRenderer.invoke('sync:get-connection-info');
    },
    syncNow: (): Promise<void> => {
      return ipcRenderer.invoke('sync:sync-now');
    },
    getStatus: (): Promise<string> => {
      return ipcRenderer.invoke('sync:get-status');
    },
    getLastSyncTime: (): Promise<number> => {
      return ipcRenderer.invoke('sync:get-last-sync-time');
    },
    isConnected: (): Promise<boolean> => {
      return ipcRenderer.invoke('sync:is-connected');
    },
    onStatusChange: (callback: (status: string) => void) => {
      ipcRenderer.on('sync:status', (_event, status) => callback(status));
      return () => {
        ipcRenderer.removeAllListeners('sync:status');
      };
    },
    onIncomingMessage: (callback: (message: any) => void) => {
      ipcRenderer.on('sync:incoming-message', (_event, message) => callback(message));
      return () => {
        ipcRenderer.removeAllListeners('sync:incoming-message');
      };
    },
    sendOutgoingMessage: (message: any) => {
      ipcRenderer.send('sync:outgoing-message', message);
    },
  },
  storage: {
    clearIndexedDB: (): Promise<boolean> => {
      return ipcRenderer.invoke('storage:clear-indexeddb');
    },
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
    getSettings: (): Promise<any> => {
      return ipcRenderer.invoke('settings:getVoiceCommands');
    },
    saveSettings: (settings: any): Promise<boolean> => {
      return ipcRenderer.invoke('settings:saveVoiceCommands', settings);
    },
    onCommandExecuted: (callback: (command: any) => void) => {
      ipcRenderer.on('command:executed', (_event, command) => callback(command));
      return () => {
        ipcRenderer.removeAllListeners('command:executed');
      };
    },
  },
  // Device API (legacy - for old Settings UI)
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
    onDeviceFound: (callback: (device: { name: string; id: string; rssi?: number }) => void) => {
      ipcRenderer.on('device:deviceFound', (_event, device) => callback(device));
      return () => {
        ipcRenderer.removeAllListeners('device:deviceFound');
      };
    },
    onScanComplete: (callback: () => void) => {
      ipcRenderer.on('device:scanComplete', () => callback());
      return () => {
        ipcRenderer.removeAllListeners('device:scanComplete');
      };
    },
    onScanError: (callback: (error: string) => void) => {
      ipcRenderer.on('device:scanError', (_event, error) => callback(error));
      return () => {
        ipcRenderer.removeAllListeners('device:scanError');
      };
    },
  },
  // BLE Device Management
  ble: {
    setUid: (uid: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('ble:setUid', uid);
    },
    clearUid: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('ble:clearUid');
    },
    getState: (): Promise<{
      state: 'idle' | 'scanning' | 'connected' | 'fallback';
      memoUid: string | null;
      connectedDeviceName: string | null;
      batteryLevel: number | null;
      reconnectAttempts: number;
      lastConnectionTime: number | null;
      errorMessage: string | null;
    }> => {
      return ipcRenderer.invoke('ble:getState');
    },
    reconnect: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('ble:reconnect');
    },
    disconnect: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('ble:disconnect');
    },
    setAutoReconnect: (enabled: boolean): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('ble:setAutoReconnect', enabled);
    },
    onStateChanged: (callback: (data: any) => void) => {
      ipcRenderer.on('ble:stateChanged', (_event, data) => callback(data));
      return () => {
        ipcRenderer.removeAllListeners('ble:stateChanged');
      };
    },
    onDeviceDiscovered: (callback: (device: { name: string; uid: string; rssi: number }) => void) => {
      ipcRenderer.on('ble:deviceDiscovered', (_event, device) => callback(device));
      return () => {
        ipcRenderer.removeAllListeners('ble:deviceDiscovered');
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
    onShowToast: (callback: (toast: { message: string; severity: string; duration: number }) => void) => {
      ipcRenderer.on('audio:showToast', (_event, toast) => callback(toast));
      return () => {
        ipcRenderer.removeAllListeners('audio:showToast');
      };
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
});


