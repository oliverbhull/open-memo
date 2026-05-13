import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import Store from 'electron-store';
import { DEFAULT_APPS } from './DefaultApps';
import { StoreSchema, storeDefaults } from './StoreSchema';

export type CommandAction = 
  | { type: 'applescript'; script: string }
  | { type: 'keystroke'; keys: string }
  | { type: 'url'; template: string };

export interface AppCommand {
  trigger: string;        // Voice trigger: "new tab"
  aliases: string[];      // Alternative triggers: ["open tab", "add tab"]
  action: CommandAction;
}

export interface AppConfig {
  name: string;           // Display name: "Safari"
  bundleId?: string;      // macOS bundle: "com.apple.Safari"
  path?: string;          // App path: "/Applications/Safari.app"
  aliases: string[];      // Voice triggers: ["safari", "web browser"]
  commands: AppCommand[]; // App-specific commands
  enabled: boolean;
}

/** Dictation phrase → literal replacement (fuzzy match on paste path). */
export interface PhraseReplacementRule {
  id: string;
  find: string;
  replace: string;
  enabled?: boolean;
}

export interface Settings {
  postEnter?: boolean;
  sayEnterToPressEnter?: boolean; // When enabled, saying "enter" at end of speech triggers Enter after paste
  pushToTalkMode?: boolean; // When enabled, the Memo device button is hold-to-talk instead of tap-to-toggle
  handsFreeMode?: boolean; // When enabled, VAD starts/stops dictation automatically
  /** User-provided words/phrases to bias STT (Whisper prompt hints). */
  vocabWords?: string[];
  /** Replace spoken phrases with fixed text before paste (case/punctuation-tolerant). */
  phraseReplacements?: PhraseReplacementRule[];
  inputSource?: 'system' | 'ble' | 'radio';
  autoConnectDeviceName?: string | null; // Device name to auto-connect to on startup
  voiceCommands?: {
    enabled: boolean;
    apps: AppConfig[];
    globalCommands: AppCommand[];
    urlPatterns: string[];  // Regex patterns for URL detection
  };
}

function normalizePhraseReplacements(raw: unknown): PhraseReplacementRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PhraseReplacementRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `rule_${i}`;
    const find = typeof r.find === 'string' ? r.find : '';
    const replace = typeof r.replace === 'string' ? r.replace : '';
    const enabled = r.enabled === false ? false : true;
    out.push({ id, find, replace, enabled });
  }
  return out;
}

/**
 * Get the path to the settings file
 */
export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Load settings from disk with defaults
 */
export function loadSettings(): Settings {
  try {
    const p = settingsPath();
    if (fs.existsSync(p)) {
      const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        postEnter: settings.postEnter ?? false,
        sayEnterToPressEnter: settings.sayEnterToPressEnter ?? false,
        pushToTalkMode: settings.pushToTalkMode ?? false,
        handsFreeMode: settings.handsFreeMode ?? false,
        vocabWords: Array.isArray(settings.vocabWords) ? settings.vocabWords : [],
        inputSource: settings.inputSource ?? 'system',
        autoConnectDeviceName: settings.autoConnectDeviceName ?? null,
        voiceCommands: settings.voiceCommands ?? {
          enabled: true,  // Enable by default
          apps: DEFAULT_APPS,
          globalCommands: [],
          urlPatterns: [],
        },
        phraseReplacements: normalizePhraseReplacements(settings.phraseReplacements),
      };
    }
  } catch (e) {
    console.error('[Settings] Failed to load:', e);
  }
  return {
    postEnter: false,
    sayEnterToPressEnter: false,
    pushToTalkMode: false,
    handsFreeMode: false,
    vocabWords: [],
    phraseReplacements: [],
    inputSource: 'system',
    autoConnectDeviceName: null,
    voiceCommands: {
      enabled: true,  // Enable by default
      apps: DEFAULT_APPS,
      globalCommands: [],
      urlPatterns: [],
    },
  };
}

/**
 * Save settings to disk
 */
export function saveSettings(settings: Settings): void {
  try {
    const settingsFile = settingsPath();
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[Settings] Failed to save:', e);
  }
}

/**
 * Initialize electron-store instance
 */
export const store = new Store<StoreSchema>({
  defaults: storeDefaults,
});

/**
 * Migrate from file-based JSON settings to electron-store
 * This runs once on first launch after update
 */
export function migrateToElectronStore(): void {
  const oldSettingsPath = settingsPath();

  // Check if migration already completed
  if (store.get('_migrationCompleted' as any)) {
    return;
  }

  // Check if old settings.json exists
  if (!fs.existsSync(oldSettingsPath)) {
    // No old settings to migrate, mark as complete
    store.set('_migrationCompleted' as any, true);
    return;
  }

  try {
    console.log('[Migration] Starting migration from settings.json to electron-store');
    const oldSettings = JSON.parse(fs.readFileSync(oldSettingsPath, 'utf8'));

    // Extract UID from device name (pattern: memo_<UID>)
    if (oldSettings.autoConnectDeviceName) {
      const uidMatch = oldSettings.autoConnectDeviceName.match(/memo_([0-9A-Fa-f]{5})/);
      if (uidMatch) {
        const uid = uidMatch[1].toUpperCase();
        store.set('memoUid', uid);
        console.log(`[Migration] Extracted UID: ${uid}`);
      }
    }

    // Map inputSource to preferBleWhenAvailable
    if (oldSettings.inputSource === 'ble') {
      store.set('preferBleWhenAvailable', true);
    }

    // Preserve voice commands
    if (oldSettings.voiceCommands) {
      store.set('voiceCommands', oldSettings.voiceCommands);
    }

    // Preserve postEnter
    if (oldSettings.postEnter !== undefined) {
      store.set('postEnter', oldSettings.postEnter);
    }

    // Backup old file
    const backupPath = oldSettingsPath + '.backup';
    fs.renameSync(oldSettingsPath, backupPath);
    console.log(`[Migration] Backed up old settings to ${backupPath}`);

    // Mark migration complete
    store.set('_migrationCompleted' as any, true);
    console.log('[Migration] Migration completed successfully');
  } catch (e) {
    console.error('[Migration] Failed to migrate settings:', e);
    // Don't fail the app, just use defaults
    store.set('_migrationCompleted' as any, true);
  }
}

