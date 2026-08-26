/** Canonical feed record stored in Memo's desktop SQLite database. */
export interface MemoEntry {
  id: string;
  deviceId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  context?: Record<string, unknown>;
}
