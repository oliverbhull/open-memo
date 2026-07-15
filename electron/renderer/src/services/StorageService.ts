import { DB_NAME, DB_VERSION, STORE_NAME, MemoEntry } from '../types/storage';
import { logger } from '../utils/logger';
import { getMigrationsToRun } from './migrations';
import { getDeviceId } from './DeviceIdService';

export class StorageService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly INITIAL_RETRY_DELAY = 100; // Start with 100ms
  private readonly MAX_RETRY_DELAY = 5000; // Cap at 5 seconds

  /**
   * Initialize the IndexedDB database with retry logic
   */
  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initWithRetry(0).catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  /**
   * Internal method to initialize with retry logic
   */
  private async initWithRetry(attempt: number = 0): Promise<void> {
    try {
      return await this.attemptInit();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isLockError = errorMessage.includes('LOCK') || 
                         errorMessage.includes('backing store') ||
                         (error instanceof DOMException && error.name === 'UnknownError');
      
      if (isLockError && attempt < this.MAX_RETRY_ATTEMPTS) {
        // Calculate exponential backoff delay
        const delay = Math.min(
          this.INITIAL_RETRY_DELAY * Math.pow(2, attempt),
          this.MAX_RETRY_DELAY
        );
        
        logger.warn(
          `[StorageService] Database lock error (attempt ${attempt + 1}/${this.MAX_RETRY_ATTEMPTS}), ` +
          `retrying in ${delay}ms...`
        );
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Retry
        return this.initWithRetry(attempt + 1);
      }
      
      // Max retries reached or non-lock error
      logger.error(`[StorageService] Failed to initialize database after ${attempt + 1} attempts:`, error);
      throw error;
    }
  }

  /**
   * Single attempt to initialize the database
   */
  private attemptInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        const error = request.error || new Error('Unknown IndexedDB error');
        const errorMessage = error.message || '';
        const errorName = error.name || 'UnknownError';

        logger.error(`[StorageService] Failed to open IndexedDB:`, {
          name: errorName,
          message: errorMessage,
          error,
        });

        // Never delete user data automatically. Lock errors are retried by
        // initWithRetry; all other failures are surfaced to the UI.
        const isLockError = errorMessage.includes('LOCK') || 
                           errorMessage.includes('backing store');
        if (isLockError) {
          reject(new Error(`LOCK: ${errorMessage}`));
        } else {
          reject(new Error(`Failed to open database: ${errorMessage}`));
        }
      };

      request.onsuccess = async () => {
        this.db = request.result;
        logger.info(`[StorageService] Database opened successfully`);
        
        // Set up error handler for database errors
        this.db.onerror = (event) => {
          logger.error('[StorageService] Database error:', event);
        };
        
        this.db.onclose = () => {
          logger.info('[StorageService] Database connection closed');
          this.db = null;
          this.initPromise = null;
        };
        
        // Run data migration if needed (after schema upgrade)
        try {
          await this.migrateDataIfNeeded();
        } catch (error) {
          logger.error('[StorageService] Data migration failed:', error);
          this.db.close();
          this.db = null;
          reject(error);
          return;
        }
        
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;
        const newVersion = event.newVersion || DB_VERSION;

        // Run migrations synchronously (onupgradeneeded must be synchronous)
        try {
          const migrationsToRun = getMigrationsToRun(oldVersion, newVersion);
          const transaction = (event.target as IDBOpenDBRequest).transaction;
          
          if (migrationsToRun.length > 0) {
            logger.info(`Running ${migrationsToRun.length} migration(s) from version ${oldVersion} to ${newVersion}`);
          }
          
          for (const migration of migrationsToRun) {
            logger.info(`Running migration ${migration.version}: ${migration.description}`);
            if (transaction) {
              migration.migrate(db, transaction);
            }
          }
        } catch (error) {
          logger.error('[StorageService] Migration failed:', error);
          (event.target as IDBOpenDBRequest).transaction?.abort();
          reject(error);
        }
      };
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      logger.info('[StorageService] Closing database connection...');
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }

  /**
   * Ensure database is initialized
   */
  private async ensureInit(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.init();
    }
    if (!this.db) {
      throw new Error('Database initialization failed');
    }
    return this.db;
  }

  /**
   * Add or update an entry
   */
  async saveEntry(entry: MemoEntry): Promise<void> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      // Ensure updatedAt is set
      const entryToSave: MemoEntry = {
        ...entry,
        updatedAt: entry.updatedAt || Date.now(),
      };
      
      const request = store.put(entryToSave);

      request.onerror = () => {
        logger.error('[StorageService] Failed to save entry:', request.error);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Failed to save entry'));
      transaction.onabort = () => reject(transaction.error || new Error('Save transaction was aborted'));
    });
  }

  /**
   * Get entries with pagination, ordered by updatedAt (newest first)
   * Uses indexed range queries for O(log n) performance instead of O(n) cursor skipping
   */
  async getEntries(limit: number = 100, offset: number = 0): Promise<MemoEntry[]> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('updatedAt');
      
      const entries: MemoEntry[] = [];
      
      // Use IDBKeyRange to get entries in reverse order (newest first)
      // Since we want newest first, we'll iterate backwards
      const request = index.openCursor(null, 'prev');
      let count = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        
        if (!cursor) {
          resolve(entries);
          return;
        }

        const entry = cursor.value as MemoEntry;
        
        // Skip deleted entries
        if (entry.deletedAt) {
          cursor.continue();
          return;
        }

        // Skip offset entries
        if (count < offset) {
          count++;
          cursor.continue();
          return;
        }

        // Collect entries up to limit
        if (entries.length < limit) {
          entries.push(entry);
          count++;
          cursor.continue();
        } else {
          resolve(entries);
        }
      };

      request.onerror = () => {
        logger.error('[StorageService] Failed to get entries:', request.error);
        reject(new Error('Failed to get entries'));
      };
    });
  }

  /**
   * Get total word count across all non-deleted entries (words dictated, not typed).
   */
  async getTotalWordCount(): Promise<number> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      let total = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) {
          resolve(total);
          return;
        }
        const entry = cursor.value as MemoEntry;
        if (!entry.deletedAt && entry.text) {
          const words = entry.text.trim().split(/\s+/).filter(Boolean);
          total += words.length;
        }
        cursor.continue();
      };

      request.onerror = () => {
        logger.error('[StorageService] Failed to get total word count:', request.error);
        reject(new Error('Failed to get total word count'));
      };
    });
  }

  async getAllActiveEntries(): Promise<MemoEntry[]> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      let entries: MemoEntry[] = [];

      request.onsuccess = () => {
        entries = (request.result as MemoEntry[]).filter((entry) => !entry.deletedAt);
      };
      request.onerror = () => reject(request.error || new Error('Failed to read transcriptions'));
      transaction.oncomplete = () => resolve(entries);
      transaction.onerror = () => reject(transaction.error || new Error('Failed to read transcriptions'));
      transaction.onabort = () => reject(transaction.error || new Error('Read transaction was aborted'));
    });
  }

  /**
   * Delete an entry by ID
   */
  async deleteEntry(id: string): Promise<void> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.delete(id);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Failed to delete entry'));
      transaction.onabort = () => reject(transaction.error || new Error('Delete transaction was aborted'));
    });
  }

  /**
   * Migrate existing entries to new schema format
   * Runs after schema upgrade
   */
  private async migrateDataIfNeeded(): Promise<void> {
    if (!this.db) {
      return;
    }

    const deviceId = await getDeviceId();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => {
        const entries = getAllRequest.result as Array<Record<string, unknown>>;
        const needsMigration = entries.some((entry) => !entry.deviceId);
        
        if (!needsMigration) return;

        logger.info(`[StorageService] Migrating ${entries.length} entries to new schema`);
        const now = Date.now();

        for (const entry of entries) {
          // Skip if already migrated
          if (entry.deviceId) {
            continue;
          }

          const migratedEntry: MemoEntry = {
            id: String(entry.id),
            deviceId,
            text: typeof entry.text === 'string' ? entry.text : '',
            createdAt: typeof entry.timestamp === 'number' ? entry.timestamp : now,
            updatedAt: typeof entry.timestamp === 'number' ? entry.timestamp : now,
            deletedAt: undefined,
            context: {
              source: 'desktop',
              rawTranscript: entry.rawTranscript,
              wasProcessedByLLM: entry.wasProcessedByLLM,
              appContext: entry.appContext,
            },
          };

          store.put(migratedEntry);
        }
      };

      getAllRequest.onerror = () => {
        logger.error('[StorageService] Failed to migrate data:', getAllRequest.error);
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Migration failed'));
      transaction.onabort = () => reject(transaction.error || new Error('Migration was aborted'));
    });
  }
}

// Singleton instance
export const storageService = new StorageService();
