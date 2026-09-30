import React, { useEffect, useMemo, useState } from 'react';
import type { AppContext, AudioAttachment } from '../../../shared/electron-api';
import type { MemoEntry } from '../../../shared/memo-entry';
import { storageService } from '../services/StorageService';
import { useTheme } from '../context/ThemeContext';
import { AppIcon } from './AppIcon';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface AppUsage {
  appName: string;
  bundleId?: string;
  words: number;
}

function countWords(text: string): number {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function appContextFor(entry: MemoEntry): AppContext | null {
  const candidate = entry.context?.appContext;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const appName = (candidate as Record<string, unknown>).appName;
  const windowTitle = (candidate as Record<string, unknown>).windowTitle;
  const bundleId = (candidate as Record<string, unknown>).bundleId;
  if (typeof appName !== 'string' || !appName.trim()) return null;
  return {
    appName: appName.trim(),
    windowTitle: typeof windowTitle === 'string' ? windowTitle : '',
    ...(typeof bundleId === 'string' && bundleId ? { bundleId } : {}),
  };
}

function audioFor(entry: MemoEntry): AudioAttachment | null {
  const candidate = entry.context?.audio;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const duration = (candidate as Record<string, unknown>).duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  return { fileName: '', mimeType: 'audio/wav', duration };
}

export const ActivityInsights: React.FC = () => {
  const { primary } = useTheme();
  const [entries, setEntries] = useState<MemoEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void storageService.init()
      .then(() => storageService.getAllActiveEntries())
      .then((loaded) => { if (!cancelled) setEntries(loaded); })
      .catch((error) => { console.error('[ActivityInsights] Failed to load entries:', error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const activity = useMemo(() => {
    const today = startOfLocalDay(Date.now());
    const weekStart = today - 6 * DAY_MS;
    const heatStart = today - 27 * DAY_MS;
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const apps = new Map<string, AppUsage>();
    let weekWords = 0;
    let weekMoments = 0;
    let speakingSeconds = 0;

    entries.forEach((entry) => {
      const words = countWords(entry.text);
      const day = startOfLocalDay(entry.createdAt);
      if (day >= heatStart && day <= today) {
        const date = new Date(entry.createdAt);
        const row = heat[date.getDay()]!;
        row[date.getHours()] = (row[date.getHours()] ?? 0) + words;
      }
      if (day < weekStart || day > today) return;
      weekWords += words;
      weekMoments += 1;
      speakingSeconds += audioFor(entry)?.duration ?? 0;

      const app = appContextFor(entry);
      if (!app) return;
      const key = app.bundleId || app.appName.toLowerCase();
      const existing = apps.get(key);
      apps.set(key, {
        appName: app.appName,
        bundleId: app.bundleId,
        words: (existing?.words ?? 0) + words,
      });
    });

    const allApps = [...apps.values()];
    const topApps = allApps.sort((left, right) => right.words - left.words).slice(0, 4);
    const appWords = allApps.reduce((sum, app) => sum + app.words, 0);
    const heatMax = Math.max(1, ...heat.flat());
    return { heat, heatMax, topApps, appWords, weekWords, weekMoments, speakingSeconds };
  }, [entries]);

  const speakingMinutes = Math.round(activity.speakingSeconds / 60);

  return (
    <div className="activity-insights" style={{ '--activity-primary': primary } as React.CSSProperties}>
      <div className="activity-insights__header">
        <div>
          <strong>Last 7 Days</strong>
        </div>
        <div className="activity-insights__total">
          <strong>{loading ? '…' : activity.weekWords.toLocaleString()}</strong>
          <span>words</span>
        </div>
      </div>

      <div className="activity-insights__hours" aria-hidden="true">
        <span />
        {[0, 6, 12, 18].map((hour) => <span key={hour} style={{ gridColumn: hour + 2 }}>{hour === 0 ? '12am' : hour === 6 ? '6am' : hour === 12 ? '12pm' : '6pm'}</span>)}
      </div>
      <div className="activity-insights__heatmap" aria-label="Words captured by weekday and hour over the last four weeks">
        {DAY_LABELS.flatMap((day, dayIndex) => [
          <span className="activity-insights__day" key={`${day}-label`}>{day}</span>,
          ...(activity.heat[dayIndex] ?? []).map((words, hour) => {
            const level = words === 0 ? 0 : Math.max(1, Math.ceil((words / activity.heatMax) * 4));
            return <span key={`${day}-${hour}`} className="activity-insights__cell" data-level={level} title={`${day} ${hour.toString().padStart(2, '0')}:00 · ${words.toLocaleString()} words`} />;
          }),
        ])}
      </div>

      <div className="activity-insights__subhead activity-insights__apps-heading">
        <strong>Applications</strong><span>Share of words</span>
      </div>
      <div className="activity-insights__apps">
        {activity.topApps.length === 0 ? (
          <span className="activity-insights__empty">Application usage will appear here.</span>
        ) : activity.topApps.map((app) => {
          const percent = activity.appWords > 0 ? Math.round((app.words / activity.appWords) * 100) : 0;
          return (
            <div className="activity-insights__app" key={app.bundleId || app.appName}>
              <AppIcon appName={app.appName} bundleId={app.bundleId} size={22} />
              <span className="activity-insights__app-name">{app.appName}</span>
              <span className="activity-insights__app-track"><i style={{ width: `${percent}%` }} /></span>
              <span className="activity-insights__app-value">{percent}%</span>
            </div>
          );
        })}
      </div>
      <div className="activity-insights__footer">
        <span>{activity.weekMoments.toLocaleString()} voice moments</span>
        <span>{speakingMinutes > 0 ? `${speakingMinutes.toLocaleString()} min speaking` : 'Calculated locally'}</span>
      </div>
    </div>
  );
};
