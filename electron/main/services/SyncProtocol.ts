/**
 * Sync Protocol - handles the sync protocol messages
 */

import { MemoEntry } from '../../renderer/src/types/storage';
import { syncService, SyncManifest } from '../../renderer/src/services/SyncService';

export interface SyncMessage {
  type: 'SYNC_REQUEST' | 'MANIFEST' | 'NEED_ENTRIES' | 'ENTRIES' | 'MY_CHANGES' | 'ACK';
  payload?: any;
}

/**
 * Handle incoming sync protocol messages
 */
export class SyncProtocol {
  async handleMessage(message: SyncMessage, sendResponse: (msg: SyncMessage) => void): Promise<void> {
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
        // Acknowledgment - no action needed
        break;
    }
  }

  private async handleSyncRequest(payload: { lastSyncTime: number }, sendResponse: (msg: SyncMessage) => void) {
    const manifest = await syncService.getManifest();
    sendResponse({ type: 'MANIFEST', payload: manifest });
  }

  private async handleManifest(payload: SyncManifest, sendResponse: (msg: SyncMessage) => void) {
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

    if (needIds.length > 0) {
      sendResponse({ type: 'NEED_ENTRIES', payload: { ids: needIds } });
    } else {
      // Send our changes
      const lastSyncTime = syncService.getLastSyncTime();
      const ourChanges = await syncService.getChangedEntries(lastSyncTime);
      sendResponse({ type: 'MY_CHANGES', payload: { entries: ourChanges } });
    }
  }

  private async handleNeedEntries(payload: { ids: string[] }, sendResponse: (msg: SyncMessage) => void) {
    const entries = await syncService.getEntries(payload.ids);
    sendResponse({ type: 'ENTRIES', payload: { entries } });
  }

  private async handleEntries(payload: { entries: MemoEntry[] }, sendResponse: (msg: SyncMessage) => void) {
    await syncService.mergeEntries(payload.entries);
    
    // Send our changes
    const lastSyncTime = syncService.getLastSyncTime();
    const ourChanges = await syncService.getChangedEntries(lastSyncTime);
    sendResponse({ type: 'MY_CHANGES', payload: { entries: ourChanges } });
  }

  private async handleMyChanges(payload: { entries: MemoEntry[] }, sendResponse: (msg: SyncMessage) => void) {
    const stats = await syncService.mergeEntries(payload.entries);
    syncService.setLastSyncTime(Date.now());
    sendResponse({ type: 'ACK', payload: { stats } });
  }
}

export const syncProtocol = new SyncProtocol();

