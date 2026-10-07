import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';
import { StoreSchema, storeDefaults } from './StoreSchema';
import { clampPhraseReplacementRulesFromInput } from './phraseReplacement';
import { DEFAULT_RECORDING_HOTKEY, normalizeRecordingHotkey } from '../../shared/recordingHotkey';
import type {
  PhraseReplacementRule,
  AsrModelId,
  WritingMode,
} from '../../shared/electron-api';

export type { PhraseReplacementRule };

export interface Settings {
  asrModel: AsrModelId;
  sayEnterToPressEnter: boolean;
  handsFreeMode: boolean;
  saveAudio: boolean;
  writingMode: WritingMode;
  experimentalEmailFormatting: boolean;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
}

export interface UserSettings {
  userName?: string;
  onboardedUsers?: string[];
  hotkey?: string;
  lockHotkey?: string;
}

function boundedString(raw: unknown, maxLength = 200): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().slice(0, maxLength);
  return value || null;
}

function stringArray(raw: unknown, maxItems = 500, maxLength = 200): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((value) => {
    const normalized = boundedString(value, maxLength);
    return normalized ? [normalized] : [];
  }))].slice(0, maxItems);
}

export const store = new Store<StoreSchema>({ defaults: storeDefaults });

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  return {
    asrModel: 'conomo',
    sayEnterToPressEnter: store.get('sayEnterToPressEnter', false),
    handsFreeMode: store.get('handsFreeMode', false),
    saveAudio: store.get('saveAudio', false),
    experimentalEmailFormatting: store.get('experimentalEmailFormatting', false) === true,
    writingMode: store.get('writingMode') === 'clean' ? 'clean' : 'as-spoken',
    vocabWords: stringArray(store.get('vocabWords')),
    phraseReplacements: clampPhraseReplacementRulesFromInput(store.get('phraseReplacements')),
  };
}

export function saveSettings(next: Settings): void {
  const settings: Settings = {
    ...loadSettings(),
    ...next,
    asrModel: 'conomo',
    sayEnterToPressEnter: next.sayEnterToPressEnter === true,
    handsFreeMode: next.handsFreeMode === true,
    saveAudio: next.saveAudio === true,
    experimentalEmailFormatting: next.experimentalEmailFormatting === true,
    writingMode: next.writingMode === 'clean' ? 'clean' : 'as-spoken',
    vocabWords: stringArray(next.vocabWords),
    phraseReplacements: clampPhraseReplacementRulesFromInput(next.phraseReplacements),
  };

  store.set('asrModel', settings.asrModel);
  store.set('sayEnterToPressEnter', settings.sayEnterToPressEnter);
  store.set('handsFreeMode', settings.handsFreeMode);
  store.set('saveAudio', settings.saveAudio);
  store.set('writingMode', settings.writingMode);
  store.set('experimentalEmailFormatting', settings.experimentalEmailFormatting);
  store.set('vocabWords', settings.vocabWords);
  store.set('phraseReplacements', settings.phraseReplacements);
}

export function loadUserSettings(): UserSettings {
  const userName = store.get('userName');
  const hotkey = normalizeRecordingHotkey(store.get('hotkey')) ?? DEFAULT_RECORDING_HOTKEY;
  const onboardedUsers = stringArray(store.get('onboardedUsers'));
  return {
    ...(userName ? { userName } : {}),
    ...(hotkey ? { hotkey } : {}),
    lockHotkey: normalizeRecordingHotkey(store.get('lockHotkey')) ?? 'function+controlleft',
    ...(onboardedUsers.length > 0 ? { onboardedUsers } : {}),
  };
}

export function saveUserSettings(next: UserSettings): void {
  if (next.userName !== undefined) store.set('userName', boundedString(next.userName, 100));
  if (next.hotkey !== undefined) {
    const hotkey = normalizeRecordingHotkey(next.hotkey);
    if (!hotkey) throw new Error('Choose a supported recording key.');
    store.set('hotkey', hotkey);
  }
  if (next.onboardedUsers !== undefined) store.set('onboardedUsers', stringArray(next.onboardedUsers));
  if (next.lockHotkey !== undefined) {
    const hotkey = normalizeRecordingHotkey(next.lockHotkey);
    if (!hotkey) throw new Error('Choose a supported recording lock shortcut.');
    store.set('lockHotkey', hotkey);
  }
}

function migrateSettingsJson(raw: Record<string, unknown>): void {
  const current = loadSettings();
  saveSettings({
    ...current,
    asrModel: 'conomo',
    sayEnterToPressEnter: typeof raw.sayEnterToPressEnter === 'boolean'
      ? raw.sayEnterToPressEnter
      : current.sayEnterToPressEnter,
    handsFreeMode: typeof raw.handsFreeMode === 'boolean' ? raw.handsFreeMode : current.handsFreeMode,
    saveAudio: typeof raw.saveAudio === 'boolean' ? raw.saveAudio : current.saveAudio,
    writingMode: raw.writingMode === 'clean' ? 'clean' : current.writingMode,
    vocabWords: Array.isArray(raw.vocabWords) ? stringArray(raw.vocabWords) : current.vocabWords,
    phraseReplacements: Array.isArray(raw.phraseReplacements)
      ? clampPhraseReplacementRulesFromInput(raw.phraseReplacements)
      : current.phraseReplacements,
  });

  if (typeof raw.autoConnectDeviceName === 'string') {
    const uid = raw.autoConnectDeviceName.match(/memo_([0-9A-Fa-f]{5})/)?.[1];
    if (uid) store.set('memoUid', uid.toUpperCase());
  }
}

function migrateJsonFile(filePath: string, migrate: (raw: Record<string, unknown>) => void): void {
  if (!fs.existsSync(filePath)) return;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  migrate(raw);
  const defaultBackupPath = `${filePath}.backup`;
  const backupPath = fs.existsSync(defaultBackupPath)
    ? `${defaultBackupPath}-${Date.now()}`
    : defaultBackupPath;
  fs.renameSync(filePath, backupPath);
}

export function migrateToElectronStore(): void {
  if (store.get('_migrationCompleted', false)) return;

  try {
    migrateJsonFile(settingsPath(), migrateSettingsJson);
    migrateJsonFile(path.join(os.homedir(), '.memo-web-settings.json'), (raw) => {
      saveUserSettings({
        userName: typeof raw.userName === 'string' ? raw.userName : undefined,
        hotkey: typeof raw.hotkey === 'string'
          ? normalizeRecordingHotkey(raw.hotkey) ?? DEFAULT_RECORDING_HOTKEY
          : undefined,
        onboardedUsers: stringArray(raw.onboardedUsers),
      });
    });
    store.set('_migrationCompleted', true);
  } catch (error) {
    console.error('[Settings] Migration failed; source files were preserved:', error);
  }
}
