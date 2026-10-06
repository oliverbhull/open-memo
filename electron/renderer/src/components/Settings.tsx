import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { hexToHsl, hslToHex } from '../utils/colorUtils';
import { storageService } from '../services/StorageService';
import { ActivityInsights } from './ActivityInsights';
import { buildTranscriptionExport } from '../services/transcriptionExport';
import type {
  CleanupState,
  MicrophoneInputState,
  PhraseReplacementRule,
  WritingMode,
} from '../../../shared/electron-api';
import '../styles/glass.css';
import '../styles/color-picker.css';

interface SettingsProps {
  onClose: () => void;
}

const FolderIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const InfoTooltip = ({
  label,
  align = 'left',
  children,
}: {
  label: string;
  align?: 'left' | 'center' | 'right';
  children: React.ReactNode;
}) => {
  const tooltipId = useId();

  return (
    <span className="settings-info-tooltip">
      <button
        type="button"
        className="settings-info-tooltip__trigger"
        aria-label={label}
        aria-describedby={tooltipId}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5" strokeLinecap="round" />
          <circle cx="8" cy="4.75" r="0.65" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`settings-info-tooltip__content settings-info-tooltip__content--${align}`}
      >
        {children}
      </span>
    </span>
  );
};

const SettingsSectionHeading = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    margin: '14px 0 9px',
    paddingTop: '12px',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: '10px',
    fontWeight: 650,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  }}>
    {children}
  </div>
);

function toLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const localTime = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { primary, setPrimary } = useTheme();
  const [handsFreeMode, setHandsFreeMode] = useState(false);
  const [sayEnterToPressEnter, setSayEnterToPressEnter] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [microphoneState, setMicrophoneState] = useState<MicrophoneInputState | null>(null);
  const [microphoneSelecting, setMicrophoneSelecting] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [saveAudio, setSaveAudio] = useState(false);
  const [experimentalEmailFormatting, setExperimentalEmailFormatting] = useState(false);
  const [writingMode, setWritingMode] = useState<WritingMode>('as-spoken');
  const [cleanupState, setCleanupState] = useState<CleanupState>({
    available: false,
    status: 'disabled',
  });
  const [cleanedRemoving, setCleanedRemoving] = useState(false);
  const [cleanupActionError, setCleanupActionError] = useState<string | null>(null);
  const [vocabWords, setVocabWords] = useState<string[]>([]);
  const [isAddingVocabWord, setIsAddingVocabWord] = useState(false);
  const [vocabWordDraft, setVocabWordDraft] = useState('');
  const vocabInputRef = useRef<HTMLInputElement>(null);
  const [phraseReplacementRules, setPhraseReplacementRules] = useState<PhraseReplacementRule[]>([]);
  const colorBarSpectrumRef = useRef<HTMLDivElement>(null);
  const [colorBarHue, setColorBarHue] = useState(0);
  const [colorBarSaturation, setColorBarSaturation] = useState(100);
  const [colorBarLightness, setColorBarLightness] = useState(50);
  const [totalWordCount, setTotalWordCount] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.interface.getSettings().then((settings) => {
      setSayEnterToPressEnter(settings.sayEnterToPressEnter ?? false);
      setHandsFreeMode(settings.handsFreeMode ?? false);
      setStartAtLogin(settings.startAtLogin);
      setSaveAudio(settings.saveAudio ?? false);
      setExperimentalEmailFormatting(settings.experimentalEmailFormatting ?? false);
      setWritingMode(settings.writingMode ?? 'as-spoken');
      setCleanupState(settings.cleanupState);
      setVocabWords(Array.isArray(settings.vocabWords) ? settings.vocabWords : []);
      setPhraseReplacementRules(
        Array.isArray(settings.phraseReplacements) ? settings.phraseReplacements : []
      );
    });
  }, []);

  useEffect(() => window.electronAPI.interface.onCleanupStateChanged(setCleanupState), []);

  useEffect(() => {
    let mounted = true;
    void window.electronAPI.microphone.getState().then((state) => {
      if (mounted) setMicrophoneState(state);
    }).catch((error) => {
      console.error('[Settings] Failed to load microphone inputs:', error);
      if (mounted) setMicrophoneError('Could not load microphone inputs.');
    });
    const unsubscribe = window.electronAPI.microphone.onStateChanged((state) => {
      if (mounted) setMicrophoneState(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);


  useEffect(() => {
    if (isAddingVocabWord) {
      // Focus after render
      setTimeout(() => vocabInputRef.current?.focus(), 0);
    }
  }, [isAddingVocabWord]);

  const normalizeVocabWord = (w: string): string => w.trim();

  const persistVocabWords = async (next: string[]) => {
    setVocabWords(next);
    await window.electronAPI.interface.setVocabWords(next);
  };

  const persistPhraseRulesToDisk = async (next: PhraseReplacementRule[]) => {
    await window.electronAPI.interface.setPhraseReplacements(
      next.filter((r) => r.find.trim().length > 0)
    );
  };

  const addPhraseRule = () => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `pr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    setPhraseReplacementRules((prev) => [{ id, find: '', replace: '', enabled: true }, ...prev]);
  };

  const removePhraseRule = async (id: string) => {
    const next = phraseReplacementRules.filter((r) => r.id !== id);
    setPhraseReplacementRules(next);
    await persistPhraseRulesToDisk(next);
  };

  const togglePhraseRule = async (id: string) => {
    const next = phraseReplacementRules.map((r) =>
      r.id === id ? { ...r, enabled: !(r.enabled !== false) } : r
    );
    setPhraseReplacementRules(next);
    await persistPhraseRulesToDisk(next);
  };

  const commitPhraseFindBlur = async (id: string) => {
    const row = phraseReplacementRules.find((rule) => rule.id === id);
    if (!row) return;
    const trimmed = row.find.trim();
    const next = !trimmed
      ? phraseReplacementRules.filter((rule) => rule.id !== id)
      : phraseReplacementRules.map((rule) => rule.id === id ? { ...rule, find: trimmed } : rule);
    setPhraseReplacementRules(next);
    await persistPhraseRulesToDisk(next);
  };

  const commitPhraseReplaceBlur = async (id: string) => {
    const row = phraseReplacementRules.find((rule) => rule.id === id);
    if (!row) return;
    const next = phraseReplacementRules.map((rule) =>
      rule.id === id ? { ...rule, replace: row.replace } : rule
    );
    setPhraseReplacementRules(next);
    await persistPhraseRulesToDisk(next);
  };

  const addVocabWord = async (raw: string) => {
    const word = normalizeVocabWord(raw);
    if (!word) return;
    const deduped = Array.from(new Set([word, ...(vocabWords || [])]));
    await persistVocabWords(deduped);
    setVocabWordDraft('');
    setIsAddingVocabWord(false);
  };

  const removeVocabWord = async (word: string) => {
    const next = (vocabWords || []).filter((w) => w !== word);
    await persistVocabWords(next);
  };

  // Keep the color bar state aligned with the active theme.
  useEffect(() => {
    if (primary) {
      const [h, s, l] = hexToHsl(primary);
      setColorBarHue(h);
      setColorBarSaturation(s);
      setColorBarLightness(l);
    }
  }, [primary]);

  // Load total word count from memo database (words dictated, not typed)
  useEffect(() => {
    let cancelled = false;
    storageService.init().then(() => storageService.getTotalWordCount()).then((count) => {
      if (!cancelled) setTotalWordCount(count);
    }).catch(() => {
      if (!cancelled) setTotalWordCount(null);
    });
    return () => { cancelled = true; };
  }, []);

  const handleColorBarSpectrumMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!colorBarSpectrumRef.current) return;
    const rect = colorBarSpectrumRef.current.getBoundingClientRect();
    const updateHue = (clientX: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const hue = Math.round(x * 360);
      setColorBarHue(hue);
      setPrimary(hslToHex(hue, colorBarSaturation, colorBarLightness));
    };
    updateHue(e.clientX);
    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateHue(moveEvent.clientX);
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [colorBarSaturation, colorBarLightness, setPrimary]);

  const openExportPicker = async () => {
    setExportOpen(true);
    setExportStatus(null);
    setExportBusy(true);
    try {
      await storageService.init();
      const entries = await storageService.getAllActiveEntries();
      if (entries.length === 0) {
        setExportStatus('No transcriptions to export.');
        return;
      }
      const bounds = entries.reduce(
        (current, entry) => ({
          oldest: Math.min(current.oldest, entry.createdAt),
          newest: Math.max(current.newest, entry.createdAt),
        }),
        { oldest: Number.POSITIVE_INFINITY, newest: Number.NEGATIVE_INFINITY }
      );
      setExportFrom(toLocalDateTime(bounds.oldest));
      setExportTo(toLocalDateTime(bounds.newest));
    } catch (error) {
      console.error('[Settings] Failed to prepare transcription export:', error);
      setExportStatus('Could not load transcriptions.');
    } finally {
      setExportBusy(false);
    }
  };

  const exportTranscriptions = async (all: boolean) => {
    setExportBusy(true);
    setExportStatus(null);
    try {
      const entries = await storageService.getAllActiveEntries();
      const from = all ? undefined : new Date(exportFrom).getTime();
      const toStart = all ? undefined : new Date(exportTo).getTime();
      if (!all && (!Number.isFinite(from) || !Number.isFinite(toStart))) {
        setExportStatus('Choose both a start and end time.');
        return;
      }
      const to = toStart === undefined ? undefined : toStart + 59_999;
      const document = buildTranscriptionExport(entries, from, to);
      if (document.count === 0) {
        setExportStatus('No transcriptions fall within that time range.');
        return;
      }
      const result = await window.electronAPI.exportJson(document);
      if (result.success) {
        setExportStatus(`Exported ${document.count.toLocaleString()} transcription${document.count === 1 ? '' : 's'}.`);
      } else if (!result.canceled) {
        setExportStatus(result.error || 'Export failed.');
      }
    } catch (error) {
      console.error('[Settings] Failed to export transcriptions:', error);
      setExportStatus(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setExportBusy(false);
    }
  };

  const removeCleaned = async () => {
    setCleanedRemoving(true);
    setCleanupActionError(null);
    try {
      const result = await window.electronAPI.interface.removeCleaned();
      setWritingMode(result.writingMode);
      setCleanupState(result.cleanupState);
    } catch (error) {
      setCleanupActionError(error instanceof Error ? error.message : 'Could not remove Cleaned.');
      void window.electronAPI.interface.getSettings().then(settings => {
        setWritingMode(settings.writingMode);
        setCleanupState(settings.cleanupState);
      }).catch(() => undefined);
    } finally {
      setCleanedRemoving(false);
    }
  };

  const selectMicrophone = async (value: string) => {
    const deviceName = value === 'system-default'
      ? null
      : value.startsWith('device-')
        ? microphoneState?.devices[Number(value.slice('device-'.length))]?.name
        : undefined;
    if (deviceName === undefined) return;

    setMicrophoneSelecting(true);
    setMicrophoneError(null);
    try {
      setMicrophoneState(await window.electronAPI.microphone.selectSystemInput(deviceName));
    } catch (error) {
      console.error('[Settings] Failed to select microphone:', error);
      setMicrophoneError(error instanceof Error ? error.message : 'Could not select microphone.');
    } finally {
      setMicrophoneSelecting(false);
    }
  };

  const selectedMicrophoneIndex = microphoneState?.selectedDeviceName
    ? microphoneState.devices.findIndex((device) => device.name === microphoneState.selectedDeviceName)
    : -1;
  const microphoneValue = microphoneState?.selectedDeviceName
    ? selectedMicrophoneIndex >= 0 ? `device-${selectedMicrophoneIndex}` : 'unavailable'
    : 'system-default';

  return (
    <>
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <button className="settings-close" onClick={onClose} title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>

          <div className="settings-content">
            <div style={{
              margin: '0 0 8px',
              color: 'rgba(255, 255, 255, 0.5)',
              fontSize: '10px',
              fontWeight: 650,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              Appearance
            </div>
            {/* Color bar (expanded, no animation) — top */}
            <div className="settings-color-bar">
              <div
                className="color-spectrum expanded"
                ref={colorBarSpectrumRef}
                onMouseDown={handleColorBarSpectrumMouseDown}
              >
                <div className="spectrum-gradient" />
                <div
                  className="spectrum-selector"
                  style={{ left: `${(colorBarHue / 360) * 100}%` }}
                />
              </div>
            </div>

            <SettingsSectionHeading>Audio</SettingsSectionHeading>

            <div style={{
              width: '92%',
              margin: '0 auto 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}>
              <label htmlFor="microphone-input" style={{ fontSize: '12px', userSelect: 'none' }}>
                Mic input
              </label>
              <span style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
                <select
                  id="microphone-input"
                  value={microphoneValue}
                  disabled={!microphoneState || microphoneSelecting}
                  onChange={(event) => void selectMicrophone(event.target.value)}
                  style={{
                    width: '224px',
                    maxWidth: '100%',
                    padding: '6px 28px 6px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    background: 'rgba(18, 18, 24, 0.86)',
                    color: 'rgba(255, 255, 255, 0.92)',
                    fontSize: '12px',
                    cursor: microphoneSelecting ? 'wait' : 'pointer',
                    outline: 'none',
                    opacity: microphoneState ? 1 : 0.65,
                    appearance: 'none',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {microphoneState?.selectedDeviceName && selectedMicrophoneIndex < 0 && (
                    <option value="unavailable" disabled>
                      {microphoneState.selectedDeviceName} — Unavailable
                    </option>
                  )}
                  <option value="system-default">
                    {microphoneState?.defaultDeviceName
                      ? `System Default — ${microphoneState.defaultDeviceName}`
                      : 'System Default'}
                  </option>
                  {microphoneState?.devices.map((device, index) => (
                    <option key={device.name} value={`device-${index}`}>{device.name}</option>
                  ))}
                </select>
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    right: '9px',
                    top: '50%',
                    transform: 'translateY(-52%)',
                    pointerEvents: 'none',
                    fontSize: '10px',
                    opacity: 0.72,
                  }}
                >
                  ▾
                </span>
              </span>
            </div>
            {microphoneError && (
              <div style={{ width: '92%', margin: '-4px auto 10px', color: '#ff8b8b', fontSize: '10px' }}>
                {microphoneError}
              </div>
            )}

            <div style={{ width: '92%', margin: '0 auto 10px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span>Speech model</span>
              <span>Conomo — Included</span>
            </div>

            <div className="settings-section" style={{
              width: '92%',
              margin: '0 auto 12px',
            }}>
              <div className="settings-checkbox-stack">
                <div className="settings-checkbox-row">
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      checked={handsFreeMode}
                      onChange={async (e) => {
                        const newValue = e.target.checked;
                        setHandsFreeMode(newValue);
                        await window.electronAPI.interface.setHandsFreeMode(newValue);
                      }}
                      style={{
                        width: '16px',
                        height: '16px',
                        margin: 0,
                        cursor: 'pointer',
                        accentColor: primary,
                        color: primary,
                      }}
                    />
                    <span style={{ fontSize: '12px', userSelect: 'none' }}>Hands free</span>
                  </label>
                  <InfoTooltip label="About Hands free" align="center">
                    Starts recording when you speak and transcribes after silence. The Function key still works.
                  </InfoTooltip>
                </div>

              </div>
            </div>

            <SettingsSectionHeading>Writing</SettingsSectionHeading>

            {/* Development-only transcript cleanup experiment */}
            <div style={{
              width: '92%',
              margin: '0 auto 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
            }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <label htmlFor="writing-mode" style={{ fontSize: '12px', userSelect: 'none' }}>
                    Mode
                  </label>
                  {writingMode === 'clean' && (
                    <InfoTooltip label="About Cleaned mode">
                      {cleanupState.status === 'ready'
                        ? 'Adds punctuation and layout locally while preserving your words.'
                        : cleanupState.status === 'downloading'
                          ? cleanupState.detail || 'Downloading Cleaned…'
                        : cleanupState.status === 'loading'
                          ? 'Loading LFM locally…'
                          : cleanupState.detail || 'Downloads once when selected, then runs locally.'}
                    </InfoTooltip>
                  )}
                </span>
                <span style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
                  <select
                    id="writing-mode"
                    value={writingMode}
                    disabled={cleanedRemoving}
                    onChange={async (event) => {
                      const mode = event.target.value as WritingMode;
                      const previousMode = writingMode;
                      setWritingMode(mode);
                      const accepted = await window.electronAPI.interface.setWritingMode(mode);
                      if (!accepted) setWritingMode(previousMode);
                    }}
                    style={{
                      width: '224px',
                      maxWidth: '100%',
                      padding: '6px 28px 6px 8px',
                      borderRadius: '6px',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      background: 'rgba(18, 18, 24, 0.86)',
                      color: 'rgba(255, 255, 255, 0.92)',
                      fontSize: '12px',
                      cursor: 'pointer',
                      outline: 'none',
                      appearance: 'none',
                    }}
                  >
                    <option value="as-spoken">As spoken — Included</option>
                    <option value="clean">Cleaned – 1.03 GB model download</option>
                  </select>
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      right: '9px',
                      top: '50%',
                      transform: 'translateY(-52%)',
                      pointerEvents: 'none',
                      fontSize: '10px',
                      opacity: 0.72,
                    }}
                  >
                    ▾
                  </span>
                </span>
              </div>
              {cleanupState.installed && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '6px' }}>
                  <span style={{ fontSize: '11px', opacity: 0.7 }}>
                    Cleaned is stored locally. Removing it switches to As spoken.
                  </span>
                  <button type="button" onClick={() => void removeCleaned()}
                    disabled={cleanedRemoving || cleanupState.status === 'downloading' || cleanupState.status === 'loading'}
                    aria-label="Remove Cleaned download"
                    style={{ flexShrink: 0, border: 'none', background: 'none', color: '#ff8b8b', fontSize: '11px', cursor: 'pointer' }}>
                    {cleanedRemoving ? 'Removing…' : 'Remove download'}
                  </button>
                </div>
              )}
              {cleanupActionError && <div style={{ fontSize: '10px', color: '#ff8b8b' }}>{cleanupActionError}</div>}
              <div className="settings-checkbox-stack" style={{ fontSize: '12px' }}>
                <div className="settings-checkbox-row">
                  <label style={{ display: 'flex', gap: '8px', alignItems: 'center', cursor: writingMode === 'clean' ? 'pointer' : 'default' }}>
                    <input
                      type="checkbox"
                      checked={experimentalEmailFormatting}
                      disabled={writingMode !== 'clean'}
                      onChange={async event => {
                        const enabled = event.target.checked;
                        if (await window.electronAPI.interface.setExperimentalEmailFormatting(enabled)) {
                          setExperimentalEmailFormatting(enabled);
                        }
                      }}
                      style={{
                        width: '16px',
                        height: '16px',
                        margin: 0,
                        cursor: writingMode === 'clean' ? 'pointer' : 'default',
                        accentColor: primary,
                      }}
                    />
                    Email formatting (experimental)
                  </label>
                  <InfoTooltip label="About email formatting" align="right">
                    In Cleaned mode, formats Gmail and all Safari dictation as email using the active app and URL locally.
                  </InfoTooltip>
                </div>
                {/* Say 'enter' to press Enter */}
                <div className="settings-checkbox-row">
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    borderRadius: '4px',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                  >
                    <input
                      type="checkbox"
                      checked={sayEnterToPressEnter}
                      onChange={async (e) => {
                        const newValue = e.target.checked;
                        setSayEnterToPressEnter(newValue);
                        await window.electronAPI.interface.setSayEnterToPressEnter(newValue);
                      }}
                      style={{
                        width: '16px',
                        height: '16px',
                        margin: 0,
                        cursor: 'pointer',
                        accentColor: primary,
                        color: primary,
                      }}
                    />
                    <span style={{
                      fontSize: '12px',
                      userSelect: 'none',
                    }}>
                      Say &quot;ENTER&quot; to submit
                    </span>
                  </label>
                  <InfoTooltip label="About Say ENTER to submit" align="center">
                    When dictation ends with the spoken word &quot;enter,&quot; Memo removes the word and presses Return after pasting.
                  </InfoTooltip>
                </div>
              </div>
            </div>

              <SettingsSectionHeading>Vocab</SettingsSectionHeading>

              <div
                className="settings-section"
                style={{
                  width: '92%',
                  margin: '0 auto 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                }}
              >

                {/* Vocab (STT boosting) */}
                <div>
                      {isAddingVocabWord && (
                        <input
                          ref={vocabInputRef}
                          type="text"
                          value={vocabWordDraft}
                          onChange={(e) => setVocabWordDraft(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              await addVocabWord(vocabWordDraft);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setIsAddingVocabWord(false);
                              setVocabWordDraft('');
                            }
                          }}
                          placeholder="Add word…"
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            padding: '8px 10px',
                            borderRadius: '8px',
                            border: `1px solid rgba(255, 255, 255, 0.16)`,
                            background: 'rgba(0, 0, 0, 0.25)',
                            color: 'rgba(255, 255, 255, 0.92)',
                            outline: 'none',
                            fontSize: '12px',
                            marginBottom: '8px',
                          }}
                        />
                      )}

                      <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '6px',
                      }}>
                        <button
                          type="button"
                          onClick={() => {
                            setIsAddingVocabWord(true);
                            setVocabWordDraft('');
                          }}
                          title="Add"
                          style={{
                            borderRadius: '999px',
                            padding: '4px 10px',
                            border: `1px solid rgba(255, 255, 255, 0.16)`,
                            background: 'rgba(255, 255, 255, 0.06)',
                            color: 'rgba(255, 255, 255, 0.9)',
                            fontSize: '11px',
                            cursor: 'pointer',
                          }}
                        >
                          +
                        </button>
                        {(vocabWords || []).map((word) => (
                          <button
                            key={word}
                            type="button"
                            onClick={() => removeVocabWord(word)}
                            title="Remove"
                            style={{
                              borderRadius: '999px',
                              padding: '4px 10px',
                              border: `1px solid ${primary}`,
                              background: `${primary}24`,
                              color: primary,
                              fontSize: '11px',
                              cursor: 'pointer',
                            }}
                          >
                            {word}
                          </button>
                        ))}
                      </div>
                </div>
              </div>

              <SettingsSectionHeading>Snippets</SettingsSectionHeading>

              <div
                className="settings-section"
                style={{
                  width: '92%',
                  margin: '0 auto 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                }}
              >

                {/* Snippets */}
                <div>
                      <button
                        type="button"
                        onClick={addPhraseRule}
                        style={{
                          padding: '4px 0',
                          border: 'none',
                          background: 'transparent',
                          color: primary,
                          fontSize: '11px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          marginBottom: '6px',
                        }}
                      >
                        + Add snippet
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {phraseReplacementRules.map((rule) => (
                          <div
                            key={rule.id}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                              padding: '8px 10px',
                              borderRadius: '6px',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              background: 'rgba(18, 18, 24, 0.6)',
                            }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              <input
                                type="text"
                                aria-label="Spoken phrase"
                                value={rule.find}
                                placeholder="Spoken phrase…"
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setPhraseReplacementRules((prev) =>
                                    prev.map((r) => (r.id === rule.id ? { ...r, find: v } : r))
                                  );
                                }}
                                onBlur={() => void commitPhraseFindBlur(rule.id)}
                                style={{
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  border: `1px solid rgba(255, 255, 255, 0.12)`,
                                  background: 'rgba(0, 0, 0, 0.25)',
                                  color: 'rgba(255, 255, 255, 0.92)',
                                  outline: 'none',
                                  fontSize: '12px',
                                }}
                              />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              <textarea
                                aria-label="Replacement text"
                                value={rule.replace}
                                placeholder="Replacement text…"
                                rows={2}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setPhraseReplacementRules((prev) =>
                                    prev.map((r) => (r.id === rule.id ? { ...r, replace: v } : r))
                                  );
                                }}
                                onBlur={() => void commitPhraseReplaceBlur(rule.id)}
                                style={{
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  border: `1px solid rgba(255, 255, 255, 0.12)`,
                                  background: 'rgba(0, 0, 0, 0.25)',
                                  color: 'rgba(255, 255, 255, 0.92)',
                                  outline: 'none',
                                  fontSize: '12px',
                                  resize: 'vertical',
                                  minHeight: '36px',
                                  fontFamily: 'inherit',
                                }}
                              />
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                              }}
                            >
                              <label
                                title="Enabled"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  cursor: 'pointer',
                                  color: 'rgba(255, 255, 255, 0.55)',
                                  fontSize: '11px',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={rule.enabled !== false}
                                  onChange={() => void togglePhraseRule(rule.id)}
                                  style={{
                                    width: '14px',
                                    height: '14px',
                                    cursor: 'pointer',
                                    accentColor: primary,
                                  }}
                                />
                                Enabled
                              </label>
                              <button
                                type="button"
                                onClick={() => void removePhraseRule(rule.id)}
                                title="Remove"
                                style={{
                                  padding: '4px',
                                  border: 'none',
                                  background: 'transparent',
                                  color: '#ff6b6b',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  opacity: 0.7,
                                  flexShrink: 0,
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 6h18" />
                                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                  <line x1="10" y1="11" x2="10" y2="17" />
                                  <line x1="14" y1="11" x2="14" y2="17" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                </div>
              </div>

            <SettingsSectionHeading>General</SettingsSectionHeading>
            <div className="settings-section" style={{
              width: '92%',
              margin: '0 auto 12px',
            }}>
              <div className="settings-checkbox-stack">
              <div className="settings-checkbox-row">
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                borderRadius: '4px',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <input
                  type="checkbox"
                  checked={startAtLogin}
                  onChange={async (e) => {
                    const newValue = e.target.checked;
                    setStartAtLogin(newValue);
                    await window.electronAPI.interface.setStartAtLogin(newValue);
                  }}
                  style={{
                    width: '16px',
                    height: '16px',
                    margin: 0,
                    cursor: 'pointer',
                    accentColor: primary,
                    color: primary,
                  }}
                />
                <span style={{ fontSize: '12px', userSelect: 'none' }}>Start at Login</span>
              </label>
              </div>
              <div
                className="settings-checkbox-row"
                style={{
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={saveAudio}
                    onChange={async (event) => {
                      const enabled = event.target.checked;
                      setSaveAudio(enabled);
                      await window.electronAPI.interface.setSaveAudio(enabled);
                    }}
                    style={{
                      width: '16px',
                      height: '16px',
                      margin: 0,
                      cursor: 'pointer',
                      accentColor: primary,
                    }}
                  />
                  <span style={{ fontSize: '12px', userSelect: 'none' }}>Save dictation audio</span>
                </label>
                <button
                  type="button"
                  aria-label="Open audio folder"
                  title="Open audio folder"
                  onClick={() => { void window.electronAPI.audio.openFolder(); }}
                  style={{
                    border: 0,
                    padding: '4px',
                    color: primary,
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <FolderIcon />
                </button>
              </div>
              </div>
            </div>

            <SettingsSectionHeading>Activity</SettingsSectionHeading>
            <ActivityInsights />

            {/* Total words dictated (not typed) */}
            <div style={{
              marginTop: '20px',
              paddingTop: '12px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: '12px',
              color: 'rgba(255, 255, 255, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}>
              <span>Words not typed: {totalWordCount !== null ? totalWordCount.toLocaleString() : '…'}</span>
              <button
                type="button"
                onClick={() => {
                  if (exportOpen) {
                    setExportOpen(false);
                    setExportStatus(null);
                  } else {
                    void openExportPicker();
                  }
                }}
                style={{
                  border: 0,
                  padding: 0,
                  color: primary,
                  background: 'transparent',
                  cursor: 'pointer',
                  font: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                Export JSON
              </button>
            </div>

            {exportOpen && (
              <div
                role="dialog"
                aria-label="Export transcriptions"
                style={{
                  marginTop: '10px',
                  padding: '12px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '10px',
                }}
              >
                <div style={{ fontSize: '12px', fontWeight: 650, marginBottom: '10px' }}>
                  Export transcriptions
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '10px', color: 'rgba(255, 255, 255, 0.55)' }}>
                    From
                    <input
                      type="datetime-local"
                      value={exportFrom}
                      onChange={(event) => setExportFrom(event.target.value)}
                      disabled={exportBusy}
                      style={{
                        minWidth: 0,
                        width: '100%',
                        padding: '6px',
                        color: '#fff',
                        colorScheme: 'dark',
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        fontSize: '10px',
                      }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '10px', color: 'rgba(255, 255, 255, 0.55)' }}>
                    To
                    <input
                      type="datetime-local"
                      value={exportTo}
                      onChange={(event) => setExportTo(event.target.value)}
                      disabled={exportBusy}
                      style={{
                        minWidth: 0,
                        width: '100%',
                        padding: '6px',
                        color: '#fff',
                        colorScheme: 'dark',
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        fontSize: '10px',
                      }}
                    />
                  </label>
                </div>
                {exportStatus && (
                  <div role="status" style={{ marginTop: '8px', fontSize: '10px', color: 'rgba(255, 255, 255, 0.65)' }}>
                    {exportStatus}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
                  <button
                    type="button"
                    disabled={exportBusy}
                    onClick={() => { void exportTranscriptions(true); }}
                    style={{
                      padding: '6px 9px',
                      color: primary,
                      background: 'transparent',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '6px',
                      cursor: exportBusy ? 'default' : 'pointer',
                      fontSize: '11px',
                      opacity: exportBusy ? 0.5 : 1,
                    }}
                  >
                    Export all
                  </button>
                  <button
                    type="button"
                    disabled={exportBusy || !exportFrom || !exportTo}
                    onClick={() => { void exportTranscriptions(false); }}
                    style={{
                      padding: '6px 9px',
                      color: '#000',
                      background: primary,
                      border: 0,
                      borderRadius: '6px',
                      cursor: exportBusy || !exportFrom || !exportTo ? 'default' : 'pointer',
                      fontSize: '11px',
                      fontWeight: 650,
                      opacity: exportBusy || !exportFrom || !exportTo ? 0.5 : 1,
                    }}
                  >
                    {exportBusy ? 'Preparing…' : 'Export range'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

    </>
  );
};
