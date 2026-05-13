import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

interface AudioManifestEntry {
  entryId: string;
  createdAt: number;
  sizeBytes: number;
  duration?: number; // Duration in seconds
}

interface AudioManifest {
  entries: Record<string, AudioManifestEntry>;
}

export class AudioStorageService {
  private audioDir: string;
  private manifestPath: string;
  private manifest: AudioManifest;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Audio directory: ~/Library/Application Support/Memo/audio/
    const userDataPath = app.getPath('userData');
    this.audioDir = path.join(userDataPath, 'audio');
    this.manifestPath = path.join(userDataPath, 'audio-manifest.json');
    this.manifest = { entries: {} };
  }

  /**
   * Initialize the audio storage service
   * Creates directories and loads the manifest
   */
  async initialize(): Promise<void> {
    try {
      // Create audio directory if it doesn't exist
      if (!existsSync(this.audioDir)) {
        await fs.mkdir(this.audioDir, { recursive: true });
        console.log('[AudioStorage] Created audio directory:', this.audioDir);
      }

      // Load manifest
      await this.loadManifest();

      // Start cleanup job (runs every hour)
      this.startCleanupJob();

      console.log('[AudioStorage] Initialized successfully');
    } catch (error) {
      console.error('[AudioStorage] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Load the manifest from disk
   */
  private async loadManifest(): Promise<void> {
    try {
      if (existsSync(this.manifestPath)) {
        const data = await fs.readFile(this.manifestPath, 'utf-8');
        this.manifest = JSON.parse(data);
        console.log(`[AudioStorage] Loaded manifest with ${Object.keys(this.manifest.entries).length} entries`);
      } else {
        // Create empty manifest
        this.manifest = { entries: {} };
        await this.saveManifest();
        console.log('[AudioStorage] Created new manifest');
      }
    } catch (error) {
      console.error('[AudioStorage] Failed to load manifest:', error);
      // Start with empty manifest on error
      this.manifest = { entries: {} };
    }
  }

  /**
   * Save the manifest to disk
   */
  private async saveManifest(): Promise<void> {
    try {
      await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
    } catch (error) {
      console.error('[AudioStorage] Failed to save manifest:', error);
      throw error;
    }
  }

  /**
   * Save audio buffer to disk
   * @param entryId - The memo entry ID
   * @param audioBuffer - The audio data buffer
   * @param duration - Optional duration in seconds
   */
  async saveAudio(entryId: string, audioBuffer: Buffer, duration?: number): Promise<void> {
    try {
      const audioPath = path.join(this.audioDir, `${entryId}.opus`);

      // Write audio file
      await fs.writeFile(audioPath, audioBuffer);

      // Update manifest
      this.manifest.entries[entryId] = {
        entryId,
        createdAt: Date.now(),
        sizeBytes: audioBuffer.length,
        duration,
      };

      await this.saveManifest();

      console.log(`[AudioStorage] Saved audio for entry ${entryId} (${audioBuffer.length} bytes)`);
    } catch (error) {
      console.error(`[AudioStorage] Failed to save audio for entry ${entryId}:`, error);
      throw error;
    }
  }

  /**
   * Get audio buffer for an entry
   * @param entryId - The memo entry ID
   * @returns Audio buffer or null if not found or expired
   */
  async getAudio(entryId: string): Promise<Buffer | null> {
    try {
      const manifestEntry = this.manifest.entries[entryId];

      // Check if entry exists in manifest
      if (!manifestEntry) {
        console.log(`[AudioStorage] No manifest entry for ${entryId}`);
        return null;
      }

      // Check if expired (48 hours = 172800000 ms)
      const maxAge = 48 * 60 * 60 * 1000;
      const age = Date.now() - manifestEntry.createdAt;
      if (age > maxAge) {
        console.log(`[AudioStorage] Audio expired for entry ${entryId} (age: ${Math.floor(age / 1000 / 60 / 60)}h)`);
        // Delete expired audio
        await this.deleteAudio(entryId);
        return null;
      }

      // Read audio file
      const audioPath = path.join(this.audioDir, `${entryId}.opus`);
      if (!existsSync(audioPath)) {
        console.log(`[AudioStorage] Audio file not found for entry ${entryId}`);
        // Clean up orphaned manifest entry
        delete this.manifest.entries[entryId];
        await this.saveManifest();
        return null;
      }

      const buffer = await fs.readFile(audioPath);
      console.log(`[AudioStorage] Retrieved audio for entry ${entryId} (${buffer.length} bytes)`);
      return buffer;
    } catch (error) {
      console.error(`[AudioStorage] Failed to get audio for entry ${entryId}:`, error);
      return null;
    }
  }

  /**
   * Delete audio for an entry
   * @param entryId - The memo entry ID
   */
  async deleteAudio(entryId: string): Promise<void> {
    try {
      const audioPath = path.join(this.audioDir, `${entryId}.opus`);

      // Delete file if it exists
      if (existsSync(audioPath)) {
        await fs.unlink(audioPath);
        console.log(`[AudioStorage] Deleted audio file for entry ${entryId}`);
      }

      // Remove from manifest
      delete this.manifest.entries[entryId];
      await this.saveManifest();
    } catch (error) {
      console.error(`[AudioStorage] Failed to delete audio for entry ${entryId}:`, error);
      throw error;
    }
  }

  /**
   * Clean up expired audio files (older than maxAgeHours)
   * @param maxAgeHours - Maximum age in hours (default: 48)
   */
  async cleanupExpired(maxAgeHours: number = 48): Promise<void> {
    try {
      const maxAge = maxAgeHours * 60 * 60 * 1000;
      const now = Date.now();
      const expiredEntries: string[] = [];

      // Find expired entries
      for (const [entryId, entry] of Object.entries(this.manifest.entries)) {
        const age = now - entry.createdAt;
        if (age > maxAge) {
          expiredEntries.push(entryId);
        }
      }

      // Delete expired entries
      for (const entryId of expiredEntries) {
        await this.deleteAudio(entryId);
      }

      if (expiredEntries.length > 0) {
        console.log(`[AudioStorage] Cleaned up ${expiredEntries.length} expired audio files`);
      }
    } catch (error) {
      console.error('[AudioStorage] Failed to cleanup expired audio:', error);
    }
  }

  /**
   * Get storage statistics
   * @returns Object with count and total size
   */
  async getStorageStats(): Promise<{ count: number; totalBytes: number; oldestAge: number | null }> {
    const entries = Object.values(this.manifest.entries);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    let oldestAge: number | null = null;
    if (entries.length > 0) {
      const oldestEntry = entries.reduce((oldest, entry) =>
        entry.createdAt < oldest.createdAt ? entry : oldest
      );
      oldestAge = Date.now() - oldestEntry.createdAt;
    }

    return {
      count: entries.length,
      totalBytes,
      oldestAge,
    };
  }

  /**
   * Get all audio entries
   */
  getAllEntries(): AudioManifestEntry[] {
    return Object.values(this.manifest.entries);
  }

  /**
   * Start the cleanup job (runs every hour)
   */
  private startCleanupJob(): void {
    // Run cleanup immediately
    this.cleanupExpired().catch(console.error);

    // Then run every hour
    const oneHour = 60 * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired().catch(console.error);
    }, oneHour);

    console.log('[AudioStorage] Cleanup job started (runs every hour)');
  }

  /**
   * Stop the cleanup job
   */
  stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('[AudioStorage] Cleanup job stopped');
    }
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    this.stopCleanupJob();
    console.log('[AudioStorage] Service shutdown');
  }
}

// Export singleton instance
export const audioStorageService = new AudioStorageService();
