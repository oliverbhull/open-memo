import { execFileSync } from 'node:child_process';
import { matchEmailReply, type ReplySnapshot } from '../../shared/emailContext';
import { websiteDomainFromUrl } from '../../shared/websiteContext';
import type { AppContext } from '../../shared/electron-api';

// Paste into the control that owns keyboard focus when delivery completes.
// Dictation text never enters this script; it is already on the clipboard.
export const FOCUSED_PASTE_SCRIPT = `on run argv
  tell application "System Events"
    set targetProcess to first application process whose frontmost is true
    set appName to name of targetProcess
    set windowName to ""
    set bundleIdValue to ""
    set documentURL to ""
    try
      set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
      set windowName to name of focusedWindow
      try
        set documentURL to value of attribute "AXDocument" of focusedWindow
      end try
    end try
    try
      set bundleIdValue to bundle identifier of targetProcess
    end try
    -- Safari often leaves AXDocument empty. Its toolbar exposes the active URL
    -- without browser Automation permission or reading any page contents.
    if bundleIdValue is "com.apple.Safari" or bundleIdValue is "com.apple.SafariTechnologyPreview" then
      if documentURL is missing value or documentURL is "" then
        set documentURL to ""
        try
          set toolbarItems to entire contents of toolbar 1 of focusedWindow
          repeat with toolbarItem in toolbarItems
            if role of toolbarItem is "AXTextField" then
              if description of toolbarItem is "smart search field" then
                set documentURL to value of toolbarItem
                exit repeat
              end if
            end if
          end repeat
        end try
      end if
    end if
    if documentURL is missing value then set documentURL to ""
    keystroke "v" using command down
    if item 1 of argv is "true" then key code 36
  end tell
  set separator to ASCII character 30
  return "pasted" & separator & appName & separator & windowName & separator & bundleIdValue & separator & documentURL
end run`;

export interface FocusedPasteResult {
  status: 'pasted' | 'target_unavailable';
  appContext?: AppContext;
}

export function pasteIntoFocusedTarget(
  pressEnter: boolean,
  replySnapshot?: ReplySnapshot,
): FocusedPasteResult {
  const result = execFileSync('osascript', [
    '-e', FOCUSED_PASTE_SCRIPT, String(pressEnter),
  ], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const [status, appName, windowTitle, bundleId, documentURL] = result.split('\x1e');
  const websiteDomain = websiteDomainFromUrl(documentURL || '', bundleId);
  if (status !== 'pasted') return { status: 'target_unavailable' };
  const baseContext: AppContext = { appName: (appName || '').slice(0, 200), windowTitle: (windowTitle || '').slice(0, 1000), bundleId };
  const emailReply = matchEmailReply(replySnapshot, baseContext, documentURL || '');
  return {
    status: 'pasted',
    ...(appName ? {
      appContext: {
        appName: appName.slice(0, 200),
        ...(websiteDomain ? { websiteDomain } : {}),
        ...(emailReply ? { emailReply } : {}),
        windowTitle: (windowTitle || '').slice(0, 1_000),
        ...(bundleId ? { bundleId: bundleId.slice(0, 300) } : {}),
      },
    } : {}),
  };
}
