import { readFileSync, writeFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const ledgerPath = process.env.DOWNLOAD_LEDGER_PATH || 'download-metrics.json';
if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required.');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
async function github(route) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, { headers });
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
  return response.json();
}
let previous = { assets: {} };
try { previous = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const observedAt = new Date().toISOString();
const assets = { ...previous.assets };
for (let page = 1; ; page++) {
  const releases = await github(`releases?per_page=100&page=${page}`);
  for (const release of releases) {
    if (release.draft) continue;
    for (const asset of release.assets) {
      const platform = /^Open-Memo-.*-arm64\.dmg$/.test(asset.name) ? 'macos'
        : /^Open-Memo-.*-windows-x64-setup\.exe$/.test(asset.name) ? 'windows' : null;
      if (!platform) continue;
      const old = assets[asset.id];
      assets[asset.id] = {
        id: asset.id, name: asset.name, platform, release: release.tag_name,
        download_count: Math.max(old?.download_count || 0, asset.download_count),
        first_observed_at: old?.first_observed_at || observedAt,
        last_observed_at: observedAt,
      };
    }
  }
  if (releases.length < 100) break;
}
const totals = { macos: 0, windows: 0 };
for (const asset of Object.values(assets)) totals[asset.platform] += asset.download_count;
const ledger = {
  schema_version: 1, repository, observed_at: observedAt,
  tracking_started_at: previous.tracking_started_at || observedAt,
  description: 'Cumulative GitHub installer asset requests, including direct GitHub downloads, retries and verification. Not unique people, completed transfers or installations. Retains last observed counts for removed assets; requests between final observation and deletion cannot be recovered.',
  totals, assets,
};
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ observed_at: observedAt, totals, assets: Object.keys(assets).length }));

if (process.env.POSTHOG_PROJECT_TOKEN && process.env.POSTHOG_API_HOST) {
  const batch = Object.entries(totals).map(([platform, downloadCount]) => ({
    event: 'github installer downloads snapshot', distinct_id: `github-installer-counts-${platform}`,
    timestamp: observedAt,
    properties: { memo_surface: 'fuck-typing', platform, download_count: downloadCount,
      source: 'github-release-assets', $process_person_profile: false },
  }));
  const response = await fetch(new URL('/batch/', process.env.POSTHOG_API_HOST), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.POSTHOG_PROJECT_TOKEN, batch }),
  });
  if (!response.ok) throw new Error(`PostHog snapshot failed: ${response.status}`);
  const result = await response.json();
  if (result.status !== 1) throw new Error('PostHog rejected snapshot.');
  console.log('PostHog installer count snapshot accepted.');
}
