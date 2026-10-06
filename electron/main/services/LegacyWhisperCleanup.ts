import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { store } from './SettingsService';
import { logger } from '../utils/logger';

/** Remove the optional Whisper download left by older Memo versions. */
export async function removeLegacyWhisperModel(): Promise<void> {
  if (store.get('asrModel') !== 'conomo') store.set('asrModel', 'conomo');
  const directory = path.join(app.getPath('userData'), 'models', 'whisper');
  if (!fs.existsSync(directory)) return;
  await fs.promises.rm(directory, { recursive: true, force: true });
  logger.info('[Main] Removed legacy Whisper download');
}
