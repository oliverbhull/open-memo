import { WebContentsView } from 'electron';
import { loadSettings } from './SettingsService';
import { logger } from '../utils/logger';

export type DictationSound = 'start' | 'stop';

// A rising pair for "listening" and the same pair falling for "stopped".
const NOTES: Record<DictationSound, readonly [number, number]> = {
  start: [523.25, 783.99],
  stop: [783.99, 523.25],
};
const SAMPLE_RATE = 44_100;
const DURATION_SECONDS = 0.24;
const SECOND_NOTE_SECONDS = 0.08;
const ATTACK_SECONDS = 0.004;
const DECAY_SECONDS = 0.04;
const FADE_OUT_SECONDS = 0.01;
// About -16 dBFS. The microphone stays open, so the start sound must stay quiet
// enough that speakers playing it into a recording do not alter the transcript.
const PEAK = 0.16;

function note(frequency: number, time: number): number {
  if (time < 0) return 0;
  const envelope = Math.min(1, time / ATTACK_SECONDS) * Math.exp(-time / DECAY_SECONDS);
  const phase = 2 * Math.PI * frequency * time;
  return envelope * (Math.sin(phase) + 0.2 * Math.sin(2 * phase));
}

/** Render a sound as 16-bit mono PCM WAV. Synthesized so no audio asset has to ship. */
export function dictationSoundWav(sound: DictationSound): Buffer {
  const [first, second] = NOTES[sound];
  const frames = Math.round(DURATION_SECONDS * SAMPLE_RATE);
  const samples = Array.from({ length: frames }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const fadeOut = Math.min(1, (DURATION_SECONDS - time) / FADE_OUT_SECONDS);
    return fadeOut * (note(first, time) + note(second, time - SECOND_NOTE_SECONDS));
  });
  const loudest = Math.max(...samples.map(Math.abs));

  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => {
    wav.writeInt16LE(Math.round((sample / loudest) * PEAK * 32_767), 44 + index * 2);
  });
  return wav;
}

// Not a BrowserWindow: a window that never closes would stop 'window-all-closed'
// from quitting Memo on Windows. The main window cannot play these either, since
// dictation keeps working while it is closed, and the overlay closes on stop.
let player: WebContentsView | null = null;

function playerContents(): Electron.WebContents {
  if (player && !player.webContents.isDestroyed()) {
    if (!player.webContents.isCrashed()) return player.webContents;
    player.webContents.close();
  }
  player = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  const { webContents } = player;
  const clips = (['start', 'stop'] as const).map(sound =>
    [sound, `data:audio/wav;base64,${dictationSoundWav(sound).toString('base64')}`]);
  void webContents.loadURL('about:blank').catch(error => logger.warn('[DictationSound] Could not load player:', error));
  // Decoding ahead keeps the sound on the key press, not noticeably after it.
  void webContents.executeJavaScript(
    `globalThis.sounds = Object.fromEntries(${JSON.stringify(clips)}.map(([name, url]) => [name, new Audio(url)])); 0`,
  ).catch(error => logger.warn('[DictationSound] Could not prepare sounds:', error));
  return webContents;
}

function soundsAllowed(): boolean {
  const { dictationSounds, handsFreeMode } = loadSettings();
  // Hands free starts on speech with the microphone open, so a sound would land
  // on top of the user's words, and the stop sound could start a new recording.
  return dictationSounds && !handsFreeMode;
}

export function prepareDictationSounds(): void {
  if (soundsAllowed()) playerContents();
}

export function playDictationSound(sound: DictationSound): void {
  if (!soundsAllowed()) return;
  playerContents()
    .executeJavaScript(`sounds.${sound}.currentTime = 0; sounds.${sound}.play()`)
    .catch(error => logger.warn('[DictationSound] Could not play sound:', error));
}
