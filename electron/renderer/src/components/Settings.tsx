import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { hexToHsl, accentColorAtHue } from '../utils/colorUtils';
import { storageService } from '../services/StorageService';
import { ActivityInsights } from './ActivityInsights';
import { buildTranscriptionExport } from '../services/transcriptionExport';
import { DEFAULT_RECORDING_HOTKEY, normalizeRecordingHotkey, recordingHotkeyLabel, recordingHotkeyParts } from '../../../shared/recordingHotkey';
import type {
  CleanupState,
  MicrophoneInputState,
  PhraseReplacementRule,
  WritingMode,
} from '../../../shared/electron-api';
import '../styles/glass.css';
import '../styles/settings.css';

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

const ToggleTile = ({ title, description, checked, disabled = false, experimental = false, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  experimental?: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <label className="settings-tile settings-toggle-tile" data-active={checked && !disabled} data-disabled={disabled}>
    <span className="settings-tile__top">
      <span className="settings-tile__title">{title}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled}
        onChange={event => onChange(event.target.checked)} aria-label={title} />
      <span className="settings-switch" aria-hidden="true" />
    </span>
    <span className="settings-tile__description">{description}</span>
    {(disabled || experimental) && <span className="settings-tile__state">{disabled ? experimental ? 'Experimental · Requires Cleaned' : 'Requires Cleaned' : 'Experimental'}</span>}
  </label>
);

const SETTINGS_SECTIONS = [
  { id: 'activity', label: 'Activity' },
  { id: 'audio', label: 'Audio' },
  { id: 'writing', label: 'Writing' },
  { id: 'vocabulary', label: 'Vocabulary' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'general', label: 'General' },
] as const;

type SettingsSection = typeof SETTINGS_SECTIONS[number]['id'];

const SectionIcon = ({ section }: { section: SettingsSection }) => {
  const paths: Record<SettingsSection, React.ReactNode> = {
    activity: <><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" /></>,
    audio: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8" /></>,
    writing: <><path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" /></>,
    vocabulary: <><path d="M12 5v16M3 4h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 1 4 4 0 0 0-4-1H3V4Z" /></>,
    snippets: <><rect x="7" y="7" width="14" height="14" rx="3" /><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2M11 12h6m-6 4h4" /></>,
    appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    general: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="10" cy="18" r="2" fill="currentColor" stroke="none" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[section]}</svg>;
};

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
  const [recordingHotkey, setRecordingHotkey] = useState(DEFAULT_RECORDING_HOTKEY);
  const [hotkeyLoaded, setHotkeyLoaded] = useState(false);
  const [hotkeySaving, setHotkeySaving] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [lockHotkey, setLockHotkey] = useState('function+controlleft');
  const [captureTarget, setCaptureTarget] = useState<'hotkey' | 'lockHotkey' | null>(null);
  const captureTargetRef = useRef<'hotkey' | 'lockHotkey' | null>(null);
  const [captureKeys, setCaptureKeys] = useState<string[]>([]);
  const [captureStarting, setCaptureStarting] = useState(false);
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
  const [snippetDraft, setSnippetDraft] = useState<PhraseReplacementRule | null>(null);
  const [snippetBusy, setSnippetBusy] = useState(false);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const snippetInputRef = useRef<HTMLInputElement>(null);
  const snippetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [colorBarHue, setColorBarHue] = useState(0);
  const [totalWordCount, setTotalWordCount] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('activity');

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activeSection]);

  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  const handlePageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (captureTargetRef.current) {
        void window.electronAPI.interface.endHotkeyCapture();
        captureTargetRef.current = null;
        setCaptureTarget(null);
      } else onClose();
    }
  };

  useEffect(() => {
    window.electronAPI.interface.getSettings().then((settings) => {
      setRecordingHotkey(settings.hotkey ?? DEFAULT_RECORDING_HOTKEY);
      setLockHotkey(settings.lockHotkey ?? 'function+controlleft');
      setHotkeyLoaded(true);
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
    }).catch(() => setHotkeyError('Could not load recording shortcuts. Reopen Settings to try again.'));
  }, []);

  const changeRecordingHotkey = async (next: string, kind: 'hotkey' | 'lockHotkey' = 'hotkey') => {
    if (hotkeySaving) return;
    setHotkeySaving(true);
    setHotkeyError(null);
    try {
      const saved = kind === 'hotkey'
        ? await window.electronAPI.interface.setRecordingHotkey(next)
        : await window.electronAPI.interface.setRecordingLockHotkey(next);
      if (kind === 'hotkey') setRecordingHotkey(saved);
      else setLockHotkey(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not change the recording key. Please try again.';
      setHotkeyError(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      setHotkeySaving(false);
    }
  };

  const beginShortcutCapture = async (kind: 'hotkey' | 'lockHotkey') => {
    captureTargetRef.current = kind;
    setCaptureTarget(kind);
    setCaptureKeys([]);
    setHotkeyError(null);
    setCaptureStarting(true);
    try { await window.electronAPI.interface.beginHotkeyCapture(); }
    catch (error) {
      captureTargetRef.current = null;
      setCaptureTarget(null);
      setHotkeyError((error instanceof Error ? error.message : 'Could not record a shortcut.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally { setCaptureStarting(false); }
  };

  useEffect(() => {
    const unsubscribe = window.electronAPI.interface.onHotkeyCapture(capture => {
      const kind = captureTargetRef.current;
      if (!kind) return;
      if (capture.error) { setHotkeyError(capture.error); return; }
      setCaptureKeys(capture.keys);
      if (capture.cancelled || capture.complete) {
        captureTargetRef.current = null;
        setCaptureTarget(null);
        if (capture.complete) {
          const shortcut = normalizeRecordingHotkey(capture.keys.join('+'));
          if (shortcut) void changeRecordingHotkey(shortcut, kind);
        }
      }
    });
    return () => { unsubscribe(); void window.electronAPI.interface.endHotkeyCapture(); };
  }, []);

  useEffect(() => {
    if (activeSection !== 'general' && captureTargetRef.current) {
      captureTargetRef.current = null;
      setCaptureTarget(null);
      void window.electronAPI.interface.endHotkeyCapture();
    }
  }, [activeSection]);

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

  useEffect(() => {
    if (snippetDraft) snippetInputRef.current?.focus();
    else snippetTriggerRef.current?.focus();
  }, [snippetDraft?.id]);

  const persistPhraseRulesToDisk = async (next: PhraseReplacementRule[]) => {
    setSnippetBusy(true);
    setSnippetError(null);
    try {
      const saved = await window.electronAPI.interface.setPhraseReplacements(next);
      if (!saved) throw new Error('Snippet changes were not saved.');
      setPhraseReplacementRules(next);
      return true;
    } catch {
      setSnippetError('Could not save snippets. Please try again.');
      return false;
    } finally {
      setSnippetBusy(false);
    }
  };

  const addPhraseRule = (trigger: HTMLButtonElement) => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `pr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    snippetTriggerRef.current = trigger;
    setSnippetError(null);
    setSnippetDraft({ id, find: '', replace: '', enabled: true });
  };

  const removePhraseRule = async (id: string) => {
    const next = phraseReplacementRules.filter((r) => r.id !== id);
    if (await persistPhraseRulesToDisk(next)) {
      if (snippetDraft?.id === id) setSnippetDraft(null);
    }
  };

  const editPhraseRule = (rule: PhraseReplacementRule, trigger: HTMLButtonElement) => {
    if (snippetDraft) return;
    snippetTriggerRef.current = trigger;
    setSnippetError(null);
    setSnippetDraft({ ...rule });
  };

  const cancelSnippetEdit = () => {
    setSnippetDraft(null);
    setSnippetError(null);
  };

  const saveSnippetEdit = async () => {
    if (!snippetDraft || !snippetDraft.find.trim() || snippetBusy) return;
    const rule = { ...snippetDraft, find: snippetDraft.find.trim() };
    const exists = phraseReplacementRules.some(item => item.id === rule.id);
    const next = exists ? phraseReplacementRules.map(item => item.id === rule.id ? rule : item)
      : [rule, ...phraseReplacementRules];
    if (await persistPhraseRulesToDisk(next)) setSnippetDraft(null);
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
      const [h] = hexToHsl(primary);
      setColorBarHue(previous => h === 0 && previous === 360 ? 360 : h);
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

  const snippetEditor = snippetDraft && (
    <form className="settings-snippet-editor" aria-label="Edit snippet"
      onSubmit={event => { event.preventDefault(); void saveSnippetEdit(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!snippetBusy) cancelSnippetEdit();
        }
      }}>
      <label>Spoken phrase<input ref={snippetInputRef} type="text" value={snippetDraft.find} maxLength={200}
        placeholder="e.g. my signature" disabled={snippetBusy}
        onChange={event => setSnippetDraft({ ...snippetDraft, find: event.target.value })} /></label>
      <label>Replacement text<textarea value={snippetDraft.replace} rows={3} maxLength={1000}
        placeholder="The text Memo will insert…" disabled={snippetBusy}
        onChange={event => setSnippetDraft({ ...snippetDraft, replace: event.target.value })} /></label>
      <div className="settings-snippet-editor__footer">
        <label className="settings-snippet-enabled"><input type="checkbox" checked={snippetDraft.enabled !== false}
          disabled={snippetBusy} onChange={event => setSnippetDraft({ ...snippetDraft, enabled: event.target.checked })} />Enabled</label>
        <div className="settings-actions">
          <button type="button" className="settings-button" disabled={snippetBusy} onClick={cancelSnippetEdit}>Cancel</button>
          <button type="submit" className="settings-button settings-button--primary" disabled={snippetBusy || !snippetDraft.find.trim()}>
            {snippetBusy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </form>
  );

  return (
    <div className="settings-page settings-dashboard" ref={pageRef} role="region" aria-label="Settings" tabIndex={-1}
      onKeyDown={handlePageKeyDown}>
        <div className="settings-shell">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map(section => (
              <button key={section.id} type="button" className="settings-nav-item"
                aria-label={section.label} title={section.label}
                aria-current={activeSection === section.id ? 'page' : undefined}
                aria-controls={`settings-panel-${section.id}`}
                onClick={() => setActiveSection(section.id)}>
                <SectionIcon section={section.id} />
                <span>{section.label}</span>
              </button>
            ))}
          </nav>
          <main className="settings-content" ref={contentRef}>
            <section id="settings-panel-activity" className="settings-panel" aria-label="Activity" hidden={activeSection !== 'activity'}>
              <section className="settings-activity-panel" aria-label="Dictation activity">
                <ActivityInsights />
                <div className="settings-lifetime">
                  <span><strong>{totalWordCount !== null ? totalWordCount.toLocaleString() : '…'}</strong> words not typed · all time</span>
                  <button type="button" className="settings-text-button settings-text-button--accent" aria-expanded={exportOpen} aria-controls="settings-export"
                    onClick={() => {
                      if (exportOpen) { setExportOpen(false); setExportStatus(null); }
                      else { void openExportPicker(); }
                    }}>Export JSON <span aria-hidden="true">↗</span></button>
                </div>
                {exportOpen && (
                  <section id="settings-export" className="settings-export" aria-label="Export transcriptions">
                    <h2>Export transcriptions</h2>
                    <p className="settings-help">Save all your transcriptions or choose a time range.</p>
                    <div className="settings-export__dates">
                      <label>From<input type="datetime-local" value={exportFrom} disabled={exportBusy}
                        onChange={event => setExportFrom(event.target.value)} /></label>
                      <label>To<input type="datetime-local" value={exportTo} disabled={exportBusy}
                        onChange={event => setExportTo(event.target.value)} /></label>
                    </div>
                    {exportStatus && <p role="status" className="settings-help">{exportStatus}</p>}
                    <div className="settings-actions">
                      <button type="button" className="settings-button" disabled={exportBusy}
                        onClick={() => void exportTranscriptions(true)}>Export all</button>
                      <button type="button" className="settings-button settings-button--primary" disabled={exportBusy || !exportFrom || !exportTo}
                        onClick={() => void exportTranscriptions(false)}>{exportBusy ? 'Preparing…' : 'Export range'}</button>
                    </div>
                  </section>
                )}
              </section>
            </section>
            <section id="settings-panel-audio" className="settings-panel" aria-label="Audio" hidden={activeSection !== 'audio'}>
              <div className="settings-grid">
                <section className="settings-tile settings-tile--wide" aria-labelledby="settings-input-title">
                  <h3 id="settings-input-title" className="settings-sr-only">Microphone</h3>
                  <p className="settings-help">Choose where Memo listens.</p>
                  <label className="settings-sr-only" htmlFor="microphone-input">Mic input</label>
                  <select id="microphone-input" value={microphoneValue} disabled={!microphoneState || microphoneSelecting}
                    onChange={event => void selectMicrophone(event.target.value)}>
                    {microphoneState?.selectedDeviceName && selectedMicrophoneIndex < 0 && (
                      <option value="unavailable" disabled>{microphoneState.selectedDeviceName} — Unavailable</option>
                    )}
                    <option value="system-default">{microphoneState?.defaultDeviceName ? `System Default — ${microphoneState.defaultDeviceName}` : 'System Default'}</option>
                    {microphoneState?.devices.map((device, index) => <option key={device.name} value={`device-${index}`}>{device.name}</option>)}
                  </select>
                  {microphoneError && <p role="alert" className="settings-error">{microphoneError}</p>}
                </section>

                <ToggleTile title="Hands free" checked={handsFreeMode}
                  description={`Speak to record. Pause to transcribe. The ${recordingHotkeyLabel(recordingHotkey)} key still works.`}
                  onChange={async enabled => { setHandsFreeMode(enabled); await window.electronAPI.interface.setHandsFreeMode(enabled); }} />
                <ToggleTile title='Say “ENTER” to submit' checked={sayEnterToPressEnter}
                  description='End dictation with “enter” to paste and press Return.'
                  onChange={async enabled => { setSayEnterToPressEnter(enabled); await window.electronAPI.interface.setSayEnterToPressEnter(enabled); }} />
              </div>
            </section>
            <section id="settings-panel-writing" className="settings-panel" aria-label="Writing" hidden={activeSection !== 'writing'}>
              <div className="settings-grid">
                <section className="settings-tile settings-tile--wide" data-active={writingMode === 'clean'} aria-labelledby="settings-writing-title">
                  <div className="settings-tile__top"><span className="settings-badge">{writingMode === 'clean' ? 'Cleaned' : 'As spoken'}</span></div>
                  <h3 id="settings-writing-title" className="settings-sr-only">Writing mode</h3>
                  <p className="settings-help">As spoken keeps your words. Cleaned adds punctuation and layout locally.</p>
                  <label className="settings-sr-only" htmlFor="writing-mode">Writing mode</label>
                  <select id="writing-mode" value={writingMode} disabled={cleanedRemoving}
                    onChange={async event => {
                      const mode = event.target.value as WritingMode;
                      const previousMode = writingMode;
                      setWritingMode(mode);
                      const accepted = await window.electronAPI.interface.setWritingMode(mode);
                      if (!accepted) setWritingMode(previousMode);
                    }}>
                    <option value="as-spoken">As spoken — Included</option>
                    <option value="clean">Cleaned – 1.03 GB model download</option>
                  </select>
                  {writingMode === 'clean' && <p role="status" className="settings-help">
                    {cleanupState.status === 'ready' ? 'Ready · runs locally' : cleanupState.status === 'downloading'
                      ? cleanupState.detail || 'Downloading Cleaned…' : cleanupState.status === 'loading'
                        ? 'Loading LFM locally…' : cleanupState.detail || 'Downloads once when selected, then runs locally.'}
                  </p>}
                  {cleanupState.installed && <div className="settings-download">
                    <span>Stored locally. Removing switches to As spoken.</span>
                    <button type="button" className="settings-text-button settings-text-button--danger" onClick={() => void removeCleaned()}
                      disabled={cleanedRemoving || cleanupState.status === 'downloading' || cleanupState.status === 'loading'}
                      aria-label="Remove Cleaned download">{cleanedRemoving ? 'Removing…' : 'Remove download'}</button>
                  </div>}
                  {cleanupActionError && <p role="alert" className="settings-error">{cleanupActionError}</p>}
                </section>
                <ToggleTile experimental title="Email formatting" checked={experimentalEmailFormatting} disabled={writingMode !== 'clean'}
                  description="In Cleaned mode, formats Gmail and all Safari dictation as email using the app and URL locally."
                  onChange={async enabled => { if (await window.electronAPI.interface.setExperimentalEmailFormatting(enabled)) setExperimentalEmailFormatting(enabled); }} />
              </div>
            </section>
            <section id="settings-panel-vocabulary" className="settings-panel" aria-label="Vocabulary" hidden={activeSection !== 'vocabulary'}>
              <div className="settings-grid">
                <section className="settings-tile settings-tile--wide" aria-labelledby="settings-vocab-title">
                  <div className="settings-tile__top"><span className="settings-badge">{vocabWords.length} words</span></div>
                  <h3 id="settings-vocab-title" className="settings-sr-only">Vocabulary</h3>
                  <p className="settings-help">Help Memo recognize names and words you use.</p>
                  <div className="settings-vocab">
                    {(vocabWords || []).map(word => <button key={word} type="button" className="settings-word"
                      onClick={() => void removeVocabWord(word)} aria-label={`Remove ${word}`} title={`Remove ${word}`}>{word}<span aria-hidden="true">×</span></button>)}
                    {!isAddingVocabWord && <button type="button" className="settings-button settings-button--accent" onClick={() => { setIsAddingVocabWord(true); setVocabWordDraft(''); }}>+ Add word</button>}
                  </div>
                  {isAddingVocabWord && <form className="settings-vocab-form" onSubmit={event => { event.preventDefault(); void addVocabWord(vocabWordDraft); }}>
                    <label className="settings-sr-only" htmlFor="settings-new-word">New vocabulary word</label>
                    <input id="settings-new-word" ref={vocabInputRef} type="text" value={vocabWordDraft}
                      onChange={event => setVocabWordDraft(event.target.value)} placeholder="Name or word…"
                      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setIsAddingVocabWord(false); setVocabWordDraft(''); } }} />
                    <button type="submit" className="settings-button settings-button--primary" disabled={!vocabWordDraft.trim()}>Add</button>
                    <button type="button" className="settings-text-button" onClick={() => { setIsAddingVocabWord(false); setVocabWordDraft(''); }}>Cancel</button>
                  </form>}
                </section>
              </div>
            </section>
            <section id="settings-panel-snippets" className="settings-panel" aria-label="Snippets" hidden={activeSection !== 'snippets'}>
              <div className="settings-snippet-section">
                <div className="settings-snippet-toolbar">
                  <span className="settings-badge">{phraseReplacementRules.length} {phraseReplacementRules.length === 1 ? 'snippet' : 'snippets'}</span>
                  <button type="button" className="settings-button settings-snippet-add" disabled={snippetBusy || !!snippetDraft}
                    onClick={event => addPhraseRule(event.currentTarget)}>Add new</button>
                </div>
                <p className="settings-help">Replace a spoken phrase with your saved text.</p>
                {snippetDraft && !phraseReplacementRules.some(rule => rule.id === snippetDraft.id) && snippetEditor}
                <div className="settings-snippets" role="list" aria-label="Saved snippets">
                  {phraseReplacementRules.map(rule => <div key={rule.id} className="settings-snippet" role="listitem"
                    data-disabled={rule.enabled === false} data-editing={snippetDraft?.id === rule.id}>
                    <div className="settings-snippet-row">
                      <button type="button" className="settings-snippet-preview" disabled={snippetBusy || (!!snippetDraft && snippetDraft.id !== rule.id)}
                        aria-label={`Edit snippet: ${rule.find}`} title={`${rule.find} → ${rule.replace}`}
                        aria-expanded={snippetDraft?.id === rule.id} onClick={event => editPhraseRule(rule, event.currentTarget)}>
                        <span className="settings-snippet-phrase">{rule.find}</span><span aria-hidden="true">→</span>
                        <span className="settings-snippet-replacement">{rule.replace || 'Empty replacement'}</span>
                      </button>
                      {rule.enabled === false && <span className="settings-snippet-paused" title="Disabled">Off</span>}
                      <div className="settings-snippet-row__actions">
                        <button type="button" disabled={snippetBusy || (!!snippetDraft && snippetDraft.id !== rule.id)} aria-label={`Edit ${rule.find}`} title="Edit snippet"
                          onClick={event => editPhraseRule(rule, event.currentTarget)}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" />
                          </svg>
                        </button>
                        <button type="button" disabled={snippetBusy || !!snippetDraft} aria-label={`Delete ${rule.find}`} title="Delete snippet"
                          onClick={() => void removePhraseRule(rule.id)}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {snippetDraft?.id === rule.id && snippetEditor}
                  </div>)}
                </div>
                {!phraseReplacementRules.length && !snippetDraft && <p className="settings-snippet-empty">No snippets yet. Add a phrase you often say.</p>}
                {snippetError && <p role="alert" className="settings-error">{snippetError}</p>}
              </div>
            </section>
            <section id="settings-panel-appearance" className="settings-panel" aria-label="Appearance" hidden={activeSection !== 'appearance'}>
              <div className="settings-grid">
                <section className="settings-tile settings-appearance" aria-labelledby="settings-appearance-title">
                  <div className="settings-tile__top"><span className="settings-color-dot" style={{ background: primary }} aria-hidden="true" /></div>
                  <h3 id="settings-appearance-title" className="settings-sr-only">Accent color</h3>
                  <p className="settings-help">Choose your accent color.</p>
                  <label className="settings-sr-only" htmlFor="settings-hue">Accent color hue</label>
                  <input id="settings-hue" className="settings-hue" type="range" min="0" max="360" value={colorBarHue}
                    aria-valuetext={`${colorBarHue} degrees, ${primary}`}
                    onChange={event => { const hue = Number(event.target.value); setColorBarHue(hue); setPrimary(accentColorAtHue(hue, primary)); }} />
                  <span className="settings-tile__state settings-color-value">{primary.toUpperCase()}</span>
                </section>
              </div>
            </section>
            <section id="settings-panel-general" className="settings-panel" aria-label="General" hidden={activeSection !== 'general'}>
              <div className="settings-grid">
                <section className="settings-shortcuts" aria-label="Recording shortcuts" aria-busy={hotkeySaving}>
                  {([
                    { kind: 'hotkey', title: 'Push to talk', description: 'Hold to record. Release to transcribe.', value: recordingHotkey, fallback: DEFAULT_RECORDING_HOTKEY },
                    { kind: 'lockHotkey', title: 'Recording lock', description: 'Press to start recording. Press again to stop.', value: lockHotkey, fallback: 'function+controlleft' },
                  ] as const).map(shortcut => <div key={shortcut.kind} className="settings-shortcut-row">
                    <div className="settings-shortcut-copy"><h3>{shortcut.title}</h3><p>{shortcut.description}</p></div>
                    <div className="settings-shortcut-controls">
                      <button type="button" className="settings-shortcut-recorder" data-listening={captureTarget === shortcut.kind}
                        aria-label={`Record ${shortcut.title.toLowerCase()} shortcut`}
                        disabled={!hotkeyLoaded || hotkeySaving || (captureTarget !== null && captureTarget !== shortcut.kind) || captureStarting}
                        onClick={() => { if (!captureTarget) void beginShortcutCapture(shortcut.kind); }}>
                        <span className="settings-shortcut-keys">
                          {captureTarget === shortcut.kind && captureKeys.length === 0 ? <span>{captureStarting ? 'Preparing…' : 'Press keys…'}</span>
                            : (captureTarget === shortcut.kind ? captureKeys.map(key => recordingHotkeyLabel(key)) : recordingHotkeyParts(shortcut.value).map(key => shortcut.kind === 'lockHotkey' && normalizeRecordingHotkey(shortcut.value) === 'function+controlleft' && key === 'Left Control' ? 'Control' : key)).map((key, index) => <kbd key={index}>{key}</kbd>)}
                        </span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" /></svg>
                      </button>
                      <button type="button" className="settings-text-button" disabled={!hotkeyLoaded || hotkeySaving || captureTarget !== null || normalizeRecordingHotkey(shortcut.value) === normalizeRecordingHotkey(shortcut.fallback)}
                        onClick={() => { void changeRecordingHotkey(shortcut.fallback, shortcut.kind); }}>Reset</button>
                    </div>
                  </div>)}
                  {(captureTarget || hotkeySaving) && <p className="settings-help" role="status">{captureTarget ? 'Press and release your shortcut. Escape cancels.' : 'Saving shortcut…'}</p>}
                  {captureTarget && <button type="button" className="settings-text-button" onClick={() => { void window.electronAPI.interface.endHotkeyCapture(); }}>Cancel</button>}
                  {hotkeyError && <p className="settings-error" role="alert">{hotkeyError}</p>}
                </section>
                <ToggleTile title="Start at login" checked={startAtLogin} description="Have Memo ready when you open your Mac."
                  onChange={async enabled => { setStartAtLogin(enabled); await window.electronAPI.interface.setStartAtLogin(enabled); }} />
                <div className="settings-audio-tile">
                  <ToggleTile title="Save dictation audio" checked={saveAudio} description="Keep recordings alongside your transcriptions."
                    onChange={async enabled => { setSaveAudio(enabled); await window.electronAPI.interface.setSaveAudio(enabled); }} />
                  <button type="button" className="settings-folder" aria-label="Open audio folder" title="Open audio folder"
                    onClick={() => { void window.electronAPI.audio.openFolder(); }}><FolderIcon /><span>Open folder</span></button>
                </div>
              </div>
            </section>
            <footer className="settings-footer">{activeSection === 'snippets' ? 'Snippet edits save when you select Save.' : 'Changes save automatically.'}</footer>
          </main>
        </div>
    </div>
  );
};
