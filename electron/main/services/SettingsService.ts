import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';
import { DEFAULT_APPS } from './DefaultApps';
import { StoreSchema, storeDefaults } from './StoreSchema';
import { clampPhraseReplacementRulesFromInput } from './phraseReplacement';
import type {
  AppCommand,
  AppConfig,
  CommandAction,
  PhraseReplacementRule,
  VoiceCommandSettings,
} from '../../shared/electron-api';

export type { AppCommand, AppConfig, CommandAction, PhraseReplacementRule };

export interface Settings {
  postEnter: boolean;
  sayEnterToPressEnter: boolean;
  pushToTalkMode: boolean;
  handsFreeMode: boolean;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
  inputSource: 'system' | 'ble' | 'radio';
  autoConnectDeviceName: string | null;
  voiceCommands: VoiceCommandSettings;
}

export interface UserSettings {
  userName?: string;
  onboardedUsers?: string[];
  hotkey?: string;
}

const defaultVoiceCommands = (): VoiceCommandSettings => ({
  enabled: true,
  apps: DEFAULT_APPS,
  globalCommands: [],
  urlPatterns: [],
});

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

function normalizeAction(raw: unknown): CommandAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.type === 'keystroke') {
    const keys = boundedString(candidate.keys, 100);
    return keys ? { type: 'keystroke', keys } : null;
  }
  if (candidate.type === 'applescript') {
    const script = boundedString(candidate.script, 10_000);
    return script ? { type: 'applescript', script } : null;
  }
  if (candidate.type === 'url') {
    const template = boundedString(candidate.template, 2_000);
    return template ? { type: 'url', template } : null;
  }
  return null;
}

function normalizeCommands(raw: unknown): AppCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as Record<string, unknown>;
    const trigger = boundedString(candidate.trigger);
    const action = normalizeAction(candidate.action);
    return trigger && action
      ? [{ trigger, aliases: stringArray(candidate.aliases, 25), action }]
      : [];
  }).slice(0, 200);
}

function normalizeApps(raw: unknown): AppConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_APPS;
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as Record<string, unknown>;
    const name = boundedString(candidate.name, 100);
    if (!name) return [];
    const bundleId = boundedString(candidate.bundleId, 200);
    const appPath = boundedString(candidate.path, 1_000);
    return [{
      name,
      ...(bundleId ? { bundleId } : {}),
      ...(appPath ? { path: appPath } : {}),
      aliases: stringArray(candidate.aliases, 25),
      commands: normalizeCommands(candidate.commands),
      enabled: candidate.enabled !== false,
    }];
  }).slice(0, 100);
}

function normalizeVoiceCommands(raw: unknown): VoiceCommandSettings {
  if (!raw || typeof raw !== 'object') return defaultVoiceCommands();
  const candidate = raw as Partial<VoiceCommandSettings>;
  return {
    enabled: candidate.enabled !== false,
    apps: normalizeApps(candidate.apps),
    globalCommands: normalizeCommands(candidate.globalCommands),
    urlPatterns: stringArray(candidate.urlPatterns, 100, 2_000),
  };
}

export const store = new Store<StoreSchema>({ defaults: storeDefaults });

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  return {
    postEnter: store.get('postEnter', false),
    sayEnterToPressEnter: store.get('sayEnterToPressEnter', false),
    pushToTalkMode: store.get('pushToTalkMode', false),
    handsFreeMode: store.get('handsFreeMode', false),
    vocabWords: stringArray(store.get('vocabWords')),
    phraseReplacements: clampPhraseReplacementRulesFromInput(store.get('phraseReplacements')),
    inputSource: ['system', 'ble', 'radio'].includes(store.get('inputSource'))
      ? store.get('inputSource')
      : 'system',
    autoConnectDeviceName: boundedString(store.get('autoConnectDeviceName'), 200),
    voiceCommands: normalizeVoiceCommands(store.get('voiceCommands')),
  };
}

export function saveSettings(next: Settings): void {
  const settings: Settings = {
    ...loadSettings(),
    ...next,
    postEnter: next.postEnter === true,
    sayEnterToPressEnter: next.sayEnterToPressEnter === true,
    pushToTalkMode: next.pushToTalkMode === true,
    handsFreeMode: next.handsFreeMode === true,
    vocabWords: stringArray(next.vocabWords),
    phraseReplacements: clampPhraseReplacementRulesFromInput(next.phraseReplacements),
    inputSource: ['system', 'ble', 'radio'].includes(next.inputSource) ? next.inputSource : 'system',
    autoConnectDeviceName: boundedString(next.autoConnectDeviceName, 200),
    voiceCommands: normalizeVoiceCommands(next.voiceCommands),
  };

  store.set('postEnter', settings.postEnter);
  store.set('sayEnterToPressEnter', settings.sayEnterToPressEnter);
  store.set('pushToTalkMode', settings.pushToTalkMode);
  store.set('handsFreeMode', settings.handsFreeMode);
  store.set('vocabWords', settings.vocabWords);
  store.set('phraseReplacements', settings.phraseReplacements);
  store.set('inputSource', settings.inputSource);
  store.set('autoConnectDeviceName', settings.autoConnectDeviceName);
  store.set('voiceCommands', settings.voiceCommands);
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
    postEnter: typeof raw.postEnter === 'boolean' ? raw.postEnter : current.postEnter,
    sayEnterToPressEnter: typeof raw.sayEnterToPressEnter === 'boolean'
      ? raw.sayEnterToPressEnter
      : current.sayEnterToPressEnter,
    pushToTalkMode: typeof raw.pushToTalkMode === 'boolean' ? raw.pushToTalkMode : current.pushToTalkMode,
    handsFreeMode: typeof raw.handsFreeMode === 'boolean' ? raw.handsFreeMode : current.handsFreeMode,
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
    voiceCommands: raw.voiceCommands ? normalizeVoiceCommands(raw.voiceCommands) : current.voiceCommands,
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
