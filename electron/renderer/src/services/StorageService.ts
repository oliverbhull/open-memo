import { LEGACY_DB_NAME, LEGACY_STORE_NAME, type MemoEntry } from '../types/storage';
import { logger } from '../utils/logger';
import { getDeviceId } from './DeviceIdService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeLegacyMemoEntries(
  rawEntries: Array<Record<string, unknown>>,
  deviceId: string,
  now = Date.now(),
): MemoEntry[] {
  return rawEntries.map((entry, index): MemoEntry => {
    const id = typeof entry.id === 'string' ? entry.id : '';
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!id || !text) {
      throw new Error(`Legacy IndexedDB entry ${index} is malformed`);
    }
    const timestamp = typeof entry.timestamp === 'number' && entry.timestamp > 0
      ? entry.timestamp
      : now;
    const createdAt = typeof entry.createdAt === 'number' && entry.createdAt > 0
      ? entry.createdAt
      : timestamp;
    const updatedAt = typeof entry.updatedAt === 'number' && entry.updatedAt > 0
      ? entry.updatedAt
      : createdAt;
    const context = isRecord(entry.context)
      ? entry.context
      : {
          source: 'desktop',
          rawTranscript: entry.rawTranscript,
          wasProcessedByLLM: entry.wasProcessedByLLM,
          appContext: entry.appContext,
        };
    return {
      id,
      deviceId: typeof entry.deviceId === 'string' && entry.deviceId ? entry.deviceId : deviceId,
      text,
      createdAt,
      updatedAt,
      ...(typeof entry.deletedAt === 'number' && entry.deletedAt > 0
        ? { deletedAt: entry.deletedAt }
        : {}),
      context,
    };
  });
}

/**
 * Renderer facade for the canonical SQLite entry store. IndexedDB is opened
 * read-only once, solely to preserve and import records created by older builds.
 */
export class StorageService {
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const state = await window.electronAPI.entries.initialize();
    if (!state.legacyImportComplete) {
      const legacyEntries = await this.readLegacyEntries();
      const result = await window.electronAPI.entries.importLegacy(legacyEntries);
      logger.info(`[StorageService] Imported ${result.imported} legacy IndexedDB entries into SQLite`);
    }
    this.initialized = true;
    logger.info('[StorageService] Canonical SQLite database is ready');
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init();
    if (!this.initialized) throw new Error('Database initialization failed');
  }

  async saveEntry(entry: MemoEntry): Promise<void> {
    await this.ensureInit();
    await window.electronAPI.entries.save({
      ...entry,
      updatedAt: entry.updatedAt || Date.now(),
    });
  }

  async getEntry(id: string): Promise<MemoEntry | null> {
    await this.ensureInit();
    return window.electronAPI.entries.get(id);
  }

  async getEntries(limit = 100, offset = 0): Promise<MemoEntry[]> {
    await this.ensureInit();
    return window.electronAPI.entries.list(limit, offset);
  }

  async getTotalWordCount(): Promise<number> {
    await this.ensureInit();
    return window.electronAPI.entries.getTotalWordCount();
  }

  async getAllActiveEntries(): Promise<MemoEntry[]> {
    await this.ensureInit();
    return window.electronAPI.entries.getAllActive();
  }

  private async readLegacyEntries(): Promise<MemoEntry[]> {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === LEGACY_DB_NAME)) return [];
    }

    const rawEntries = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onerror = () => reject(request.error || new Error('Failed to open legacy IndexedDB'));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
          database.close();
          resolve([]);
          return;
        }
        const transaction = database.transaction([LEGACY_STORE_NAME], 'readonly');
        const getAll = transaction.objectStore(LEGACY_STORE_NAME).getAll();
        let entries: Array<Record<string, unknown>> = [];
        getAll.onsuccess = () => {
          entries = getAll.result.filter(isRecord);
        };
        getAll.onerror = () => reject(getAll.error || new Error('Failed to read legacy entries'));
        transaction.oncomplete = () => {
          database.close();
          resolve(entries);
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error || new Error('Failed to read legacy entries'));
        };
        transaction.onabort = transaction.onerror;
      };
    });

    return normalizeLegacyMemoEntries(rawEntries, await getDeviceId());
  }
}

export const storageService = new StorageService();
