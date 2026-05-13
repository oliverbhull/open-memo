/**
 * Sync Orchestrator - Renderer-side wrapper for IPC communication
 */

declare global {
  interface Window {
    electronAPI: {
      sync: {
        startListening: () => Promise<{ ip: string; port: number; token: string }>;
        stopListening: () => Promise<void>;
        getConnectionInfo: () => Promise<{ ip: string; port: number; token: string } | null>;
        syncNow: () => Promise<void>;
        getStatus: () => Promise<string>;
        getLastSyncTime: () => Promise<number>;
        isConnected: () => Promise<boolean>;
        onStatusChange: (callback: (status: string) => void) => () => void;
        onIncomingMessage: (callback: (message: any) => void) => () => void;
        sendOutgoingMessage: (message: any) => void;
      };
      storage: {
        clearIndexedDB: () => Promise<boolean>;
      };
    };
  }
}

export type SyncStatus = 'idle' | 'listening' | 'connected' | 'syncing' | 'error';

/**
 * Renderer-side sync orchestrator (IPC wrapper)
 */
export class SyncOrchestrator {
  /**
   * Start listening for connections (host mode)
   */
  async startListening(): Promise<{ ip: string; port: number; token: string }> {
    return window.electronAPI.sync.startListening();
  }

  /**
   * Stop listening
   */
  async stopListening(): Promise<void> {
    return window.electronAPI.sync.stopListening();
  }

  /**
   * Get connection info for QR code
   */
  async getConnectionInfo(): Promise<{ ip: string; port: number; token: string } | null> {
    return window.electronAPI.sync.getConnectionInfo();
  }

  /**
   * Manual sync trigger
   */
  async syncNow(): Promise<void> {
    return window.electronAPI.sync.syncNow();
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<SyncStatus> {
    return window.electronAPI.sync.getStatus() as Promise<SyncStatus>;
  }

  /**
   * Get last sync time
   */
  async getLastSyncTime(): Promise<number> {
    return window.electronAPI.sync.getLastSyncTime();
  }

  /**
   * Subscribe to status changes
   */
  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    return window.electronAPI.sync.onStatusChange((status) => {
      listener(status as SyncStatus);
    });
  }

  /**
   * Check if connected
   */
  async isConnected(): Promise<boolean> {
    return window.electronAPI.sync.isConnected();
  }
}

export const syncOrchestrator = new SyncOrchestrator();

