import React, { useEffect, useMemo, useState } from 'react';
import type { AppContext, AudioAttachment } from '../../../shared/electron-api';
import type { MemoEntry } from '../../../shared/memo-entry';
import { storageService } from '../services/StorageService';
import { useTheme } from '../context/ThemeContext';
import { AppIcon } from './AppIcon';
import { groupApplicationUsage, type AppUsage } from '../utils/applicationUsage';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ASSUMED_TYPING_WORDS_PER_MINUTE = 40;
const hoursFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function ActivityTime({ minutes }: { minutes: number }) {
  const showHours = minutes > 100;
  const value = showHours ? hoursFormatter.format(minutes / 60) : minutes.toLocaleString();
  return <><strong>{value}</strong> {showHours ? 'hr' : 'min'}</>;
}

function countWords(text: string): number {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

function appContextFor(entry: MemoEntry): AppContext | null {
  const candidate = entry.context?.appContext;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const appName = (candidate as Record<string, unknown>).appName;
  const windowTitle = (candidate as Record<string, unknown>).windowTitle;
  const bundleId = (candidate as Record<string, unknown>).bundleId;
  const appPath = (candidate as Record<string, unknown>).appPath;
  if (typeof appName !== 'string' || !appName.trim()) return null;
  return {
    appName: appName.trim(),
    ...(typeof appPath === 'string' && appPath ? { appPath } : {}),
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
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storageService.init()
      .then(() => storageService.getAllActiveEntries())
      .then((loaded) => { if (!cancelled) setEntries(loaded); })
      .catch((error) => { console.error('[ActivityInsights] Failed to load entries:', error); if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const activity = useMemo(() => {
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const appRecords: AppUsage[] = [];
    let totalWords = 0;
    let speakingSeconds = 0;
    let timedWords = 0;
    let timedSpeakingSeconds = 0;

    entries.forEach((entry) => {
      const words = countWords(entry.text);
      const date = new Date(entry.createdAt);
      const row = heat[date.getDay()];
      const hour = date.getHours();
      if (row) row[hour] = (row[hour] ?? 0) + words;

      totalWords += words;
      const duration = audioFor(entry)?.duration ?? 0;
      speakingSeconds += duration;
      if (words > 0 && duration > 0) {
        timedWords += words;
        timedSpeakingSeconds += duration;
      }

      const app = appContextFor(entry);
      if (!app) return;
      appRecords.push({
        appName: app.appName,
        appPath: app.appPath,
        bundleId: app.bundleId,
        words,
      });
    });

    const apps = groupApplicationUsage(appRecords).sort((left, right) => right.words - left.words);
    const appWords = apps.reduce((sum, app) => sum + app.words, 0);
    const activeHourCounts = heat.flat().filter((words) => words > 0).sort((left, right) => left - right);
    // Use quartiles of active hours so the busiest hour cannot set the whole color scale.
    const heatCutoffs = [0.25, 0.5, 0.75].map((quantile) => (
      activeHourCounts[Math.floor((activeHourCounts.length - 1) * quantile)] ?? 0
    ));
    const estimatedMinutesSaved = timedWords > 0
      ? Math.max(0, Math.round(timedWords / ASSUMED_TYPING_WORDS_PER_MINUTE - timedSpeakingSeconds / 60))
      : null;
    return { heat, heatCutoffs, apps, appWords, totalWords, speakingSeconds, estimatedMinutesSaved };
  }, [entries]);

  const speakingMinutes = Math.round(activity.speakingSeconds / 60);

  return (
    <div className="activity-insights" style={{ '--activity-primary': primary } as React.CSSProperties}>
      {loadError && <p role="status" className="settings-error">Activity could not be loaded. Reopen settings to try again.</p>}
      <div className="activity-insights__stats">
        <span><strong className="activity-insights__word-count">{loading ? '…' : loadError ? '—' : activity.totalWords.toLocaleString()}</strong> words</span>
        <span><strong>{loading ? '…' : loadError ? '—' : entries.length.toLocaleString()}</strong> moments</span>
        {speakingMinutes > 0 ? (
          <span><ActivityTime minutes={speakingMinutes} /> speaking</span>
        ) : (
          <span>Calculated locally</span>
        )}
        {activity.estimatedMinutesSaved !== null && (
          <span title={`All-time words from dictations with a recorded duration, at ${ASSUMED_TYPING_WORDS_PER_MINUTE} words per minute, minus their recording time.`}>
            <ActivityTime minutes={activity.estimatedMinutesSaved} /> typing saved
          </span>
        )}
      </div>
      <div className="activity-insights__hours" aria-hidden="true">
        <span />
        {[0, 6, 12, 18].map((hour) => <span key={hour} style={{ gridColumn: hour + 2 }}>{hour === 0 ? '12am' : hour === 6 ? '6am' : hour === 12 ? '12pm' : '6pm'}</span>)}
      </div>
      <div className="activity-insights__heatmap" role="img" aria-label={loading ? "Loading dictation activity" : loadError ? "Activity unavailable" : `All-time dictation by weekday and hour. ${activity.heat.flat().reduce((sum, words) => sum + words, 0).toLocaleString()} words total. Brighter squares indicate more words.`}>
        {DAY_LABELS.flatMap((day, dayIndex) => [
          <span className="activity-insights__day" key={`${day}-label`}>{day}</span>,
          ...(activity.heat[dayIndex] ?? []).map((words, hour) => {
            const level = words === 0 ? 0 : 1 + activity.heatCutoffs.filter((cutoff) => words > cutoff).length;
            return <span key={`${day}-${hour}`} className="activity-insights__cell" data-level={level} title={`${day} ${hour.toString().padStart(2, '0')}:00 · ${words.toLocaleString()} words`} />;
          }),
        ])}
      </div>

      <div className="activity-insights__legend" aria-hidden="true">
        <span>Less</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className="activity-insights__cell" data-level={level} />)}<span>More</span>
      </div>
      <details className="activity-insights__applications" open>
        <summary><strong>Applications</strong><span>Word share</span></summary>
        <div className="activity-insights__apps">
          {activity.apps.length === 0 ? (
            <span className="activity-insights__empty">Application usage will appear as you dictate.</span>
          ) : activity.apps.map((app) => {
            const percent = activity.appWords > 0 ? (app.words / activity.appWords) * 100 : 0;
            const label = percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
            return (
              <div className="activity-insights__app" key={app.key}>
                <AppIcon appName={app.appName} bundleId={app.bundleId} appPath={app.appPath} size={window.electronAPI.platform === 'win32' ? 16 : 22} />
                <span className="activity-insights__app-name">{app.appName}</span>
                <span className="activity-insights__app-track"><i style={{ width: `${percent}%` }} /></span>
                <span className="activity-insights__app-value">{label}</span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
};
