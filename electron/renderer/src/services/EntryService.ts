import { FeedEntryData } from '../components/FeedEntry';
import { storageService } from './StorageService';
import { createValidEntry, convertToMemoEntry, convertToFeedEntry } from '../utils/validation';
import { getDeviceId } from './DeviceIdService';
import { logger } from '../utils/logger';

interface EntryEventMap {
  initialized: [];
  error: [unknown];
  entriesLoaded: [FeedEntryData[]];
  entryAdded: [FeedEntryData];
  moreEntriesLoaded: [FeedEntryData[]];
}

type EntryEvent = keyof EntryEventMap;
type StoredListener = (...args: never[]) => void;

// Minimal typed event emitter for the browser environment.
class EventEmitter {
  private listeners = new Map<EntryEvent, Set<StoredListener>>();

  on<Event extends EntryEvent>(event: Event, callback: (...args: EntryEventMap[Event]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as StoredListener);
  }

  off<Event extends EntryEvent>(event: Event, callback: (...args: EntryEventMap[Event]) => void): void {
    this.listeners.get(event)?.delete(callback as StoredListener);
  }

  emit<Event extends EntryEvent>(event: Event, ...args: EntryEventMap[Event]): void {
    this.listeners.get(event)?.forEach((callback) => {
      (callback as (...values: EntryEventMap[Event]) => void)(...args);
    });
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
      throw error;
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
    const suppliedId = typeof data === 'object' && data !== null && 'id' in data
      ? (data as { id?: unknown }).id
      : undefined;
    const id = typeof suppliedId === 'string' && suppliedId ? suppliedId : crypto.randomUUID();
    const feedEntry = createValidEntry(data, id);

    if (!feedEntry) {
      return null;
    }

    try {
      // Convert to MemoEntry and save to IndexedDB
      const deviceId = await getDeviceId();
      const memoEntry = convertToMemoEntry(feedEntry, deviceId);
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
      throw error;
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
      throw error;
    }
  }

}

// Singleton instance
export const entryService = new EntryService();
