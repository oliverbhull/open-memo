import type { AsrModelId, PhraseReplacementRule, ToastData, WritingMode } from '../../shared/electron-api';

export interface StoreSchema {
  memoUid: string | null;
  desktopDeviceId: string | null;
  selectedSystemMicName: string | null;
  asrModel: AsrModelId;
  lastSystemMicDevice: string | null;
  lastSystemMicSampleRate: number | null;
  sayEnterToPressEnter: boolean;
  handsFreeMode: boolean;
  saveAudio: boolean;
  writingMode: WritingMode;
  experimentalEmailFormatting: boolean;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
  userName: string | null;
  onboardedUsers: string[];
  hotkey: string | null;
  _migrationCompleted: boolean;
  _optionalCleanupMigrationCompleted: boolean;
}

export const storeDefaults: StoreSchema = {
  memoUid: null,
  desktopDeviceId: null,
  selectedSystemMicName: null,
  asrModel: 'conomo',
  lastSystemMicDevice: null,
  lastSystemMicSampleRate: null,
  sayEnterToPressEnter: false,
  handsFreeMode: false,
  saveAudio: false,
  writingMode: 'as-spoken',
  experimentalEmailFormatting: false,
  vocabWords: [],
  phraseReplacements: [],
  userName: null,
  onboardedUsers: [],
  hotkey: null,
  _migrationCompleted: false,
  _optionalCleanupMigrationCompleted: false,
};

export type { ToastData };
