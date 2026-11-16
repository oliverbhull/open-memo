import type { AsrModelId, PhraseReplacementRule, ToastData } from '../../shared/electron-api';

export interface StoreSchema {
  memoUid: string | null;
  desktopDeviceId: string | null;
  overlayAccentColor: string | null;
  selectedSystemMicName: string | null;
  asrModel: AsrModelId;
  windowsSpeechModel: 'whisper-base.en-q5_1' | 'nemotron-streaming' | null;
  lastSystemMicDevice: string | null;
  lastSystemMicSampleRate: number | null;
  sayEnterToPressEnter: boolean;
  handsFreeMode: boolean;
  saveAudio: boolean;
  dictationSounds: boolean;
  experimentalEmailFormatting: boolean;
  groqTextCleanupOptIn: boolean;
  groqApiKeyEncrypted: string | null;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
  userName: string | null;
  onboardedUsers: string[];
  hotkey: string | null;
  lockHotkey: string | null;
  _migrationCompleted: boolean;
}

export const storeDefaults: StoreSchema = {
  memoUid: null,
  desktopDeviceId: null,
  overlayAccentColor: null,
  selectedSystemMicName: null,
  asrModel: 'conomo',
  windowsSpeechModel: null,
  lastSystemMicDevice: null,
  lastSystemMicSampleRate: null,
  sayEnterToPressEnter: false,
  handsFreeMode: false,
  saveAudio: false,
  dictationSounds: true,
  experimentalEmailFormatting: false,
  groqTextCleanupOptIn: false,
  groqApiKeyEncrypted: null,
  vocabWords: [],
  phraseReplacements: [],
  userName: null,
  onboardedUsers: [],
  hotkey: null,
  lockHotkey: null,
  _migrationCompleted: false,
};

export type { ToastData };
