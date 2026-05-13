import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { logger } from '../utils/logger';

export interface RecordedKeystroke {
  modifiers: string[];
  key: string;
  formatted: string;
}

export class KeystrokeRecorder extends EventEmitter {
  private isRecording = false;
  private recordingProcess: ReturnType<typeof spawn> | null = null;
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
    // Use AppleScript with System Events to monitor keyboard events
    // This script will run in a loop and capture key presses
    const script = `
      tell application "System Events"
        repeat
          try
            set keyCode to (do shell script "read -n 1 -t 0.1 key < /dev/tty 2>/dev/null || echo ''")
            if keyCode is not "" then
              log keyCode
            end if
          end try
        end repeat
      end tell
    `;

    // Actually, a simpler approach: we'll use a background AppleScript
    // that monitors key events. However, AppleScript can't easily monitor
    // all keyboard events without a helper application.
    
    // For now, we'll emit a ready event and wait for manual keystroke recording
    // via the recordKeystroke method (called from IPC when user presses keys)
    
    logger.info('[KeystrokeRecorder] macOS recording started - waiting for keystrokes');
    this.emit('recording-started');
  }

  stopRecording(): RecordedKeystroke | null {
    if (!this.isRecording) {
      logger.warn('[KeystrokeRecorder] Not recording');
      return null;
    }

    this.isRecording = false;

    if (this.recordingProcess) {
      this.recordingProcess.kill();
      this.recordingProcess = null;
    }

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

  // Helper method to parse a keystroke string back to components
  static parseKeystroke(keystroke: string): { modifiers: string[]; key: string } {
    const parts = keystroke.toLowerCase().split('+');
    const key = parts.pop() || '';
    const modifiers = parts.map(m => {
      switch (m) {
        case 'cmd':
        case 'command':
          return 'command';
        case 'shift':
          return 'shift';
        case 'alt':
        case 'option':
          return 'option';
        case 'ctrl':
        case 'control':
          return 'control';
        default:
          return m;
      }
    });

    return { modifiers, key };
  }
}
