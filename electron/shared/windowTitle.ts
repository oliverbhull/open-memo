/**
 * Electron apps such as Claude keep a static window title ("Claude") while their
 * web contents' document title names the open chat. Prefer that document title
 * only when the window title says nothing beyond the app name, and only when the
 * snapshot came from the same app that received the paste.
 */
export function resolveWindowTitle(
  windowTitle: string,
  appName: string,
  bundleId: string | undefined,
  snapshot?: { bundleId?: string; webTitle?: string },
): string {
  if (!isStaticTitle(windowTitle, appName)) return windowTitle;
  if (!bundleId || snapshot?.bundleId !== bundleId || typeof snapshot.webTitle !== 'string') return windowTitle;
  return cleanWebTitle(snapshot.webTitle, appName) || windowTitle;
}

function isStaticTitle(windowTitle: string, appName: string): boolean {
  const title = windowTitle.trim().toLowerCase();
  return !title || title === appName.trim().toLowerCase();
}

/** Drop a leading or trailing app name ("Chat name - Claude"); reject a bare app name. */
export function cleanWebTitle(value: string, appName: string): string {
  let title = value.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const name = appName.trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title
      .replace(new RegExp(`\\s*[-\u2013\u2014|\u00b7:]\\s*${escaped}$`, 'i'), '')
      .replace(new RegExp(`^${escaped}\\s*[-\u2013\u2014|\u00b7:]\\s*`, 'i'), '')
      .trim();
  }
  return title.toLowerCase() === name.toLowerCase() ? '' : title;
}
