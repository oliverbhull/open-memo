import type { PhraseReplacementRule, ToastData, VoiceCommandSettings } from '../../shared/electron-api';

export interface StoreSchema {
  memoUid: string | null;
  preferBleWhenAvailable: boolean;
  autoReconnect: boolean;
  selectedSystemMicName: string | null;
  lastSystemMicDevice: string | null;
  lastSystemMicSampleRate: number | null;
  postEnter: boolean;
  sayEnterToPressEnter: boolean;
  pushToTalkMode: boolean;
  handsFreeMode: boolean;
  saveAudio: boolean;
  vocabWords: string[];
  phraseReplacements: PhraseReplacementRule[];
  inputSource: 'system' | 'ble' | 'radio';
  autoConnectDeviceName: string | null;
  voiceCommands: VoiceCommandSettings | null;
  userName: string | null;
  onboardedUsers: string[];
  hotkey: string | null;
  _migrationCompleted: boolean;
}

export const storeDefaults: StoreSchema = {
  memoUid: null,
  preferBleWhenAvailable: true,
  autoReconnect: true,
  selectedSystemMicName: null,
  lastSystemMicDevice: null,
  lastSystemMicSampleRate: null,
  postEnter: false,
  sayEnterToPressEnter: false,
  pushToTalkMode: false,
  handsFreeMode: false,
  saveAudio: false,
  vocabWords: [],
  phraseReplacements: [],
  inputSource: 'system',
  autoConnectDeviceName: null,
  voiceCommands: null,
  userName: null,
  onboardedUsers: [],
  hotkey: null,
  _migrationCompleted: false,
};

export type { ToastData };
