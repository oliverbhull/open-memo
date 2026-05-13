import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { QRCodeDisplay } from './QRCodeDisplay';
import { syncOrchestrator, SyncStatus } from '../services/SyncOrchestrator';
import { createPortal } from 'react-dom';
import { VoiceCommandSettings, AppConfig, AppCommand } from './VoiceCommandSettings';
import { hexToHsl, hslToHex } from '../utils/colorUtils';
import { storageService } from '../services/StorageService';
import '../styles/glass.css';
import '../styles/color-picker.css';

interface SettingsProps {
  onClose: () => void;
}

interface PhraseReplacementRule {
  id: string;
  find: string;
  replace: string;
  enabled?: boolean;
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { primary, setPrimary } = useTheme();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [showSyncQR, setShowSyncQR] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<{ ip: string; port: number; token: string } | null>(null);
  const [voiceCommandsEnabled, setVoiceCommandsEnabled] = useState(false);
  const [voiceCommandApps, setVoiceCommandApps] = useState<AppConfig[]>([]);
  const [globalCommands, setGlobalCommands] = useState<AppCommand[]>([]);
  const [deviceUid, setDeviceUid] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectedDeviceName, setConnectedDeviceName] = useState<string | null>(null);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [pressEnterAfterPaste, setPressEnterAfterPaste] = useState(false);
  const [pushToTalkMode, setPushToTalkMode] = useState(false);
  const [handsFreeMode, setHandsFreeMode] = useState(false);
  const [sayEnterToPressEnter, setSayEnterToPressEnter] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [vocabWords, setVocabWords] = useState<string[]>([]);
  const [isAddingVocabWord, setIsAddingVocabWord] = useState(false);
  const [vocabWordDraft, setVocabWordDraft] = useState('');
  const vocabInputRef = useRef<HTMLInputElement>(null);
  const [bluetoothExpanded, setBluetoothExpanded] = useState(false);
  const [vocabExpanded, setVocabExpanded] = useState(false);
  const [phraseReplacementsExpanded, setPhraseReplacementsExpanded] = useState(false);
  const [phraseReplacementRules, setPhraseReplacementRules] = useState<PhraseReplacementRule[]>([]);
  const [voiceCommandsExpanded, setVoiceCommandsExpanded] = useState(false);
  const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const colorBarSpectrumRef = useRef<HTMLDivElement>(null);
  const [colorBarHue, setColorBarHue] = useState(0);
  const [colorBarSaturation, setColorBarSaturation] = useState(100);
  const [colorBarLightness, setColorBarLightness] = useState(50);
  const [totalWordCount, setTotalWordCount] = useState<number | null>(null);

  // Load device connection state on mount
  useEffect(() => {
    const loadConnectionState = async () => {
      try {
        const state = await window.electronAPI.device.getConnectionState();
        console.log('[Settings] Loaded connection state:', state);
        setIsConnected(state.connected);
        setConnectedDeviceName(state.deviceName);
        setBatteryLevel(state.batteryLevel ?? null);
        // Always set deviceUid if available (for display in input field)
        if (state.deviceUid) {
          setDeviceUid(state.deviceUid);
        }
      } catch (error) {
        console.error('[Settings] Failed to load device connection state:', error);
      }
    };
    
    // Load initial state immediately
    loadConnectionState();
    
    // Load interface settings
    window.electronAPI.interface.getSettings().then((settings) => {
      setPressEnterAfterPaste(settings.pressEnterAfterPaste);
      setSayEnterToPressEnter(settings.sayEnterToPressEnter ?? false);
      setPushToTalkMode(settings.pushToTalkMode ?? false);
      setHandsFreeMode(settings.handsFreeMode ?? false);
      setStartAtLogin(settings.startAtLogin);
      setVocabWords(Array.isArray(settings.vocabWords) ? settings.vocabWords : []);
      setPhraseReplacementRules(
        Array.isArray(settings.phraseReplacements) ? settings.phraseReplacements : []
      );
    });
    
    // Also refresh state periodically (every 2 seconds) to catch any missed updates
    const refreshInterval = setInterval(() => {
      loadConnectionState();
    }, 2000);
    
    // Listen for connection changes - this will update UI in real-time
    const unsubscribeConnection = window.electronAPI.device.onConnectionChanged((state) => {
      console.log('[Settings] Connection changed event received:', state);
      setIsConnected(state.connected);
      setConnectedDeviceName(state.deviceName);
      setBatteryLevel(state.batteryLevel ?? null);
      // Always update deviceUid if provided
      if (state.deviceUid) {
        setDeviceUid(state.deviceUid);
      }
      // Clear connecting state when device is actually connected
      if (state.connected) {
        setIsConnecting(false);
        // Clear any pending timeout
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
      }
    });
    
    return () => {
      unsubscribeConnection();
      clearInterval(refreshInterval);
      // Clean up any pending connection timeout
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
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
    setPhraseReplacementRules((prev) => [...prev, { id, find: '', replace: '', enabled: true }]);
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
    let next: PhraseReplacementRule[] = [];
    setPhraseReplacementRules((prev) => {
      const row = prev.find((r) => r.id === id);
      if (!row) {
        next = prev;
        return prev;
      }
      const trimmed = row.find.trim();
      next = !trimmed ? prev.filter((r) => r.id !== id) : prev.map((r) => (r.id === id ? { ...r, find: trimmed } : r));
      return next;
    });
    await persistPhraseRulesToDisk(next);
  };

  const commitPhraseReplaceBlur = async (id: string) => {
    let next: PhraseReplacementRule[] = [];
    setPhraseReplacementRules((prev) => {
      const row = prev.find((r) => r.id === id);
      if (!row) {
        next = prev;
        return prev;
      }
      next = prev.map((r) => (r.id === id ? { ...r, replace: row.replace } : r));
      return next;
    });
    await persistPhraseRulesToDisk(next);
  };

  const addVocabWord = async (raw: string) => {
    const word = normalizeVocabWord(raw);
    if (!word) return;
    const deduped = Array.from(new Set([...(vocabWords || []), word]));
    await persistVocabWords(deduped);
    setVocabWordDraft('');
    setIsAddingVocabWord(false);
  };

  const removeVocabWord = async (word: string) => {
    const next = (vocabWords || []).filter((w) => w !== word);
    await persistVocabWords(next);
  };

  // Sync color bar state from primary
  useEffect(() => {
    if (primary) {
      const [h, s, l] = hexToHsl(primary);
      setColorBarHue(h);
      setColorBarSaturation(s);
      setColorBarLightness(l);
    }
  }, [primary]);

  // Load voice command settings on mount
  useEffect(() => {
    window.electronAPI.voiceCommands.getSettings().then((settings) => {
      setVoiceCommandsEnabled(settings.enabled || false);
      setVoiceCommandApps(settings.apps || []);
      setGlobalCommands(settings.globalCommands || []);
    });
  }, []);

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

  const handleVoiceCommandsEnabledChange = async (enabled: boolean) => {
    setVoiceCommandsEnabled(enabled);
    await window.electronAPI.voiceCommands.saveSettings({
      enabled,
      apps: voiceCommandApps,
      globalCommands: globalCommands,
      urlPatterns: [],
    });
  };

  const handleVoiceCommandAppsChange = async (apps: AppConfig[]) => {
    setVoiceCommandApps(apps);
    await window.electronAPI.voiceCommands.saveSettings({
      enabled: voiceCommandsEnabled,
      apps,
      globalCommands: globalCommands,
      urlPatterns: [],
    });
  };

  const handleGlobalCommandsChange = async (commands: AppCommand[]) => {
    setGlobalCommands(commands);
    await window.electronAPI.voiceCommands.saveSettings({
      enabled: voiceCommandsEnabled,
      apps: voiceCommandApps,
      globalCommands: commands,
      urlPatterns: [],
    });
  };

  // Monitor sync status
  useEffect(() => {
    syncOrchestrator.getStatus().then(setSyncStatus);

    const unsubscribe = syncOrchestrator.onStatusChange((newStatus) => {
      setSyncStatus(newStatus);
      if (newStatus === 'listening') {
        syncOrchestrator.getConnectionInfo().then((info) => {
          if (info) {
            setConnectionInfo(info);
            setShowSyncQR(true);
          }
        });
      } else if (newStatus === 'connected' || newStatus === 'idle') {
        setShowSyncQR(false);
        if (newStatus === 'idle') {
          setConnectionInfo(null);
        }
      }
    });

    return unsubscribe;
  }, []);

  const handleStopSync = useCallback(async () => {
    await syncOrchestrator.stopListening();
    setShowSyncQR(false);
    setConnectionInfo(null);
  }, []);

  const handleConnect = async () => {
    if (!deviceUid || deviceUid.length !== 5) {
      alert('Please enter a 5-digit UID');
      return;
    }
    
    // Clear any existing timeout
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    
    setIsConnecting(true);
    
    // Set a timeout to clear connecting state if connection takes too long (30 seconds)
    connectTimeoutRef.current = setTimeout(() => {
      setIsConnecting(false);
      connectTimeoutRef.current = null;
      alert('Connection timed out. Please try again.');
    }, 30000);
    
    try {
      const result = await window.electronAPI.device.connectByUid(deviceUid.toUpperCase());
      if (!result.success) {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        setIsConnecting(false);
        alert(`Failed to connect: ${result.error || 'Unknown error'}`);
        return;
      }
      // Connection state will be updated via connectionChanged event
      // isConnecting will be cleared when state.connected becomes true
      // Timeout will be cleared in the connectionChanged handler when connected: true
    } catch (error) {
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      setIsConnecting(false);
      console.error('Failed to connect:', error);
      alert('Failed to connect to device');
    }
    // Note: We don't clear isConnecting here - it will be cleared when
    // the connectionChanged event fires with connected: true, or on timeout/error above
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const result = await window.electronAPI.device.disconnect();
      if (result.success) {
        setIsConnected(false);
        setConnectedDeviceName(null);
      } else {
        console.error('Failed to disconnect:', result.error);
      }
    } catch (error) {
      console.error('Failed to disconnect:', error);
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleResetSavedDevice = async () => {
    try {
      const result = await window.electronAPI.device.clearSavedDevice();
      if (result.success) {
        setDeviceUid('');
        setConnectedDeviceName(null);
        setIsConnected(false);
      } else {
        console.error('Failed to reset saved device:', result.error);
      }
    } catch (error) {
      console.error('Failed to reset saved device:', error);
    }
  };

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

            {/* Interface Section */}
            <div style={{
              height: '1px',
              background: 'rgba(255, 255, 255, 0.08)',
              margin: '12px 0',
            }} />

            <div
              className="settings-section"
              style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
            >
                {/* Say 'enter' to press Enter */}
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '2px 4px',
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

                {/* Hands Free */}
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '2px 4px',
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
                    checked={handsFreeMode}
                    onChange={async (e) => {
                      const newValue = e.target.checked;
                      setHandsFreeMode(newValue);
                      await window.electronAPI.interface.setHandsFreeMode(newValue);
                    }}
                    style={{
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer',
                      accentColor: primary,
                      color: primary,
                    }}
                  />
                  <span style={{
                    fontSize: '12px',
                    userSelect: 'none',
                  }}>
                    Hands Free
                  </span>
                </label>

                {/* Start at Login */}
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '2px 4px',
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
                    checked={startAtLogin}
                    onChange={async (e) => {
                      const newValue = e.target.checked;
                      setStartAtLogin(newValue);
                      await window.electronAPI.interface.setStartAtLogin(newValue);
                    }}
                    style={{
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer',
                      accentColor: primary,
                      color: primary,
                    }}
                  />
                  <span style={{
                    fontSize: '12px',
                    userSelect: 'none',
                  }}>
                    Start at Login
                  </span>
                </label>

                {/* Vocab (STT boosting) */}
                <div style={{
                  marginTop: '8px',
                }}>
                  <button
                    type="button"
                    onClick={() => setVocabExpanded((v) => !v)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '5px 4px',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: primary,
                      cursor: 'pointer',
                      marginBottom: vocabExpanded ? '6px' : '0',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 650, letterSpacing: '0.01em' }}>Vocab</span>
                    <span style={{ opacity: 0.75, fontSize: '12px' }}>
                      {vocabExpanded ? '▾' : '▸'}
                    </span>
                  </button>

                  {vocabExpanded && (
                    <div style={{
                      padding: '4px 0 0',
                      borderRadius: '0',
                      border: 'none',
                      background: 'transparent',
                    }}>
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
                  )}
                </div>

                {/* Phrase replacement */}
                <div style={{
                  marginTop: '4px',
                }}>
                  <button
                    type="button"
                    onClick={() => setPhraseReplacementsExpanded((v) => !v)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '5px 4px',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: primary,
                      cursor: 'pointer',
                      marginBottom: phraseReplacementsExpanded ? '6px' : '0',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 650, letterSpacing: '0.01em' }}>Phrase replacement</span>
                    <span style={{ opacity: 0.75, fontSize: '12px' }}>
                      {phraseReplacementsExpanded ? '▾' : '▸'}
                    </span>
                  </button>

                  {phraseReplacementsExpanded && (
                    <div style={{
                      padding: '4px 0 0',
                      borderRadius: '0',
                      border: 'none',
                      background: 'transparent',
                    }}>
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
                        + Add rule
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
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              <span style={{ fontSize: '11px', opacity: 0.55 }}>
                                Phrase
                              </span>
                              <input
                                type="text"
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
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              <span style={{ fontSize: '11px', opacity: 0.55 }}>
                                Replace with
                              </span>
                              <textarea
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
                            </label>
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
                  )}
                </div>
              </div>

            {/* Voice Commands Section */}
            <div style={{
              display: 'none',
            }} />

            <div className="settings-section">
              <button
                type="button"
                onClick={() => setVoiceCommandsExpanded((v) => !v)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  padding: '5px 4px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: primary,
                  cursor: 'pointer',
                  marginBottom: voiceCommandsExpanded ? '6px' : '0',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 650, letterSpacing: '0.01em' }}>Voice Commands</span>
                <span style={{ opacity: 0.75, fontSize: '12px' }}>
                  {voiceCommandsExpanded ? '▾' : '▸'}
                </span>
              </button>

              {voiceCommandsExpanded && (
                <div style={{
                  padding: '4px 0 0',
                  borderRadius: '0',
                  border: 'none',
                  background: 'transparent',
                }}>
                  <VoiceCommandSettings
                    enabled={voiceCommandsEnabled}
                    apps={voiceCommandApps}
                    globalCommands={globalCommands}
                    onEnabledChange={handleVoiceCommandsEnabledChange}
                    onAppsChange={handleVoiceCommandAppsChange}
                    onGlobalCommandsChange={handleGlobalCommandsChange}
                  />
                </div>
              )}
            </div>

            {/* Bluetooth (collapsed by default) */}
            <div style={{
              display: 'none',
            }} />

            <div className="settings-section">
              <button
                type="button"
                onClick={() => setBluetoothExpanded((v) => !v)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  padding: '5px 4px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  color: primary,
                  cursor: 'pointer',
                  marginBottom: bluetoothExpanded ? '6px' : '0',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 650, letterSpacing: '0.01em' }}>Bluetooth</span>
                <span style={{ opacity: 0.75, fontSize: '12px' }}>
                  {bluetoothExpanded ? '▾' : '▸'}
                </span>
              </button>

              {bluetoothExpanded && (
                <div style={{
                  padding: '4px 0 0',
                  borderRadius: '0',
                  border: 'none',
                  background: 'transparent',
                  marginBottom: '6px',
                }}>
                  {/* Pairing / Connection */}
                  {isConnected ? (
                    <>
                      <div style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: `1px solid ${primary}`,
                        borderRadius: '6px',
                        padding: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: primary,
                          }} />
                          <div style={{ fontSize: '12px', fontWeight: 600 }}>
                            {connectedDeviceName || 'Memo Device'}
                          </div>
                        </div>
                        <button
                          onClick={handleDisconnect}
                          disabled={isDisconnecting}
                          style={{
                            padding: '4px 8px',
                            background: 'rgba(255, 0, 0, 0.2)',
                            border: '1px solid rgba(255, 0, 0, 0.3)',
                            borderRadius: '4px',
                            color: '#ff6b6b',
                            cursor: isDisconnecting ? 'default' : 'pointer',
                            fontSize: '11px',
                            fontWeight: '600',
                            opacity: isDisconnecting ? 0.5 : 1,
                          }}
                        >
                          {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={handleResetSavedDevice}
                        style={{
                          marginTop: '6px',
                          padding: '4px 0',
                          background: 'none',
                          border: 'none',
                          color: 'rgba(255, 255, 255, 0.5)',
                          cursor: 'pointer',
                          fontSize: '10px',
                          textDecoration: 'underline',
                        }}
                      >
                        Reset saved device
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={deviceUid}
                          onChange={(e) => {
                            const value = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '');
                            if (value.length <= 5) {
                              setDeviceUid(value);
                            }
                          }}
                          placeholder="UID"
                          maxLength={5}
                          pattern="[0-9A-Fa-f]{5}"
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '6px',
                            color: '#fff',
                            fontSize: '12px',
                            fontFamily: 'monospace',
                            textTransform: 'uppercase',
                          }}
                        />
                        <button
                          onClick={handleConnect}
                          disabled={deviceUid.length !== 5 || isConnecting}
                          style={{
                            padding: '6px 12px',
                            background: deviceUid.length === 5 && !isConnecting ? primary : 'rgba(255, 255, 255, 0.1)',
                            border: 'none',
                            borderRadius: '6px',
                            color: deviceUid.length === 5 && !isConnecting ? '#000' : '#fff',
                            cursor: deviceUid.length === 5 && !isConnecting ? 'pointer' : 'default',
                            fontSize: '12px',
                            fontWeight: '600',
                            opacity: deviceUid.length !== 5 || isConnecting ? 0.5 : 1,
                          }}
                        >
                          {isConnecting ? 'Connecting…' : 'Connect'}
                        </button>
                      </div>
                    </>
                  )}

                  <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.08)', margin: '10px 0' }} />

                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    marginBottom: '6px',
                    padding: '4px',
                    borderRadius: '6px',
                    transition: 'background 0.2s',
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      checked={pressEnterAfterPaste}
                      onChange={async (e) => {
                        const newValue = e.target.checked;
                        setPressEnterAfterPaste(newValue);
                        await window.electronAPI.interface.setPressEnterAfterPaste(newValue);
                      }}
                      style={{
                        width: '16px',
                        height: '16px',
                        cursor: 'pointer',
                        accentColor: primary,
                        color: primary,
                      }}
                    />
                    <span style={{ fontSize: '12px', userSelect: 'none' }}>
                      Double-tap Enter
                    </span>
                  </label>

                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    marginBottom: '6px',
                    padding: '4px',
                    borderRadius: '6px',
                    transition: 'background 0.2s',
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      checked={pushToTalkMode}
                      onChange={async (e) => {
                        const newValue = e.target.checked;
                        setPushToTalkMode(newValue);
                        await window.electronAPI.interface.setPushToTalkMode(newValue);
                      }}
                      style={{
                        width: '16px',
                        height: '16px',
                        cursor: 'pointer',
                        accentColor: primary,
                        color: primary,
                      }}
                    />
                    <span style={{ fontSize: '12px', userSelect: 'none' }}>
                      Push-to-talk
                    </span>
                  </label>

                </div>
              )}
            </div>

            {/* Total words dictated (not typed) */}
            <div style={{
              marginTop: '20px',
              paddingTop: '12px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: '12px',
              color: 'rgba(255, 255, 255, 0.6)',
            }}>
              Words not typed: {totalWordCount !== null ? totalWordCount.toLocaleString() : '…'}
            </div>
          </div>
        </div>
      </div>

      {/* QR Code Modal Portal */}
      {showSyncQR && connectionInfo && createPortal(
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.95)',
              backdropFilter: 'blur(20px)',
              zIndex: 999999,
            }}
            onClick={handleStopSync}
          />
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1000000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div style={{ pointerEvents: 'auto' }}>
              <QRCodeDisplay
                connectionInfo={connectionInfo}
                onClose={handleStopSync}
              />
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
};
