export const DB_NAME = 'memo-web-db';
// DB_VERSION should match the latest migration version
// Update this when adding new migrations
export const DB_VERSION = 2; // Incremented for minimal schema migration
export const STORE_NAME = 'entries';

/**
 * Minimal memo entry schema for sync
 * Context field is opaque to sync layer - each app writes what it knows
 */
export interface MemoEntry {
  // Identity
  id: string;
  deviceId: string;

  // Content
  text: string;

  // Time
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;

  // Audio (premium feature)
  hasAudio?: boolean;
  audioDuration?: number; // Duration in seconds
  audioExpiresAt?: number; // Timestamp when audio will be deleted (48h from creation)

  // Platform-specific data - opaque to sync layer
  context?: Record<string, unknown>;
}

// Legacy type for backward compatibility during migration
export interface StoredEntry extends MemoEntry {
  // This will be removed after migration
}

export interface StorageSchema {
  version: number;
  stores: {
    entries: {
      keyPath: 'id';
      indexes: {
        updatedAt: { keyPath: 'updatedAt'; unique: false };
        createdAt: { keyPath: 'createdAt'; unique: false };
        deviceId: { keyPath: 'deviceId'; unique: false };
      };
    };
  };
}


