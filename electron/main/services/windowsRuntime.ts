import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export function windowsResourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(process.cwd(), '.build', 'windows');
}
export function windowsDictationPath(): string {
  return path.join(windowsResourceRoot(), 'dictation', 'memo-dictation.exe');
}
type WindowsModel = 'base.en-q5_1' | 'small.en-q5_1';
export type WindowsModelId = `whisper-${WindowsModel}` | 'whisper-custom';
function selectedWindowsModel(env: NodeJS.ProcessEnv): { file: string; id: WindowsModelId } {
  const directory = path.join(windowsResourceRoot(), 'whisper');
  if (env.MEMO_WHISPER_MODEL) {
    const basename = path.basename(env.MEMO_WHISPER_MODEL);
    const id: WindowsModelId = basename === 'ggml-base.en-q5_1.bin' ? 'whisper-base.en-q5_1'
      : basename === 'ggml-small.en-q5_1.bin' ? 'whisper-small.en-q5_1' : 'whisper-custom';
    return { file: env.MEMO_WHISPER_MODEL, id };
  }
  let model: WindowsModel = 'small.en-q5_1';
  const profile = path.join(directory, 'local-profile.json');
  if (fs.existsSync(profile)) {
    const choice = JSON.parse(fs.readFileSync(profile, 'utf8'));
    if (choice?.model !== 'base.en-q5_1' && choice?.model !== 'small.en-q5_1') {
      throw new Error(`Invalid Windows speech model in ${profile}. Choose base.en-q5_1 or small.en-q5_1.`);
    }
    model = choice.model;
  }
  return { file: path.join(directory, `ggml-${model}.bin`), id: `whisper-${model}` };
}
export function windowsWhisperModelId(): WindowsModelId {
  return selectedWindowsModel(process.env).id;
}
/** Only an explicit user preference overrides the Windows streaming default. */
export function resolveWindowsSpeechModel(preference: unknown): 'whisper-base.en-q5_1' | 'nemotron-streaming' {
  return preference === 'whisper-base.en-q5_1' ? preference : 'nemotron-streaming';
}
export function configureWindowsSpeech(env: NodeJS.ProcessEnv, selected: string = resolveWindowsSpeechModel(undefined)): void {
  const root = windowsResourceRoot();
  const nemotron = selected === 'nemotron-streaming';
  env.MEMO_ASR_BACKEND = nemotron ? 'nemotron' : 'whisper';
  env.MEMO_NEMOTRON_WORKER = path.join(root, 'nemotron', 'memo-nemotron-worker.exe');
  env.MEMO_NEMOTRON_MODEL = path.join(root, 'nemotron', 'nemotron-en-q8.gguf');
  env.MEMO_WHISPER_WORKER = path.join(root, 'whisper', 'memo-whisper-worker.exe');
  env.MEMO_WHISPER_MODEL = nemotron || selected === 'whisper-base.en-q5_1' ? path.join(root, 'whisper', 'ggml-base.en-q5_1.bin') : selectedWindowsModel(env).file;
  env.STREAMING_TRANSCRIBE = nemotron ? '1' : '0';
  for (const file of [windowsDictationPath(), env.MEMO_WHISPER_WORKER, env.MEMO_WHISPER_MODEL]) {
    if (!fs.existsSync(file)) throw new Error(`Windows dictation resource is missing: ${file}. Run npm run build:windows:backends.`);
  }
}
