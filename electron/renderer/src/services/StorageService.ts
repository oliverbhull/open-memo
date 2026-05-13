import { DB_NAME, DB_VERSION, STORE_NAME, StoredEntry, MemoEntry } from '../types/storage';
import { logger } from '../utils/logger';
import { getMigrationsToRun, migrations } from './migrations';
import { getDeviceId } from './DeviceIdService';

// Ensure storage API is available
declare global {
  interface Window {
    electronAPI?: {
      storage?: {
        clearIndexedDB: () => Promise<boolean>;
      };
    };
  }
}

export class StorageService {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly isDev = process.env.NODE_ENV === 'development' || 
                           (typeof window !== 'undefined' && window.location.hostname === 'localhost');
  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly INITIAL_RETRY_DELAY = 100; // Start with 100ms
  private readonly MAX_RETRY_DELAY = 5000; // Cap at 5 seconds

  /**
   * Initialize the IndexedDB database with retry logic
   */
  async init(attempt: number = 0): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise && attempt === 0) {
      return this.initPromise;
    }

    // If this is a retry, create a new promise
    if (attempt > 0) {
      this.initPromise = null;
    }

    this.initPromise = this.initWithRetry(attempt);
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
                         (error as any)?.name === 'UnknownError';
      
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
        const errorName = (error as any).name || '';
        
        logger.error(`[StorageService] Failed to open IndexedDB:`, {
          name: errorName,
          message: errorMessage,
          error: error
        });
        
        // Check for corruption or LOCK file issues
        const isCorruptionError = errorName === 'UnknownError' && 
                                   (errorMessage.includes('backing store') || 
                                    errorMessage.includes('LOCK'));
        
        if (isCorruptionError) {
          logger.warn(`[StorageService] Detected database corruption/lock error, attempting recovery...`);
          const isDev = process.env.NODE_ENV === 'development' || 
                       (typeof window !== 'undefined' && window.location.hostname === 'localhost');
          
          logger.warn(`Database error detected${isDev ? ' (dev mode)' : ''}, attempting to clear...`);
          
          // Handle async clear operation
          (async () => {
            try {
              // Use Electron's session API to clear IndexedDB (more powerful than deleteDatabase)
              if (window.electronAPI?.storage?.clearIndexedDB) {
                await window.electronAPI.storage.clearIndexedDB();
                logger.info('IndexedDB cleared via session API, recreating...');
                
                // Wait longer in dev mode for file system operations
                const waitTime = isDev ? 1000 : 200;
                await new Promise(resolve => setTimeout(resolve, waitTime));
                
                // Retry opening after clearing
                const retryRequest = indexedDB.open(DB_NAME, DB_VERSION);
                
                retryRequest.onsuccess = () => {
                  this.db = retryRequest.result;
                  resolve();
                };
                
                retryRequest.onerror = () => {
                  const retryError = retryRequest.error;
                  logger.error('Failed to recreate database after clear:', retryError);
                  
                  // In dev mode, if it still fails, suggest restarting
                  if (isDev) {
                    logger.warn('Database still corrupted after clear. In dev mode, try:');
                    logger.warn('1. Close all instances of the app');
                    logger.warn('2. Delete: ~/Library/Application Support/memo-web/IndexedDB');
                    logger.warn('3. Restart the app');
                  }
                  
                  reject(new Error('Failed to recreate database after clear. Please restart the app.'));
                };
                
                retryRequest.onupgradeneeded = (event) => {
                  const db = (event.target as IDBOpenDBRequest).result;
                  const transaction = (event.target as IDBOpenDBRequest).transaction;
                  const migrationsToRun = getMigrationsToRun(0, DB_VERSION);
                  
                  for (const migration of migrationsToRun) {
                    if (transaction) {
                      try {
                        migration.migrate(db, transaction);
                      } catch (migrationError) {
                        logger.error(`Migration ${migration.version} failed:`, migrationError);
                        // Continue with other migrations
                      }
                    }
                  }
                };
                
                return;
              }
            } catch (clearError) {
              logger.error('Failed to clear IndexedDB via session API:', clearError);
            }
            
            // Fallback: try deleteDatabase (may not work if database is too corrupted)
            logger.warn('Falling back to deleteDatabase...');
            const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
            
            deleteRequest.onsuccess = () => {
              logger.info('Database deleted, recreating...');
              // Retry opening after deletion
              const retryRequest = indexedDB.open(DB_NAME, DB_VERSION);
              
              retryRequest.onsuccess = () => {
                this.db = retryRequest.result;
                resolve();
              };
              
              retryRequest.onerror = () => {
                logger.error('Failed to recreate database:', retryRequest.error);
                reject(new Error('Failed to recreate database'));
              };
              
              retryRequest.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const transaction = (event.target as IDBOpenDBRequest).transaction;
                const migrationsToRun = getMigrationsToRun(0, DB_VERSION);
                
                for (const migration of migrationsToRun) {
                  if (transaction) {
                    try {
                      migration.migrate(db, transaction);
                    } catch (migrationError) {
                      logger.error(`Migration ${migration.version} failed:`, migrationError);
                    }
                  }
                }
              };
            };
            
            deleteRequest.onerror = () => {
              logger.error('Failed to delete corrupted database:', deleteRequest.error);
              reject(new Error('Database is corrupted. Please restart the app to clear it automatically.'));
            };
            
            deleteRequest.onblocked = () => {
              logger.warn('Database deletion blocked, please close other tabs/windows');
              reject(new Error('Database deletion blocked'));
            };
          })();
          
          return;
        }
        
        // Reject with error that will trigger retry logic if it's a lock error
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
          // Don't reject - schema is upgraded, data migration can retry later
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

      request.onsuccess = () => resolve();
      request.onerror = () => {
        logger.error('[StorageService] Failed to save entry:', request.error);
        reject(new Error('Failed to save entry'));
      };
    });
  }

  /**
   * Get an entry by ID
   */
  async getEntry(id: string): Promise<MemoEntry | null> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        const entry = request.result as MemoEntry | undefined;
        // Don't return deleted entries
        if (entry && !entry.deletedAt) {
          resolve(entry);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => {
        logger.error('[StorageService] Failed to get entry:', request.error);
        reject(new Error('Failed to get entry'));
      };
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

  /**
   * Get total count of entries
   */
  async getEntryCount(): Promise<number> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        logger.error('[StorageService] Failed to get entry count:', request.error);
        reject(new Error('Failed to get entry count'));
      };
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
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => {
        logger.error('[StorageService] Failed to delete entry:', request.error);
        reject(new Error('Failed to delete entry'));
      };
    });
  }

  /**
   * Clear all entries (use with caution)
   */
  async clearAll(): Promise<void> {
    const db = await this.ensureInit();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => {
        logger.error('[StorageService] Failed to clear entries:', request.error);
        reject(new Error('Failed to clear entries'));
      };
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

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = async () => {
        const entries = getAllRequest.result;
        const needsMigration = entries.some((e: any) => !e.deviceId);
        
        if (!needsMigration) {
          resolve();
          return;
        }

        logger.info(`[StorageService] Migrating ${entries.length} entries to new schema`);
        const deviceId = await getDeviceId();
        const now = Date.now();

        for (const entry of entries) {
          // Skip if already migrated
          if (entry.deviceId) {
            continue;
          }

          const migratedEntry: MemoEntry = {
            id: entry.id,
            deviceId,
            text: entry.text,
            createdAt: entry.timestamp || now,
            updatedAt: entry.timestamp || now,
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

        resolve();
      };

      getAllRequest.onerror = () => {
        logger.error('[StorageService] Failed to migrate data:', getAllRequest.error);
        reject(getAllRequest.error);
      };
    });
  }
}

// Singleton instance
export const storageService = new StorageService();


