import type { AppContext } from '../../shared/electron-api';

export const MEMO_APPLICATION_CONTEXT: AppContext = {
  appName: 'Memo',
  windowTitle: 'Memo',
  bundleId: 'com.memo.desktop',
};

/**
 * A visible Memo window is the destination for a dictation even if macOS still
 * reports the application that was focused immediately before Memo opened.
 */
export function resolveApplicationContext(
  detectedContext: AppContext | undefined,
  memoWindowIsVisible: boolean,
): AppContext | undefined {
  return memoWindowIsVisible ? { ...MEMO_APPLICATION_CONTEXT } : detectedContext;
}
