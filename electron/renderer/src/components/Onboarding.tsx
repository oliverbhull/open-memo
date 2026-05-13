import React, { useState, useEffect } from 'react';
import { GlassContainer } from './GlassContainer';
import { useTheme } from '../context/ThemeContext';
import { KeyboardKey } from './KeyboardKey';
import titleLogo from '../assets/title.png';
import './Onboarding.css';

declare global {
  interface Window {
    electronAPI: {
      checkMicrophonePermission: () => Promise<boolean>;
      requestMicrophonePermission: () => Promise<boolean>;
      checkInputMonitoringPermission: () => Promise<boolean>;
      openInputMonitoringPreferences: () => Promise<void>;
      checkAccessibilityPermission: () => Promise<boolean>;
      openSystemPreferences: () => Promise<void>;
      restartApp: () => Promise<void>;
      startMemoSttService: () => Promise<void>;
      saveUserName: (name: string) => Promise<void>;
      getUserName: () => Promise<string | null>;
      isUserOnboarded: (userName: string) => Promise<boolean>;
      markUserOnboarded: (userName: string) => Promise<void>;
    };
  }
}

type OnboardingStep = 'name' | 'welcome' | 'microphone' | 'inputMonitoring' | 'accessibility' | 'ready';

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const { primary } = useTheme();
  // Check for ready step flag during initialization
  const getInitialStep = (): OnboardingStep => {
    if (typeof window !== 'undefined') {
      const showReadyStep = localStorage.getItem('show_ready_step');
      if (showReadyStep === 'true') {
        return 'ready';
      }
    }
    return 'name';
  };
  const [step, setStep] = useState<OnboardingStep>(getInitialStep());
  const [name, setName] = useState('');
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [inputMonitoringPermissionGranted, setInputMonitoringPermissionGranted] = useState(false);
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] = useState(false);
  const [checkingPermissions, setCheckingPermissions] = useState(false);
  const [logoRatio, setLogoRatio] = useState<number | null>(null);
  const [welcomeName, setWelcomeName] = useState('');
  const [tryItText, setTryItText] = useState('');

  // Load saved name if exists and handle ready step
  useEffect(() => {
    if (window.electronAPI?.getUserName) {
      window.electronAPI.getUserName().then((savedName) => {
        if (savedName) {
          setName(savedName);
        }
      });
    }
    
    // Check if we should show ready step after restart
    // This is a backup check in case the initial step check didn't catch it
    const showReadyStep = localStorage.getItem('show_ready_step');
    if (showReadyStep === 'true' && step !== 'ready') {
      localStorage.removeItem('show_ready_step');
      setStep('ready');
      // Start the memo-stt service so the function key works in the ready step
      if (window.electronAPI?.startMemoSttService) {
        window.electronAPI.startMemoSttService();
      }
    } else if (step === 'ready' && showReadyStep === 'true') {
      // If we're already on ready step, just clear the flag and start service
      localStorage.removeItem('show_ready_step');
      if (window.electronAPI?.startMemoSttService) {
        window.electronAPI.startMemoSttService();
      }
    }
  }, [step]);

  // Calculate logo aspect ratio
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setLogoRatio(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = titleLogo;
  }, []);

  // Check microphone permission when on microphone step
  useEffect(() => {
    if (step === 'microphone' && window.electronAPI?.checkMicrophonePermission) {
      setCheckingPermissions(true);
      window.electronAPI.checkMicrophonePermission().then((granted) => {
        setMicPermissionGranted(granted);
        setCheckingPermissions(false);
      });
    } else if (step !== 'microphone') {
      // Reset when leaving microphone step
      setMicPermissionGranted(false);
      setCheckingPermissions(false);
    }
  }, [step]);

  // Check input monitoring permission when on input monitoring step
  useEffect(() => {
    if (step === 'inputMonitoring' && window.electronAPI?.checkInputMonitoringPermission) {
      // Initial check
      window.electronAPI.checkInputMonitoringPermission().then((granted) => {
        setInputMonitoringPermissionGranted(granted);
      });

      // Check periodically for permission changes
      const checkInterval = setInterval(() => {
        if (window.electronAPI?.checkInputMonitoringPermission) {
          window.electronAPI.checkInputMonitoringPermission().then((granted) => {
            setInputMonitoringPermissionGranted(granted);
          });
        }
      }, 1000); // Check every second

      return () => clearInterval(checkInterval);
    } else if (step !== 'inputMonitoring') {
      // Reset when leaving input monitoring step
      setInputMonitoringPermissionGranted(false);
    }
  }, [step]);

  // Check accessibility permission when on accessibility step
  useEffect(() => {
    if (step === 'accessibility' && window.electronAPI?.checkAccessibilityPermission) {
      // Initial check
      window.electronAPI.checkAccessibilityPermission().then((granted) => {
        setAccessibilityPermissionGranted(granted);
      });

      // Check periodically for permission changes
      const checkInterval = setInterval(() => {
        if (window.electronAPI?.checkAccessibilityPermission) {
          window.electronAPI.checkAccessibilityPermission().then((granted) => {
            setAccessibilityPermissionGranted(granted);
          });
        }
      }, 1000); // Check every second

      return () => clearInterval(checkInterval);
    } else if (step !== 'accessibility') {
      // Reset when leaving accessibility step
      setAccessibilityPermissionGranted(false);
    }
  }, [step]);

  // Capitalize name properly (title case)
  const capitalizeName = (name: string): string => {
    return name
      .trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const handleNameSubmit = async () => {
    const trimmedName = name.trim();
    if (trimmedName && window.electronAPI?.saveUserName) {
      const capitalizedName = capitalizeName(trimmedName);
      await window.electronAPI.saveUserName(capitalizedName);
      
      // Mark user as onboarded when they complete name step (unless memodev)
      if (window.electronAPI?.markUserOnboarded) {
        await window.electronAPI.markUserOnboarded(capitalizedName);
      }
      
      // Show welcome step
      setWelcomeName(capitalizedName);
      setStep('welcome');
      
      // Proceed to microphone step after 1.5 seconds
      setTimeout(() => {
        setStep('microphone');
      }, 1500);
    } else {
      // Even if no name, proceed to next step
      setStep('microphone');
    }
  };

  const handleSkipName = async () => {
    // Even when skipping, if there's a name entered, save it and mark as onboarded
    const trimmedName = name.trim();
    if (trimmedName && window.electronAPI?.saveUserName) {
      const capitalizedName = capitalizeName(trimmedName);
      await window.electronAPI.saveUserName(capitalizedName);
      // Mark as onboarded unless it's memodev
      if (window.electronAPI?.markUserOnboarded) {
        await window.electronAPI.markUserOnboarded(capitalizedName);
      }
    }
    setStep('microphone');
  };

  const handleGoBack = () => {
    if (step === 'microphone') {
      setStep('name');
    } else if (step === 'accessibility') {
      setStep('microphone');
    } else if (step === 'inputMonitoring') {
      setStep('accessibility');
    } else if (step === 'ready') {
      setStep('inputMonitoring');
    }
  };

  const handleRequestMicrophone = async () => {
    if (!window.electronAPI?.requestMicrophonePermission) return;
    
    setCheckingPermissions(true);
    const granted = await window.electronAPI.requestMicrophonePermission();
    setMicPermissionGranted(granted);
    setCheckingPermissions(false);
    
    if (granted) {
      // Small delay before moving to next step
      setTimeout(() => {
        setStep('accessibility');
      }, 500);
    }
  };

  const handleOpenInputMonitoringPreferences = async () => {
    if (window.electronAPI?.openInputMonitoringPreferences) {
      await window.electronAPI.openInputMonitoringPreferences();
    }
  };

  const handleOpenSystemPreferences = async () => {
    if (window.electronAPI?.openSystemPreferences) {
      await window.electronAPI.openSystemPreferences();
    }
  };

  const handleRestartApp = async () => {
    // Restart app - after restart, we'll show the ready step
    if (window.electronAPI?.restartApp) {
      // Set a flag so we know to show ready step after restart
      localStorage.setItem('show_ready_step', 'true');
      await window.electronAPI.restartApp();
    }
  };

  const handleCompleteOnboarding = async () => {
    // Mark user as onboarded (unless it's memodev)
    const trimmedName = name.trim();
    if (trimmedName && window.electronAPI?.markUserOnboarded) {
      const capitalizedName = capitalizeName(trimmedName);
      await window.electronAPI.markUserOnboarded(capitalizedName);
    } else if (!trimmedName) {
      // If no name was provided, still mark as onboarded with a default
      if (window.electronAPI?.markUserOnboarded) {
        await window.electronAPI.markUserOnboarded('User');
      }
    }
    
    // Also set localStorage for backwards compatibility
    localStorage.setItem('onboarding_complete', 'true');
    
    // Start memo-stt service now that onboarding is complete
    if (window.electronAPI?.startMemoSttService) {
      await window.electronAPI.startMemoSttService();
    }
    
    // Close onboarding
    onComplete();
  };

  const getStepNumber = (currentStep: OnboardingStep): number => {
    switch (currentStep) {
      case 'name': return 1;
      case 'welcome': return 1; // Welcome is part of step 1
      case 'microphone': return 2;
      case 'accessibility': return 3;
      case 'inputMonitoring': return 4;
      case 'ready': return 4; // Ready is part of step 4
      default: return 1;
    }
  };

  const currentStepNumber = getStepNumber(step);

  return (
    <GlassContainer>
      <div className="title-bar" style={{ paddingLeft: navigator.platform.includes('Mac') ? '78px' : '12px' }}>
        <div className="title-bar-left" style={{ display: navigator.platform.includes('Mac') ? 'none' : 'flex' }}>
          <div className="title-bar-button close" />
          <div className="title-bar-button minimize" />
          <div className="title-bar-button maximize" />
        </div>
        <div className="title-bar-right">
          {/* Empty for now - could add settings or other controls */}
        </div>
      </div>
      <div className="onboarding-container">
        <div className="onboarding-content">
          {step === 'name' && (
            <div className="onboarding-step">
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
                {logoRatio ? (
                  <div
                    aria-label="Memo"
                    style={{
                      width: Math.round(48 * logoRatio),
                      height: 48,
                      background: primary,
                      WebkitMaskImage: `url(${titleLogo})`,
                      WebkitMaskRepeat: 'no-repeat',
                      WebkitMaskSize: 'contain',
                      WebkitMaskPosition: 'center',
                      maskImage: `url(${titleLogo})`,
                      maskRepeat: 'no-repeat',
                      maskSize: 'contain',
                      maskPosition: 'center',
                    }}
                  />
                ) : (
                  <img src={titleLogo} alt="Memo" height={48} style={{ objectFit: 'contain' }} />
                )}
              </div>
              <p className="onboarding-description">
                Welcome! Let's get you set up.
              </p>
              <div className="onboarding-input-group">
                <input
                  type="text"
                  className="onboarding-input"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) {
                      handleNameSubmit();
                    }
                  }}
                  autoFocus
                />
              </div>
              <div className="onboarding-button-group name-step-buttons">
                <button
                  className="onboarding-button primary"
                  onClick={handleNameSubmit}
                  style={{ 
                    backgroundColor: primary,
                    borderColor: primary
                  }}
                >
                  Continue
                </button>
                <button
                  className="onboarding-button skip"
                  onClick={handleSkipName}
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {step === 'welcome' && (
            <div className="onboarding-step">
              <div className="onboarding-welcome-message">
                Welcome, <span style={{ color: primary }}>{welcomeName}</span>!
              </div>
            </div>
          )}

          {step === 'microphone' && (
            <div className="onboarding-step">
              <div className="onboarding-icon-container">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="onboarding-icon"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </div>
              <p className="onboarding-description">
                So Memo can hear what you say.
              </p>
              {micPermissionGranted ? (
                <>
                  <div className="onboarding-success">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Microphone access granted</span>
                  </div>
                  <div className="onboarding-button-group microphone-step-buttons">
                    <button
                      className="onboarding-button back"
                      onClick={handleGoBack}
                    >
                      Go Back
                    </button>
                    <button
                      className="onboarding-button primary"
                      onClick={() => setStep('accessibility')}
                      style={{ backgroundColor: primary }}
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : (
                <div className="onboarding-button-group microphone-step-buttons">
                  <button
                    className="onboarding-button back"
                    onClick={handleGoBack}
                  >
                    Go Back
                  </button>
                  <button
                    className="onboarding-button primary"
                    onClick={handleRequestMicrophone}
                    disabled={checkingPermissions}
                    style={{ backgroundColor: primary }}
                  >
                    {checkingPermissions ? 'Requesting...' : 'Grant Microphone Access'}
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'inputMonitoring' && (
            <div className="onboarding-step">
              <div className="onboarding-icon-container">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="onboarding-icon"
                >
                  {/* Keyboard icon */}
                  <rect x="2" y="4" width="20" height="14" rx="2" ry="2" />
                  <line x1="6" y1="8" x2="6" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="10" y1="8" x2="10" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="14" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="18" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="6" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="6" y1="16" x2="16" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <p className="onboarding-description">
                So Memo can type what you say.
              </p>
              <div className="onboarding-button-group">
                {!inputMonitoringPermissionGranted && (
                  <button
                    className="onboarding-button secondary"
                    onClick={handleOpenInputMonitoringPreferences}
                  >
                    Open System Settings
                  </button>
                )}
                {inputMonitoringPermissionGranted ? (
                  <div className="onboarding-success">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Input Monitoring permission granted</span>
                  </div>
                ) : (
                  <p className="onboarding-hint">
                    Toggle on Memo in System Settings → Privacy & Security → Input Monitoring
                  </p>
                )}
                {inputMonitoringPermissionGranted ? (
                  <div className="onboarding-button-group input-monitoring-step-buttons">
                    <button
                      className="onboarding-button back"
                      onClick={handleGoBack}
                    >
                      Go Back
                    </button>
                    <button
                      className="onboarding-button primary"
                      onClick={handleRestartApp}
                      style={{ backgroundColor: primary }}
                    >
                      Restart App
                    </button>
                  </div>
                ) : (
                  <button
                    className="onboarding-button back"
                    onClick={handleGoBack}
                  >
                    Go Back
                  </button>
                )}
              </div>
            </div>
          )}

          {step === 'accessibility' && (
            <div className="onboarding-step">
              <div className="onboarding-icon-container">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="onboarding-icon"
                >
                  {/* Text cursor I-bar icon */}
                  <line x1="12" y1="2" x2="12" y2="22" />
                  <line x1="8" y1="2" x2="16" y2="2" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </svg>
              </div>
              <p className="onboarding-description">
                So Memo can type what you say.
              </p>
              <div className="onboarding-button-group">
                {!accessibilityPermissionGranted && (
                  <button
                    className="onboarding-button secondary"
                    onClick={handleOpenSystemPreferences}
                  >
                    Open System Settings
                  </button>
                )}
                {accessibilityPermissionGranted ? (
                  <div className="onboarding-success">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Accessibility permission granted</span>
                  </div>
                ) : (
                  <p className="onboarding-hint">
                    Toggle on Memo in System Settings → Privacy & Security → Accessibility
                  </p>
                )}
                <div className="onboarding-button-group accessibility-step-buttons">
                  <button
                    className="onboarding-button back"
                    onClick={handleGoBack}
                  >
                    Go Back
                  </button>
                  {accessibilityPermissionGranted ? (
                    <button
                      className="onboarding-button primary"
                      onClick={() => setStep('inputMonitoring')}
                      style={{ backgroundColor: primary }}
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      className="onboarding-button primary"
                      onClick={() => setStep('inputMonitoring')}
                      style={{ backgroundColor: primary, opacity: 0.6 }}
                    >
                      Continue Anyway
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'ready' && (
            <div className="onboarding-step">
              <div className="onboarding-icon-container">
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="onboarding-icon"
                >
                  {/* Keyboard icon */}
                  <rect x="2" y="4" width="20" height="14" rx="2" ry="2" />
                  <line x1="6" y1="8" x2="6" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="10" y1="8" x2="10" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="14" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="18" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="6" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="6" y1="16" x2="16" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <p className="onboarding-description" style={{ marginBottom: '16px', lineHeight: '1.6', textAlign: 'center' }}>
                Press and hold <KeyboardKey label="Fn" size="small" /> to start dictating.
                <br />
                Press <KeyboardKey label="Fn" size="small" /> + <KeyboardKey label="Control" size="small" /> to go hands-free.
              </p>
              <div style={{ width: '100%', maxWidth: '400px', margin: '0 auto 24px' }}>
                <input
                  type="text"
                  placeholder="Try it out here!"
                  value={tryItText}
                  onChange={(e) => setTryItText(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    fontSize: '16px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    color: 'white',
                    outline: 'none',
                    fontFamily: 'inherit',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = primary;
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                  }}
                />
              </div>
              <div className="onboarding-button-group">
                <button
                  className="onboarding-button primary"
                  onClick={handleCompleteOnboarding}
                  style={{ backgroundColor: primary }}
                >
                  Got it, let's go
                </button>
              </div>
            </div>
          )}

          {/* Status Tracker - at bottom */}
          <div className="onboarding-status-tracker">
            {[1, 2, 3, 4].map((stepNum) => (
              <div
                key={stepNum}
                className={`onboarding-status-step ${stepNum === currentStepNumber ? 'active' : ''}`}
                style={stepNum === currentStepNumber ? { color: primary } : { color: 'rgba(255, 255, 255, 0.5)' }}
              >
                <div
                  className="onboarding-status-dot"
                  style={stepNum === currentStepNumber ? { backgroundColor: primary, borderColor: primary } : stepNum < currentStepNumber ? { backgroundColor: primary, borderColor: primary } : {}}
                />
                {stepNum < 4 && (
                  <div
                    className={`onboarding-status-line ${stepNum < currentStepNumber ? 'completed' : ''}`}
                    style={stepNum < currentStepNumber ? { backgroundColor: primary } : {}}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </GlassContainer>
  );
}

