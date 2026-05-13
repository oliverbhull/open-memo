/**
 * Sync Protocol - handles the sync protocol messages (Renderer version)
 */

import { MemoEntry } from '../types/storage';
import { syncService, SyncManifest } from './SyncService';
import { logger } from '../utils/logger';

export interface SyncMessage {
  type: 'SYNC_REQUEST' | 'MANIFEST' | 'NEED_ENTRIES' | 'ENTRIES' | 'MY_CHANGES' | 'ACK';
  payload?: any;
}

/**
 * Handle incoming sync protocol messages
 */
export class SyncProtocol {
  async handleMessage(message: SyncMessage, sendResponse: (msg: SyncMessage) => void): Promise<void> {
    try {
      switch (message.type) {
        case 'SYNC_REQUEST':
          await this.handleSyncRequest(message.payload, sendResponse);
          break;
        case 'MANIFEST':
          await this.handleManifest(message.payload, sendResponse);
          break;
        case 'NEED_ENTRIES':
          await this.handleNeedEntries(message.payload, sendResponse);
          break;
        case 'ENTRIES':
          await this.handleEntries(message.payload, sendResponse);
          break;
        case 'MY_CHANGES':
          await this.handleMyChanges(message.payload, sendResponse);
          break;
        case 'ACK':
          // Acknowledgment - sync complete
          logger.info('[SyncProtocol] Received ACK, sync complete. Stats:', message.payload?.stats);
          break;
        default:
          logger.warn('[SyncProtocol] Unknown message type:', (message as any).type);
      }
    } catch (error) {
      logger.error('[SyncProtocol] Error handling message:', error);
      // Try to send error response if possible
      try {
        sendResponse({ type: 'ACK', payload: { error: error instanceof Error ? error.message : 'Unknown error' } });
      } catch (responseError) {
        logger.error('[SyncProtocol] Failed to send error response:', responseError);
      }
      throw error;
    }
  }

  private async handleSyncRequest(payload: { lastSyncTime: number }, sendResponse: (msg: SyncMessage) => void) {
    try {
      logger.info('[SyncProtocol] Handling SYNC_REQUEST, lastSyncTime:', payload.lastSyncTime);
      const manifest = await syncService.getManifest();
      logger.info('[SyncProtocol] Sending MANIFEST with', manifest.entries?.length || 0, 'entries');
      sendResponse({ type: 'MANIFEST', payload: manifest });
    } catch (error) {
      logger.error('[SyncProtocol] Error handling SYNC_REQUEST:', error);
      throw error;
    }
  }

  private async handleManifest(payload: SyncManifest, sendResponse: (msg: SyncMessage) => void) {
    logger.info('[SyncProtocol] Received MANIFEST with', payload.entries?.length || 0, 'entries');
    const localManifest = await syncService.getManifest();
    const localMap = new Map(localManifest.entries.map(e => [e.id, e.updatedAt]));
    
    // Find entries we need from remote
    const needIds: string[] = [];
    for (const remoteEntry of payload.entries) {
      const localUpdatedAt = localMap.get(remoteEntry.id);
      if (!localUpdatedAt || remoteEntry.updatedAt > localUpdatedAt) {
        needIds.push(remoteEntry.id);
      }
    }

    logger.info('[SyncProtocol] Need', needIds.length, 'entries from remote');
    if (needIds.length > 0) {
      logger.info('[SyncProtocol] Sending NEED_ENTRIES');
      sendResponse({ type: 'NEED_ENTRIES', payload: { ids: needIds } });
    } else {
      // Send our changes
      logger.info('[SyncProtocol] No entries needed, sending our changes');
      const lastSyncTime = syncService.getLastSyncTime();
      const ourChanges = await syncService.getChangedEntries(lastSyncTime);
      logger.info('[SyncProtocol] Sending', ourChanges.length, 'changed entries');
      sendResponse({ type: 'MY_CHANGES', payload: { entries: ourChanges } });
    }
  }

  private async handleNeedEntries(payload: { ids: string[] }, sendResponse: (msg: SyncMessage) => void) {
    logger.info('[SyncProtocol] Received NEED_ENTRIES for', payload.ids?.length || 0, 'entry IDs');
    const entries = await syncService.getEntries(payload.ids);
    logger.info('[SyncProtocol] Sending', entries.length, 'entries');
    sendResponse({ type: 'ENTRIES', payload: { entries } });
  }

  private async handleEntries(payload: { entries: MemoEntry[] }, sendResponse: (msg: SyncMessage) => void) {
    logger.info('[SyncProtocol] Received', payload.entries?.length || 0, 'entries');
    const stats = await syncService.mergeEntries(payload.entries);
    logger.info('[SyncProtocol] Merged entries. Added:', stats.added, 'Updated:', stats.updated, 'Deleted:', stats.deleted);
    
    // Send our changes
    const lastSyncTime = syncService.getLastSyncTime();
    const ourChanges = await syncService.getChangedEntries(lastSyncTime);
    logger.info('[SyncProtocol] Sending', ourChanges.length, 'changed entries');
    sendResponse({ type: 'MY_CHANGES', payload: { entries: ourChanges } });
  }

  private async handleMyChanges(payload: { entries: MemoEntry[] }, sendResponse: (msg: SyncMessage) => void) {
    try {
      logger.info('[SyncProtocol] Received', payload.entries?.length || 0, 'changed entries from remote');
      const stats = await syncService.mergeEntries(payload.entries);
      logger.info('[SyncProtocol] Merged remote changes. Added:', stats.added, 'Updated:', stats.updated, 'Deleted:', stats.deleted);
      syncService.setLastSyncTime(Date.now());
      logger.info('[SyncProtocol] Sending ACK to complete sync');
      sendResponse({ type: 'ACK', payload: { stats } });
      logger.info('[SyncProtocol] Sync handshake completed successfully');
    } catch (error) {
      logger.error('[SyncProtocol] Error handling MY_CHANGES:', error);
      throw error;
    }
  }
}

export const syncProtocol = new SyncProtocol();

