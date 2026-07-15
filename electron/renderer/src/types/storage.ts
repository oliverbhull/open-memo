export const DB_NAME = 'memo-web-db';
// DB_VERSION should match the latest migration version
// Update this when adding new migrations
export const DB_VERSION = 2; // Incremented for minimal schema migration
export const STORE_NAME = 'entries';

/** Portable memo entry schema. Context preserves source-specific metadata. */
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

  // Source-specific data
  context?: Record<string, unknown>;
}
