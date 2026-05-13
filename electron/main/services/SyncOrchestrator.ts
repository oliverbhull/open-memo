/**
 * Sync Orchestrator - Main process implementation
 */

import { connectionService } from './ConnectionService';
import { syncService } from '../../renderer/src/services/SyncService';
import { SyncMessage } from './SyncProtocol';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export type SyncStatus = 'idle' | 'listening' | 'connected' | 'syncing' | 'error';

export class SyncOrchestrator extends EventEmitter {
  private status: SyncStatus = 'idle';
  private lastSyncTime: number = 0;

  constructor() {
    super();
    
    connectionService.on('connected', () => {
      this.setStatus('connected');
      // Desktop is the server - it should NOT initiate sync
      // It only responds to SYNC_REQUEST messages from the client
      // The client (mobile) will send SYNC_REQUEST when it connects
    });

    connectionService.on('disconnected', () => {
      this.setStatus('idle');
    });

    connectionService.on('error', () => {
      this.setStatus('error');
    });
  }

  /**
   * Start listening for connections (host mode)
   */
  startListening(): { ip: string; port: number; token: string } {
    const info = connectionService.startListening();
    this.setStatus('listening');
    return info;
  }

  /**
   * Stop listening
   */
  stopListening(): void {
    connectionService.stopListening();
    this.setStatus('idle');
  }

  /**
   * Get connection info for QR code
   */
  getConnectionInfo(): { ip: string; port: number; token: string } | null {
    return connectionService.getConnectionInfo();
  }

  /**
   * Start sync process
   */
  private async startSync(): Promise<void> {
    if (!connectionService.isConnected()) {
      return;
    }

    this.setStatus('syncing');

    try {
      // Send sync request
      const message: SyncMessage = {
        type: 'SYNC_REQUEST',
        payload: { lastSyncTime: this.lastSyncTime },
      };
      connectionService.sendMessage(message);
    } catch (error) {
      logger.error('Error starting sync:', error);
      this.setStatus('error');
    }
  }

  /**
   * Manual sync trigger
   */
  async syncNow(): Promise<void> {
    if (!connectionService.isConnected()) {
      throw new Error('Not connected');
    }
    await this.startSync();
  }

  /**
   * Get current status
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Get last sync time
   */
  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  /**
   * Set status and notify listeners
   */
  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return connectionService.isConnected();
  }
}

export const syncOrchestrator = new SyncOrchestrator();

