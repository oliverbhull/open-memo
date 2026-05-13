import { execFileSync } from 'node:child_process';

/**
 * Mute the default macOS audio output while dictating so playback from any app
 * (Safari/YouTube, Chrome, Spotify, Music, etc.) is not heard — including the
 * distorted “mixed” sound common on Bluetooth headsets when the mic is active.
 *
 * Uses the system Output Muted flag so the volume slider position is unchanged.
 * Export names stay pauseCompanionMedia / resumeCompanionMedia for call-site stability.
 *
 * Unmute is deferred briefly after the dictation stack unwinds so Bluetooth
 * headsets can leave the narrowband / HFP-style path before playback resumes.
 */

/** ms to wait before unmuting — reduces garbled or “thin” audio right after mic release */
const UNMUTE_DELAY_MS = 220;

let muteDepth = 0;
/** We only unmute on restore if we enabled mute (user may already have been muted). */
let weSetOutputMuted = false;
let pendingUnmuteTimer: ReturnType<typeof setTimeout> | null = null;

function runAppleScript(script: string): string {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function outputIsMuted(): boolean {
  const raw = runAppleScript('output muted of (get volume settings)');
  return raw === 'true' || raw === 'yes';
}

function runUnmuteNow(): void {
  if (!weSetOutputMuted) return;
  weSetOutputMuted = false;
  try {
    execFileSync('osascript', ['-e', 'set volume without output muted'], { stdio: 'pipe' });
  } catch {
    /* ignore */
  }
}

export function pauseCompanionMedia(): void {
  if (process.platform !== 'darwin') return;

  const hadDeferredUnmute = pendingUnmuteTimer !== null;
  if (pendingUnmuteTimer !== null) {
    clearTimeout(pendingUnmuteTimer);
    pendingUnmuteTimer = null;
  }

  if (muteDepth === 0) {
    if (!outputIsMuted()) {
      runAppleScript('set volume with output muted');
      weSetOutputMuted = outputIsMuted();
    } else if (hadDeferredUnmute && weSetOutputMuted) {
      // Still muted from our session; scheduled unmute was cancelled — keep ownership
    } else {
      // Already muted (e.g. user) — do not unmute on our resume
      weSetOutputMuted = false;
    }
  }
  muteDepth++;
}

export function resumeCompanionMedia(): void {
  if (process.platform !== 'darwin') return;

  muteDepth = Math.max(0, muteDepth - 1);
  if (muteDepth !== 0) return;

  if (!weSetOutputMuted) return;

  if (pendingUnmuteTimer !== null) {
    clearTimeout(pendingUnmuteTimer);
    pendingUnmuteTimer = null;
  }

  pendingUnmuteTimer = setTimeout(() => {
    pendingUnmuteTimer = null;
    runUnmuteNow();
  }, UNMUTE_DELAY_MS);
}
