/**
 * IndexedDB migration system
 * Each migration is a function that upgrades the database schema
 */

import { DB_NAME, DB_VERSION, STORE_NAME } from '../types/storage';
import { logger } from '../utils/logger';

export type MigrationFunction = (db: IDBDatabase, transaction: IDBTransaction) => void | Promise<void>;

export interface Migration {
  version: number;
  migrate: MigrationFunction;
  description: string;
}

/**
 * Migration definitions
 * Add new migrations here when schema changes are needed
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema - entries store with timestamp and appName indexes',
    migrate: (db: IDBDatabase, transaction: IDBTransaction) => {
      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // Create indexes for efficient queries
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('appName', 'appContext.appName', { unique: false });
      }
    },
  },
  {
    version: 2,
    description: 'Migrate to minimal schema with context field and sync metadata',
    migrate: (db: IDBDatabase, transaction: IDBTransaction) => {
      // Check if store exists
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Create new store with new schema
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('deviceId', 'deviceId', { unique: false });
        return;
      }

      // Get store - it should exist if we're migrating
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        logger.warn('Store does not exist during migration, creating new store');
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('deviceId', 'deviceId', { unique: false });
        return;
      }

      const store = transaction.objectStore(STORE_NAME);
      
      // Remove old indexes if they exist (must be done synchronously in transaction)
      const indexNames = Array.from(store.indexNames);
      for (const indexName of indexNames) {
        if (indexName === 'timestamp' || indexName === 'appName') {
          try {
            store.deleteIndex(indexName);
          } catch (e) {
            // Index might already be deleted, that's okay
            logger.debug(`Index ${indexName} already removed or doesn't exist`);
          }
        }
      }
      
      // Create new indexes (must be done synchronously in transaction)
      const existingIndexes = Array.from(store.indexNames);
      
      if (!existingIndexes.includes('updatedAt')) {
        try {
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        } catch (e) {
          logger.error('Failed to create updatedAt index:', e);
          throw e; // Re-throw to fail the migration
        }
      }
      
      if (!existingIndexes.includes('createdAt')) {
        try {
          store.createIndex('createdAt', 'createdAt', { unique: false });
        } catch (e) {
          logger.error('Failed to create createdAt index:', e);
          throw e;
        }
      }
      
      if (!existingIndexes.includes('deviceId')) {
        try {
          store.createIndex('deviceId', 'deviceId', { unique: false });
        } catch (e) {
          logger.error('Failed to create deviceId index:', e);
          throw e;
        }
      }
      
      // Data migration will happen after schema upgrade in StorageService
    },
  },
];

/**
 * Get the latest migration version
 */
export function getLatestVersion(): number {
  return migrations.length > 0 ? Math.max(...migrations.map(m => m.version)) : 1;
}

/**
 * Get migrations that need to run between oldVersion and newVersion
 */
export function getMigrationsToRun(oldVersion: number, newVersion: number): Migration[] {
  return migrations.filter(
    migration => migration.version > oldVersion && migration.version <= newVersion
  );
}


