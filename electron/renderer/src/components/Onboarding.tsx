import { useEffect, useRef, useState } from 'react';
import type { DictationReadiness, TranscriptionData } from '../../../shared/electron-api';
import { GlassContainer } from './GlassContainer';
import { useTheme } from '../context/ThemeContext';
import { KeyboardKey } from './KeyboardKey';
import titleLogo from '../assets/title.png';
import './Onboarding.css';

type OnboardingStep = 'name' | 'microphone' | 'accessibility' | 'inputMonitoring' | 'ready';

interface OnboardingProps { onComplete: () => void; }

const steps: OnboardingStep[] = ['name', 'microphone', 'accessibility', 'inputMonitoring', 'ready'];

function initialStep(): OnboardingStep {
  const stored = localStorage.getItem('onboarding_step') as OnboardingStep | null;
  return stored && steps.includes(stored) ? stored : 'name';
}

function PermissionIcon({ kind }: { kind: 'microphone' | 'typing' | 'keyboard' }) {
  if (kind === 'microphone') return <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="onboarding-icon"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
  if (kind === 'typing') return <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="onboarding-icon"><line x1="12" y1="2" x2="12" y2="22"/><line x1="8" y1="2" x2="16" y2="2"/><line x1="8" y1="22" x2="16" y2="22"/></svg>;
  return <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="onboarding-icon"><rect x="2" y="4" width="20" height="14" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="16" y2="16"/></svg>;
}

function Success({ children }: { children: React.ReactNode }) {
  return <div className="onboarding-success"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg><span>{children}</span></div>;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const { primary } = useTheme();
  const [step, setStepState] = useState<OnboardingStep>(initialStep);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micGranted, setMicGranted] = useState(false);
  const [micDetected, setMicDetected] = useState(false);
  const [micName, setMicName] = useState('System Default');
  const [micLevel, setMicLevel] = useState(0);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);
  const [inputMonitoringGranted, setInputMonitoringGranted] = useState(false);
  const [readiness, setReadiness] = useState<DictationReadiness | null>(null);
  const [tryItText, setTryItText] = useState('');
  const [testSucceeded, setTestSucceeded] = useState(false);
  const [typingBlocked, setTypingBlocked] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const micCleanupRef = useRef<(() => void) | null>(null);

  const setStep = (next: OnboardingStep) => {
    localStorage.setItem('onboarding_step', next);
    setError(null);
    setTypingBlocked(false);
    setStepState(next);
  };

  useEffect(() => {
    void window.electronAPI.getUserName().then(savedName => { if (savedName) setName(savedName); });
    return () => micCleanupRef.current?.();
  }, []);

  const stopMicTest = () => {
    micCleanupRef.current?.();
    micCleanupRef.current = null;
  };

  const startMicTest = async () => {
    stopMicTest();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    if (track?.label) setMicName(track.label);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const update = () => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) { const value = (sample - 128) / 128; energy += value * value; }
      const level = Math.min(1, Math.sqrt(energy / samples.length) * 8);
      setMicLevel(level);
      if (level > 0.04) setMicDetected(true);
      frame = requestAnimationFrame(update);
    };
    update();
    micCleanupRef.current = () => {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach(item => item.stop());
      void context.close();
    };
  };

  useEffect(() => {
    if (step !== 'microphone') { stopMicTest(); return; }
    let active = true;
    void window.electronAPI.checkMicrophonePermission().then(async granted => {
      if (!active) return;
      setMicGranted(granted);
      if (granted) try { await startMicTest(); } catch { if (active) setError('Memo could not open the system microphone.'); }
    });
    return () => { active = false; stopMicTest(); };
  }, [step]);

  useEffect(() => {
    if (step !== 'accessibility') return;
    let active = true;
    const check = async () => { const granted = await window.electronAPI.checkAccessibilityPermission(); if (active) setAccessibilityGranted(granted); };
    void check();
    const interval = window.setInterval(check, 1000);
    return () => { active = false; window.clearInterval(interval); };
  }, [step]);

  useEffect(() => {
    if (step !== 'inputMonitoring') return;
    let active = true;
    const check = async () => { const granted = await window.electronAPI.checkInputMonitoringPermission(); if (active) setInputMonitoringGranted(granted); };
    void check();
    const interval = window.setInterval(check, 1500);
    return () => { active = false; window.clearInterval(interval); };
  }, [step]);

  useEffect(() => {
    if (step !== 'ready') return;
    let active = true;
    setBusy(true);
    setError(null);
    void window.electronAPI.startMemoSttService().then(state => { if (active) setReadiness(state); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (active) setBusy(false); });
    const transcriptionHandler = (data: TranscriptionData) => {
      if (!active) return;
      const delivery = data.context?.delivery;
      if (delivery === 'pasted' && data.processedText?.trim()) { setTestSucceeded(true); setTypingBlocked(false); setError(null); }
      else if (data.processedText?.trim()) { setTypingBlocked(true); setError('Memo heard you, but macOS blocked typing. Review Typing Access, then try again.'); }
    };
    window.electronAPI.onTranscription(transcriptionHandler);
    return () => { active = false; };
  }, [step, prepareAttempt]);

  const saveName = async () => {
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) return;
    setBusy(true);
    await window.electronAPI.saveUserName(normalized);
    setBusy(false);
    setStep('microphone');
  };

  const requestMicrophone = async () => {
    setBusy(true); setError(null);
    const granted = await window.electronAPI.requestMicrophonePermission();
    setMicGranted(granted);
    if (granted) try { await startMicTest(); } catch { setError('Memo could not open the system microphone.'); }
    else setError('Microphone access is off. Enable Memo in System Settings.');
    setBusy(false);
  };

  const requestAccessibility = async () => {
    setBusy(true);
    const granted = await window.electronAPI.requestAccessibilityPermission();
    setAccessibilityGranted(granted);
    if (!granted) await window.electronAPI.openSystemPreferences();
    setBusy(false);
  };

  const requestInputMonitoring = async () => {
    setBusy(true);
    const granted = await window.electronAPI.requestInputMonitoringPermission();
    setInputMonitoringGranted(granted);
    if (!granted) await window.electronAPI.openInputMonitoringPreferences();
    setBusy(false);
  };

  const complete = async () => {
    if (!testSucceeded) return;
    const savedName = await window.electronAPI.getUserName();
    const normalized = name.trim().replace(/\s+/g, ' ') || savedName || '';
    if (!normalized) { setStep('name'); return; }
    await window.electronAPI.markUserOnboarded(normalized);
    localStorage.setItem('onboarding_complete', 'true');
    localStorage.removeItem('onboarding_step');
    onComplete();
  };

  const stepNumber = steps.indexOf(step) + 1;
  const buttonStyle = { backgroundColor: primary, borderColor: primary };

  return <GlassContainer><div className="title-bar"/><div className="onboarding-container"><div className="onboarding-content">
    {step === 'name' && <div className="onboarding-step"><img src={titleLogo} alt="Memo" height={48} style={{ objectFit: 'contain' }}/><p className="onboarding-description">What should Memo call you?</p><div className="onboarding-input-group"><input className="onboarding-input" placeholder="Your name" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveName(); }} autoFocus/></div><button className="onboarding-button primary" onClick={() => void saveName()} disabled={!name.trim() || busy} style={buttonStyle}>Continue</button><p className="onboarding-hint">Memo will learn your name for more accurate dictation.</p></div>}

    {step === 'microphone' && <div className="onboarding-step"><div className="onboarding-icon-container"><PermissionIcon kind="microphone"/></div><p className="onboarding-description">Allow Memo to hear your dictation.</p>{micGranted && <div style={{ width: '100%', maxWidth: 320 }}><div style={{ fontSize: 13, textAlign: 'center', marginBottom: 8 }}>Using {micName}</div><div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,.12)', overflow: 'hidden' }}><div style={{ width: `${Math.max(3, micLevel * 100)}%`, height: '100%', background: primary, transition: 'width 80ms linear' }}/></div></div>}{micDetected ? <Success>Microphone is working</Success> : micGranted ? <p className="onboarding-hint">Say “hello” to test your microphone.</p> : null}{error && <p className="onboarding-hint">{error}</p>}{!micGranted && <button className="onboarding-button primary" onClick={() => void requestMicrophone()} disabled={busy} style={buttonStyle}>Allow Microphone</button>}{!micGranted && error && <button className="onboarding-button secondary" onClick={() => void window.electronAPI.openMicrophonePreferences()}>Open Microphone Settings</button>}{micDetected && <button className="onboarding-button primary" onClick={() => setStep('accessibility')} style={buttonStyle}>Continue</button>}</div>}

    {step === 'accessibility' && <div className="onboarding-step"><div className="onboarding-icon-container"><PermissionIcon kind="typing"/></div><p className="onboarding-description">Allow Memo to type your words into other apps.</p>{accessibilityGranted ? <Success>Typing access enabled</Success> : <p className="onboarding-hint">Turn on Memo in Privacy &amp; Security → Accessibility.</p>}{!accessibilityGranted ? <button className="onboarding-button primary" onClick={() => void requestAccessibility()} disabled={busy} style={buttonStyle}>Enable Typing Access</button> : <button className="onboarding-button primary" onClick={() => setStep('inputMonitoring')} style={buttonStyle}>Continue</button>}</div>}

    {step === 'inputMonitoring' && <div className="onboarding-step"><div className="onboarding-icon-container"><PermissionIcon kind="keyboard"/></div><p className="onboarding-description">Allow the Fn shortcut to work anywhere.</p>{inputMonitoringGranted ? <Success>Keyboard shortcut enabled</Success> : <p className="onboarding-hint">Memo only listens for your chosen dictation shortcut.</p>}{!inputMonitoringGranted ? <button className="onboarding-button primary" onClick={() => void requestInputMonitoring()} disabled={busy} style={buttonStyle}>Enable Keyboard Shortcut</button> : <button className="onboarding-button primary" onClick={() => setStep('ready')} style={buttonStyle}>Try Memo</button>}</div>}

    {step === 'ready' && <div className="onboarding-step"><div className="onboarding-icon-container"><PermissionIcon kind="keyboard"/></div>{busy ? <p className="onboarding-description">Getting Memo ready…</p> : readiness?.ready ? <><p className="onboarding-description">Hold <KeyboardKey label="Fn" size="small"/>, say something, then release.</p><input className="onboarding-input" type="text" placeholder="Your words will appear here" value={tryItText} onChange={event => setTryItText(event.target.value)} autoFocus/>{testSucceeded ? <Success>Memo is working</Success> : <p className="onboarding-hint">This verifies your microphone, shortcut, and typing access together.</p>}</> : null}{error && <><p className="onboarding-hint">{error}</p>{typingBlocked ? <button className="onboarding-button secondary" onClick={() => void window.electronAPI.openAutomationPreferences()}>Review Typing Access</button> : <button className="onboarding-button secondary" onClick={() => { setError(null); setPrepareAttempt(value => value + 1); }}>Try Again</button>}</>}{testSucceeded && <button className="onboarding-button primary" onClick={() => void complete()} style={buttonStyle}>Start using Memo</button>}</div>}

    <div className="onboarding-status-tracker">{steps.map((_, index) => <div key={index} className={`onboarding-status-step ${index + 1 === stepNumber ? 'active' : ''}`} style={{ color: index + 1 <= stepNumber ? primary : 'rgba(255,255,255,.5)' }}><div className="onboarding-status-dot" style={index + 1 <= stepNumber ? { backgroundColor: primary, borderColor: primary } : {}}/>{index < steps.length - 1 && <div className={`onboarding-status-line ${index + 1 < stepNumber ? 'completed' : ''}`} style={index + 1 < stepNumber ? { backgroundColor: primary } : {}}/>}</div>)}</div>
  </div></div></GlassContainer>;
}
