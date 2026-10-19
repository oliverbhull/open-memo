import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export function windowsResourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(process.cwd(), '.build', 'windows');
}
export function windowsDictationPath(): string {
  return path.join(windowsResourceRoot(), 'dictation', 'memo-dictation.exe');
}
export function configureWindowsSpeech(env: NodeJS.ProcessEnv): void {
  const root = windowsResourceRoot();
  env.MEMO_ASR_BACKEND = 'whisper';
  env.MEMO_WHISPER_CLI = path.join(root, 'whisper', 'whisper-cli.exe');
  env.MEMO_WHISPER_MODEL = path.join(root, 'whisper', 'ggml-small.en-q5_1.bin');
  env.STREAMING_TRANSCRIBE = '0';
  for (const file of [windowsDictationPath(), env.MEMO_WHISPER_CLI, env.MEMO_WHISPER_MODEL]) {
    if (!fs.existsSync(file)) throw new Error(`Windows dictation resource is missing: ${file}. Run npm run build:windows:backends.`);
  }
}
