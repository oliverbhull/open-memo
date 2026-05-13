/**
 * Sync Service - handles bidirectional sync with last-write-wins conflict resolution
 */

import { MemoEntry } from '../types/storage';
import { storageService } from './StorageService';
import { entryService } from './EntryService';
import { logger } from '../utils/logger';

export interface SyncManifest {
  entries: Array<{ id: string; updatedAt: number }>;
}

export interface SyncStats {
  sent: number;
  received: number;
}

/**
 * Last-write-wins merge logic
 * Sync only inspects id, updatedAt, deviceId
 */
export function mergeEntry(local: MemoEntry, remote: MemoEntry): MemoEntry {
  // Remote wins if newer
  if (remote.updatedAt > local.updatedAt) {
    return remote;
  }
  // Tie-breaker: lexicographic device ID
  if (remote.updatedAt === local.updatedAt && remote.deviceId > local.deviceId) {
    return remote;
  }
  return local;
}

export class SyncService {
  private lastSyncTime: number = 0;

  /**
   * Get manifest of all entries (id + updatedAt only)
   */
  async getManifest(): Promise<SyncManifest> {
    const entries = await storageService.getEntries(10000, 0); // Get all entries
    return {
      entries: entries.map(e => ({ id: e.id, updatedAt: e.updatedAt })),
    };
  }

  /**
   * Get full entries by IDs
   */
  async getEntries(ids: string[]): Promise<MemoEntry[]> {
    const allEntries = await storageService.getEntries(10000, 0);
    return allEntries.filter(e => ids.includes(e.id));
  }

  /**
   * Merge incoming entries using last-write-wins
   */
  async mergeEntries(entries: MemoEntry[]): Promise<SyncStats> {
    const stats: SyncStats = { sent: 0, received: 0 };

    // Ensure entryService is initialized before processing
    try {
      await entryService.init();
    } catch (error) {
      logger.error('[SyncService] Failed to initialize entryService:', error);
      // Continue anyway - entries will still be saved to storage
    }

    for (const remoteEntry of entries) {
      const localEntry = await storageService.getEntry(remoteEntry.id);
      
      if (!localEntry) {
        // New entry from remote
        await storageService.saveEntry(remoteEntry);
        stats.received++;
        
        // Notify UI of new entry
        entryService.addEntryFromSync(remoteEntry, true);
        logger.info('[SyncService] Added new entry from sync:', remoteEntry.id);
      } else {
        // Merge conflict resolution
        const merged = mergeEntry(localEntry, remoteEntry);
        
        // Only update if merged is different from local
        if (merged.id !== localEntry.id || merged.updatedAt !== localEntry.updatedAt) {
          await storageService.saveEntry(merged);
          if (merged.deviceId !== localEntry.deviceId) {
            stats.received++;
          }
          
          // Notify UI of updated entry
          entryService.addEntryFromSync(merged, false);
          logger.info('[SyncService] Updated entry from sync:', merged.id);
        }
      }
    }

    return stats;
  }

  /**
   * Get entries that have changed since last sync
   */
  async getChangedEntries(since: number): Promise<MemoEntry[]> {
    const allEntries = await storageService.getEntries(10000, 0);
    return allEntries.filter(e => e.updatedAt > since && !e.deletedAt);
  }

  /**
   * Update last sync time
   */
  setLastSyncTime(time: number): void {
    this.lastSyncTime = time;
  }

  getLastSyncTime(): number {
    return this.lastSyncTime;
  }
}

export const syncService = new SyncService();

