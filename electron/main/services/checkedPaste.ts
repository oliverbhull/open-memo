import { execFileSync } from 'node:child_process';
import type { AppContext } from '../../shared/electron-api';

// Paste into the control that owns keyboard focus when delivery completes.
// Dictation text never enters this script; it is already on the clipboard.
export const FOCUSED_PASTE_SCRIPT = `on run argv
  tell application "System Events"
    set targetProcess to first application process whose frontmost is true
    set appName to name of targetProcess
    set windowName to ""
    set bundleIdValue to ""
    try
      set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
      set windowName to name of focusedWindow
    end try
    try
      set bundleIdValue to bundle identifier of targetProcess
    end try
    keystroke "v" using command down
    if item 1 of argv is "true" then key code 36
  end tell
  set separator to ASCII character 30
  return "pasted" & separator & appName & separator & windowName & separator & bundleIdValue
end run`;

export interface FocusedPasteResult {
  status: 'pasted' | 'target_unavailable';
  appContext?: AppContext;
}

export function pasteIntoFocusedTarget(
  pressEnter: boolean,
): FocusedPasteResult {
  const result = execFileSync('osascript', [
    '-e', FOCUSED_PASTE_SCRIPT, String(pressEnter),
  ], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const [status, appName, windowTitle, bundleId] = result.split('\x1e');
  if (status !== 'pasted') return { status: 'target_unavailable' };
  return {
    status: 'pasted',
    ...(appName ? {
      appContext: {
        appName: appName.slice(0, 200),
        windowTitle: (windowTitle || '').slice(0, 1_000),
        ...(bundleId ? { bundleId: bundleId.slice(0, 300) } : {}),
      },
    } : {}),
  };
}
