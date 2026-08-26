import type { AppContext } from '../../shared/electron-api';

export const MEMO_APPLICATION_CONTEXT: AppContext = {
  appName: 'Memo',
  windowTitle: 'Memo',
  bundleId: 'com.memo.desktop',
};

/**
 * A focused Memo window is the destination for a dictation even if macOS still
 * reports the application that was focused immediately before Memo opened.
 * Merely being visible is insufficient because Memo can remain onscreen behind
 * the actual dictation destination.
 */
export function resolveApplicationContext(
  detectedContext: AppContext | undefined,
  memoWindowIsFocused: boolean,
): AppContext | undefined {
  return memoWindowIsFocused ? { ...MEMO_APPLICATION_CONTEXT } : detectedContext;
}
