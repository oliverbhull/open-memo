import { v4 as uuidv4 } from 'uuid';
import { FeedEntryData } from '../components/FeedEntry';
import { storageService } from './StorageService';
import { createValidEntry, isValidEntry, convertToMemoEntry, convertToFeedEntry } from '../utils/validation';
import { getDeviceId } from './DeviceIdService';
import { logger } from '../utils/logger';

// Simple EventEmitter for browser environment
class EventEmitter {
  private listeners: Map<string, Function[]> = new Map();

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: Function) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event: string, ...args: any[]) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => callback(...args));
    }
  }
}

export class EntryService extends EventEmitter {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private recentEntries: FeedEntryData[] = [];
  private readonly INITIAL_LOAD_COUNT = 100;

  /**
   * Initialize the service and load recent entries
   * Uses a promise to prevent concurrent initialization
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Create and store the initialization promise
    this.initPromise = (async () => {
      try {
        await storageService.init();
        await this.loadRecentEntries();
        this.initialized = true;
        this.emit('initialized');
      } catch (error) {
        // Reset initPromise on error so retry is possible
        this.initPromise = null;
        logger.error('Failed to initialize EntryService:', error);
        this.emit('error', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Load recent entries from storage
   */
  private async loadRecentEntries(): Promise<void> {
    try {
      const memoEntries = await storageService.getEntries(this.INITIAL_LOAD_COUNT, 0);
      // Convert MemoEntry to FeedEntryData for UI compatibility
      this.recentEntries = memoEntries.map(convertToFeedEntry);
      this.emit('entriesLoaded', this.recentEntries);
    } catch (error) {
      logger.error('Failed to load recent entries:', error);
      this.emit('error', error);
    }
  }

  /**
   * Get recent entries (from memory cache)
   */
  getRecentEntries(): FeedEntryData[] {
    return [...this.recentEntries];
  }

  /**
   * Add a new entry from transcription data
   */
  async addEntry(data: unknown): Promise<FeedEntryData | null> {
    // Ensure initialization is complete (handles concurrent calls)
    if (!this.initialized) {
      await this.init();
    }

    // Use provided ID if available (from main process), otherwise generate one
    const id = (data as any)?.id || uuidv4();
    const feedEntry = createValidEntry(data, id);

    if (!feedEntry) {
      return null;
    }

    try {
      // Convert to MemoEntry and save to IndexedDB
      const deviceId = await getDeviceId();
      const memoEntry = await convertToMemoEntry(feedEntry, deviceId);
      await storageService.saveEntry(memoEntry);

      // Add to recent entries cache (at the beginning)
      this.recentEntries.unshift(feedEntry);

      // Keep cache size reasonable (only keep most recent 200 in memory)
      if (this.recentEntries.length > 200) {
        this.recentEntries = this.recentEntries.slice(0, 200);
      }

      this.emit('entryAdded', feedEntry);
      return feedEntry;
    } catch (error) {
      logger.error('Failed to add entry:', error);
      this.emit('error', error);
      return null;
    }
  }

  /**
   * Load more entries (for lazy loading)
   */
  async loadMoreEntries(count: number = 50): Promise<FeedEntryData[]> {
    // Ensure initialization is complete (handles concurrent calls)
    if (!this.initialized) {
      await this.init();
    }

    try {
      const offset = this.recentEntries.length;
      const memoEntries = await storageService.getEntries(count, offset);
      const feedEntries = memoEntries.map(convertToFeedEntry);
      
      // Append to recent entries (these are older entries)
      this.recentEntries.push(...feedEntries);
      
      this.emit('moreEntriesLoaded', feedEntries);
      return feedEntries;
    } catch (error) {
      logger.error('Failed to load more entries:', error);
      this.emit('error', error);
      return [];
    }
  }

  /**
   * Get total entry count
   */
  async getTotalCount(): Promise<number> {
    // Ensure initialization is complete (handles concurrent calls)
    if (!this.initialized) {
      await this.init();
    }

    try {
      return await storageService.getEntryCount();
    } catch (error) {
      logger.error('Failed to get entry count:', error);
      return this.recentEntries.length;
    }
  }

  /**
   * Delete an entry
   */
  async deleteEntry(id: string): Promise<boolean> {
    // Ensure initialization is complete (handles concurrent calls)
    if (!this.initialized) {
      await this.init();
    }

    try {
      await storageService.deleteEntry(id);
      
      // Remove from cache
      this.recentEntries = this.recentEntries.filter(e => e.id !== id);
      
      this.emit('entryDeleted', id);
      return true;
    } catch (error) {
      logger.error('Failed to delete entry:', error);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Get an entry by ID
   */
  async getEntry(id: string): Promise<FeedEntryData | null> {
    // Ensure initialization is complete (handles concurrent calls)
    if (!this.initialized) {
      await this.init();
    }

    // Check cache first
    const cached = this.recentEntries.find(e => e.id === id);
    if (cached) {
      return cached;
    }

    // Load from storage
    try {
      const memoEntry = await storageService.getEntry(id);
      return memoEntry ? convertToFeedEntry(memoEntry) : null;
    } catch (error) {
      logger.error('Failed to get entry:', error);
      return null;
    }
  }

  /**
   * Add or update an entry from sync (used by SyncService)
   * This bypasses the normal addEntry flow but still updates cache and emits events
   */
  addEntryFromSync(memoEntry: MemoEntry, isNew: boolean): void {
    // Ensure initialization is complete
    if (!this.initialized) {
      // If not initialized, queue this for later or initialize synchronously
      // For now, we'll just log a warning and return
      logger.warn('[EntryService] Cannot add entry from sync: service not initialized');
      return;
    }

    try {
      // Convert MemoEntry to FeedEntryData
      const feedEntry = convertToFeedEntry(memoEntry);

      if (isNew) {
        // New entry: add to beginning of cache
        // Remove existing entry with same ID if present (shouldn't happen for new entries)
        this.recentEntries = this.recentEntries.filter(e => e.id !== feedEntry.id);
        this.recentEntries.unshift(feedEntry);

        // Keep cache size reasonable
        if (this.recentEntries.length > 200) {
          this.recentEntries = this.recentEntries.slice(0, 200);
        }

        // Emit event for UI to update
        this.emit('entryAdded', feedEntry);
        logger.info('[EntryService] Added entry from sync:', feedEntry.id);
      } else {
        // Updated entry: update in cache if present
        const existingIndex = this.recentEntries.findIndex(e => e.id === feedEntry.id);
        if (existingIndex >= 0) {
          // Update existing entry in cache
          this.recentEntries[existingIndex] = feedEntry;
          // Re-sort to maintain newest-first order (in case updatedAt changed)
          this.recentEntries.sort((a, b) => {
            const timeA = a.createdAt || a.timestamp;
            const timeB = b.createdAt || b.timestamp;
            return timeB - timeA;
          });
          logger.info('[EntryService] Updated entry from sync:', feedEntry.id);
        } else {
          // Entry not in cache but was updated - add it if it's recent enough
          // Only add if it's within the first 200 entries by timestamp
          this.recentEntries.unshift(feedEntry);
          if (this.recentEntries.length > 200) {
            this.recentEntries = this.recentEntries.slice(0, 200);
          }
          logger.info('[EntryService] Added updated entry from sync to cache:', feedEntry.id);
        }
        // Emit entryAdded event even for updates so UI refreshes
        // The UI will handle deduplication
        this.emit('entryAdded', feedEntry);
      }
    } catch (error) {
      logger.error('[EntryService] Failed to add entry from sync:', error);
    }
  }
}

// Singleton instance
export const entryService = new EntryService();


