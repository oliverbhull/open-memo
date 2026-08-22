import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';
import { StoreSchema, storeDefaults } from './StoreSchema';
import { clampPhraseReplacementRulesFromInput } from './phraseReplacement';
import type {
  PhraseReplacementRule,
  AsrModelId,
} from '../../shared/electron-api';

export type { PhraseReplacementRule };

export interface Settings {
  asrModel: AsrModelId;
  postEnter: boolean;
  sayEnterToPressEnter: boolean;
  pushToTalkMode: boolean;
  handsFreeMode: boolean;
  saveAudio: boolean;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
  inputSource: 'system' | 'ble' | 'radio';
  autoConnectDeviceName: string | null;
}

export interface UserSettings {
  userName?: string;
  onboardedUsers?: string[];
  hotkey?: string;
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
    asrModel: store.get('asrModel') === 'whisper' ? 'whisper' : 'nemotron',
    postEnter: store.get('postEnter', false),
    sayEnterToPressEnter: store.get('sayEnterToPressEnter', false),
    pushToTalkMode: store.get('pushToTalkMode', false),
    handsFreeMode: store.get('handsFreeMode', false),
    saveAudio: store.get('saveAudio', false),
    vocabWords: stringArray(store.get('vocabWords')),
    phraseReplacements: clampPhraseReplacementRulesFromInput(store.get('phraseReplacements')),
    inputSource: ['system', 'ble', 'radio'].includes(store.get('inputSource'))
      ? store.get('inputSource')
      : 'system',
    autoConnectDeviceName: boundedString(store.get('autoConnectDeviceName'), 200),
  };
}

export function saveSettings(next: Settings): void {
  const settings: Settings = {
    ...loadSettings(),
    ...next,
    asrModel: next.asrModel === 'whisper' ? 'whisper' : 'nemotron',
    postEnter: next.postEnter === true,
    sayEnterToPressEnter: next.sayEnterToPressEnter === true,
    pushToTalkMode: next.pushToTalkMode === true,
    handsFreeMode: next.handsFreeMode === true,
    saveAudio: next.saveAudio === true,
    vocabWords: stringArray(next.vocabWords),
    phraseReplacements: clampPhraseReplacementRulesFromInput(next.phraseReplacements),
    inputSource: ['system', 'ble', 'radio'].includes(next.inputSource) ? next.inputSource : 'system',
    autoConnectDeviceName: boundedString(next.autoConnectDeviceName, 200),
  };

  store.set('asrModel', settings.asrModel);
  store.set('postEnter', settings.postEnter);
  store.set('sayEnterToPressEnter', settings.sayEnterToPressEnter);
  store.set('pushToTalkMode', settings.pushToTalkMode);
  store.set('handsFreeMode', settings.handsFreeMode);
  store.set('saveAudio', settings.saveAudio);
  store.set('vocabWords', settings.vocabWords);
  store.set('phraseReplacements', settings.phraseReplacements);
  store.set('inputSource', settings.inputSource);
  store.set('autoConnectDeviceName', settings.autoConnectDeviceName);
}

export function loadUserSettings(): UserSettings {
  const userName = store.get('userName');
  const hotkey = store.get('hotkey');
  const onboardedUsers = stringArray(store.get('onboardedUsers'));
  return {
    ...(userName ? { userName } : {}),
    ...(hotkey ? { hotkey } : {}),
    ...(onboardedUsers.length > 0 ? { onboardedUsers } : {}),
  };
}

export function saveUserSettings(next: UserSettings): void {
  if (next.userName !== undefined) store.set('userName', boundedString(next.userName, 100));
  if (next.hotkey !== undefined) store.set('hotkey', boundedString(next.hotkey, 100));
  if (next.onboardedUsers !== undefined) store.set('onboardedUsers', stringArray(next.onboardedUsers));
}

function migrateSettingsJson(raw: Record<string, unknown>): void {
  const current = loadSettings();
  saveSettings({
    ...current,
    asrModel: raw.asrModel === 'whisper' || raw.asrModel === 'nemotron'
      ? raw.asrModel
      : current.asrModel,
    postEnter: typeof raw.postEnter === 'boolean' ? raw.postEnter : current.postEnter,
    sayEnterToPressEnter: typeof raw.sayEnterToPressEnter === 'boolean'
      ? raw.sayEnterToPressEnter
      : current.sayEnterToPressEnter,
    pushToTalkMode: typeof raw.pushToTalkMode === 'boolean' ? raw.pushToTalkMode : current.pushToTalkMode,
    handsFreeMode: typeof raw.handsFreeMode === 'boolean' ? raw.handsFreeMode : current.handsFreeMode,
    saveAudio: typeof raw.saveAudio === 'boolean' ? raw.saveAudio : current.saveAudio,
    vocabWords: Array.isArray(raw.vocabWords) ? stringArray(raw.vocabWords) : current.vocabWords,
    phraseReplacements: Array.isArray(raw.phraseReplacements)
      ? clampPhraseReplacementRulesFromInput(raw.phraseReplacements)
      : current.phraseReplacements,
    inputSource: raw.inputSource === 'ble' || raw.inputSource === 'radio' || raw.inputSource === 'system'
      ? raw.inputSource
      : current.inputSource,
    autoConnectDeviceName: typeof raw.autoConnectDeviceName === 'string'
      ? raw.autoConnectDeviceName
      : current.autoConnectDeviceName,
  });

  if (typeof raw.autoConnectDeviceName === 'string') {
    const uid = raw.autoConnectDeviceName.match(/memo_([0-9A-Fa-f]{5})/)?.[1];
    if (uid) store.set('memoUid', uid.toUpperCase());
  }
  if (raw.inputSource === 'ble') store.set('preferBleWhenAvailable', true);
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
        hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : undefined,
        onboardedUsers: stringArray(raw.onboardedUsers),
      });
    });
    store.set('_migrationCompleted', true);
  } catch (error) {
    console.error('[Settings] Migration failed; source files were preserved:', error);
  }
}
