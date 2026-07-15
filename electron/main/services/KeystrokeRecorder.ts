import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface RecordedKeystroke {
  modifiers: string[];
  key: string;
  formatted: string;
}

export class KeystrokeRecorder extends EventEmitter {
  private isRecording = false;
  private recordedKeystrokes: RecordedKeystroke[] = [];

  startRecording(): void {
    if (this.isRecording) {
      logger.warn('[KeystrokeRecorder] Already recording');
      return;
    }

    this.isRecording = true;
    this.recordedKeystrokes = [];

    logger.info('[KeystrokeRecorder] Starting keystroke recording');

    // On macOS, we'll use AppleScript to monitor keyboard events
    if (process.platform === 'darwin') {
      this.startMacOSRecording();
    } else {
      logger.warn('[KeystrokeRecorder] Keystroke recording not supported on this platform');
      this.emit('error', new Error('Keystroke recording not supported on this platform'));
    }
  }

  private startMacOSRecording(): void {
    // Renderer key events are forwarded through the narrow preload API.
    logger.info('[KeystrokeRecorder] macOS recording started - waiting for keystrokes');
    this.emit('recording-started');
  }

  stopRecording(): RecordedKeystroke | null {
    if (!this.isRecording) {
      logger.warn('[KeystrokeRecorder] Not recording');
      return null;
    }

    this.isRecording = false;

    logger.info('[KeystrokeRecorder] Stopped recording');

    // Return the last recorded keystroke
    const lastKeystroke = this.recordedKeystrokes[this.recordedKeystrokes.length - 1];
    this.emit('recording-stopped', lastKeystroke);
    
    return lastKeystroke || null;
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  // Method to manually record a keystroke (called from IPC handler)
  // This will be called when the renderer detects a key press
  recordKeystroke(modifiers: string[], key: string): void {
    if (!this.isRecording) {
      return;
    }

    const formatted = this.formatKeystroke(modifiers, key);
    const keystroke: RecordedKeystroke = {
      modifiers: [...modifiers],
      key,
      formatted,
    };

    // Only keep the most recent keystroke (or we could keep all)
    this.recordedKeystrokes = [keystroke];
    logger.debug(`[KeystrokeRecorder] Recorded: ${formatted}`);
    
    this.emit('keystroke-recorded', keystroke);
  }

  private formatKeystroke(modifiers: string[], key: string): string {
    // Format as "cmd+t", "shift+cmd+n", etc.
    const modifierMap: Record<string, string> = {
      command: 'cmd',
      cmd: 'cmd',
      shift: 'shift',
      option: 'alt',
      alt: 'alt',
      control: 'ctrl',
      ctrl: 'ctrl',
    };

    const normalizedModifiers = modifiers
      .map(m => {
        const lower = m.toLowerCase();
        return modifierMap[lower] || lower;
      })
      .filter((v, i, a) => a.indexOf(v) === i) // Remove duplicates
      .sort((a, b) => {
        // Sort modifiers in a consistent order: cmd, shift, alt, ctrl
        const order = ['cmd', 'shift', 'alt', 'ctrl'];
        const aIndex = order.indexOf(a);
        const bIndex = order.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return 0;
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });

    const keyLower = key.toLowerCase();
    
    if (normalizedModifiers.length > 0) {
      return `${normalizedModifiers.join('+')}+${keyLower}`;
    }
    return keyLower;
  }

}
