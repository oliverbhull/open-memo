export interface AppUsage {
  appName: string;
  bundleId?: string;
  words: number;
}

export interface GroupedAppUsage extends AppUsage {
  key: string;
}

/** Reconcile legacy name-only records with an unambiguous application identity. */
export function groupApplicationUsage(records: AppUsage[]): GroupedAppUsage[] {
  const normalized = records.map((record) => ({
    ...record,
    appName: record.appName.trim(),
    bundleId: record.bundleId?.trim() || undefined,
  }));
  const identitiesByName = new Map<string, Map<string, string>>();
  for (const record of normalized) {
    if (!record.bundleId) continue;
    const name = record.appName.toLowerCase();
    const identities = identitiesByName.get(name) ?? new Map<string, string>();
    const identity = record.bundleId.toLowerCase();
    if (!identities.has(identity)) identities.set(identity, record.bundleId);
    identitiesByName.set(name, identities);
  }

  const apps = new Map<string, GroupedAppUsage>();
  for (const record of normalized) {
    const name = record.appName.toLowerCase();
    const identities = identitiesByName.get(name);
    // Never merge two different applications just because their names match.
    const bundleId = record.bundleId || (identities?.size === 1 ? [...identities.values()][0] : undefined);
    const key = bundleId ? `bundle:${bundleId.toLowerCase()}` : `name:${name}`;
    const existing = apps.get(key);
    apps.set(key, {
      key,
      appName: existing?.appName ?? record.appName,
      bundleId: existing?.bundleId ?? bundleId,
      words: (existing?.words ?? 0) + record.words,
    });
  }
  return [...apps.values()];
}
