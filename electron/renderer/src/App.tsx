import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { GlassContainer } from './components/GlassContainer';
import { Feed } from './components/Feed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Onboarding } from './components/Onboarding';
import { ToastNotification, ToastData } from './components/ToastNotification';
import { useEntries } from './hooks/useEntries';
import { logger } from './utils/logger';
import { storageService } from './services/StorageService';
import { Settings } from './components/Settings';
import type { MemoSttError, TranscriptionData } from '../../shared/electron-api';
import './styles/glass.css';

// Settings Icon Component
const SettingsIcon: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { primary } = useTheme();

  return (
      <button
        onClick={onOpen}
        title="Settings"
        className="settings-icon"
        style={{
          padding: '2px',
          background: 'transparent',
          border: 'none',
          color: primary,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
  );
};

function App() {
  const { entries, loading, error: storageError, addEntry, loadMore } = useEntries();
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // Track if listeners are registered to prevent duplicates (especially in StrictMode)
  const listenersRegisteredRef = useRef(false);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch((err) => {
      logger.error('Failed to copy text:', err);
    });
    
    setToast({ message: 'Copied to clipboard', severity: 'success', duration: 2000 });
  }, []); // Empty deps - function doesn't depend on any state

  // Listen for audio source toast notifications
  useEffect(() => {
    if (!window.electronAPI?.audioSource?.onShowToast) {
      return;
    }

    const unsubscribe = window.electronAPI.audioSource.onShowToast((toastData: ToastData) => {
      setToast(toastData);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => window.electronAPI.onOpenSettings(() => setShowSettings(true)), []);

  // Notify the main process when audio input devices change (e.g. headphones plugged in/out)
  // so memo-stt can restart and open a stream to the new default input device.
  useEffect(() => {
    if (!navigator.mediaDevices || !window.electronAPI?.audioSource?.notifyInputDeviceChanged) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleDeviceChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        window.electronAPI!.audioSource!.notifyInputDeviceChanged!().catch(() => {
          // Best-effort — ignore if IPC fails
        });
      }, 500);
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await loadMore(50);
    } finally {
      setLoadingMore(false);
    }
  }, [loadMore, loadingMore]);

  // Cleanup database on app quit
  useEffect(() => {
    const handleBeforeUnload = () => {
      logger.info('[App] Closing database connection before unload...');
      storageService.close().catch((err) => {
        logger.error('[App] Error closing database:', err);
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Also close on component unmount (though this shouldn't happen in normal operation)
      storageService.close().catch((err) => {
        logger.error('[App] Error closing database on unmount:', err);
      });
    };
  }, []);

  // Check if onboarding is complete on mount
  useEffect(() => {
    const checkOnboarding = async () => {
      if (!window.electronAPI) return;
      
      try {
        // Get saved user name
        const userName = await window.electronAPI.getUserName();
        
        if (userName) {
          // Check if this specific user is onboarded
          const isOnboarded = await window.electronAPI.isUserOnboarded(userName);
          if (!isOnboarded) {
            setShowOnboarding(true);
          }
        } else {
          // No user name saved, show onboarding
          setShowOnboarding(true);
        }
      } catch (error) {
        logger.error('Failed to check onboarding status:', error);
        // Fallback to localStorage check
        const onboardingComplete = localStorage.getItem('onboarding_complete');
        if (!onboardingComplete) {
          setShowOnboarding(true);
        }
      }
    };
    
    checkOnboarding();
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
  }, []); // Empty deps - function doesn't depend on any state

  useEffect(() => {
    if (!window.electronAPI) {
      logger.error('electronAPI not available');
      return;
    }

    // Prevent duplicate registration (especially important in React.StrictMode)
    if (listenersRegisteredRef.current) {
      logger.debug('Listeners already registered, skipping duplicate registration');
      return;
    }

    // Set up transcription listener
    const transcriptionCallback = async (data: TranscriptionData) => {
      try {
        const entry = await addEntry({
          ...data,
          timestamp: data.timestamp || Date.now(),
        });
        if (!entry) throw new Error('Transcription did not contain a valid memo');
        setError(null); // Clear any previous errors
      } catch (err) {
        if (data.id && data.audio) {
          void window.electronAPI.audio.delete(data.id);
        }
        logger.error('Failed to add entry:', err);
        setError('Failed to save entry');
      }
    };
    window.electronAPI.onTranscription(transcriptionCallback);

    // Set up status listener
    const statusCallback = (newStatus: string) => {
      if (newStatus === 'running') {
        setError(null);
      }
    };
    window.electronAPI.onStatus(statusCallback);

    // Set up error listener
    const errorCallback = (errorData: MemoSttError) => {
      setError(errorData.message || 'An error occurred');
      logger.error('memo-stt error:', errorData);
    };
    window.electronAPI.onError(errorCallback);

    // Mark as registered
    listenersRegisteredRef.current = true;

    // Cleanup
    return () => {
      listenersRegisteredRef.current = false;
      window.electronAPI.removeTranscriptionListener();
      window.electronAPI.removeStatusListener();
      window.electronAPI.removeErrorListener();
    };
  }, [addEntry]);

  // Combine storage errors with other errors
  const displayError = error || (storageError ? storageError.message : null);

  // Show onboarding if not complete
  if (showOnboarding) {
    return (
      <ThemeProvider>
        <ErrorBoundary>
          <Onboarding onComplete={handleOnboardingComplete} />
        </ErrorBoundary>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <ErrorBoundary>
        <GlassContainer>
          <div className="title-bar" style={{ paddingLeft: '78px' }}>
            <div className="title-bar-right">
              <SettingsIcon onOpen={() => setShowSettings(true)} />
            </div>
          </div>
          {showSettings && <Settings onClose={() => setShowSettings(false)} />}
          
          {displayError && (
            <div className="error-message">
              {displayError}
              <button
                onClick={() => window.electronAPI?.restart()}
                style={{
                  marginLeft: '12px',
                  padding: '4px 8px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '4px',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="feed-container">
              <div className="empty-state">
                <div className="empty-state-text">Loading entries...</div>
              </div>
            </div>
          ) : (
            <Feed
              entries={entries}
              onCopy={handleCopy}
              onLoadMore={handleLoadMore}
              loading={loadingMore}
            />
          )}

        </GlassContainer>
        
        <ToastNotification toast={toast} onClose={() => setToast(null)} />
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
