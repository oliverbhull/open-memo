/** Only browser-owned document URLs establish website identity. */
export const BROWSER_BUNDLE_IDS = new Set([
  'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'com.google.Chrome', 'com.google.Chrome.canary', 'com.microsoft.edgemac',
  'com.brave.Browser', 'company.thebrowser.Browser', 'org.mozilla.firefox',
]);

export function websiteDomainFromUrl(value: string, bundleId?: string): string | undefined {
  if (!bundleId || !BROWSER_BUNDLE_IDS.has(bundleId)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return undefined;
    return normalizeWebsiteDomain(url.hostname);
  } catch { return undefined; }
}

export function normalizeWebsiteDomain(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 253) return undefined;
  const domain = value.toLowerCase().replace(/\.$/, '');
  // No URLs, credentials, ports, IP literals, or local hostnames in icon requests.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return undefined;
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(domain)) return undefined;
  return domain;
}
