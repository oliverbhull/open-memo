import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { GlassContainer } from './components/GlassContainer';
import { Feed } from './components/Feed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Onboarding } from './components/Onboarding';
import { ToastNotification, ToastData } from './components/ToastNotification';
import { useEntries } from './hooks/useEntries';
import { logger } from './utils/logger';
import { syncMessageHandler } from './services/SyncMessageHandler';
import { storageService } from './services/StorageService';
import { Settings } from './components/Settings';
import './styles/glass.css';

interface TranscriptionData {
  rawTranscript?: string;
  processedText?: string;
  wasProcessedByLLM?: boolean;
  timestamp?: number;
  appContext?: {
    appName: string;
    windowTitle: string;
  };
}

interface MemoSttError {
  message: string;
  name: string;
}

interface PhraseReplacementRule {
  id: string;
  find: string;
  replace: string;
  enabled?: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      onTranscription: (callback: (data: TranscriptionData) => void) => void;
      removeTranscriptionListener: () => void;
      onStatus: (callback: (status: string) => void) => void;
      removeStatusListener: () => void;
      onError: (callback: (error: MemoSttError) => void) => void;
      removeErrorListener: () => void;
      getStatus: () => Promise<string>;
      restart: () => Promise<void>;
      getUserName: () => Promise<string | null>;
      isUserOnboarded: (userName: string) => Promise<boolean>;
      markUserOnboarded: (userName: string) => Promise<void>;
      device: {
        connectByUid: (uid: string) => Promise<{ success: boolean; error?: string }>;
        disconnect: () => Promise<{ success: boolean }>;
        getConnectionState: () => Promise<{
          connected: boolean;
          deviceUid: string | null;
          deviceName: string | null;
          batteryLevel: number | null;
        }>;
        onConnectionChanged: (callback: (state: {
          connected: boolean;
          deviceUid: string | null;
          deviceName: string | null;
          batteryLevel: number | null;
        }) => void) => () => void;
      };
      interface?: {
        getSettings: () => Promise<{
          pressEnterAfterPaste: boolean;
          sayEnterToPressEnter: boolean;
          pushToTalkMode: boolean;
          handsFreeMode: boolean;
          vocabWords: string[];
          phraseReplacements: PhraseReplacementRule[];
          startAtLogin: boolean;
        }>;
        setPressEnterAfterPaste: (enabled: boolean) => Promise<boolean>;
        setVocabWords: (vocabWords: string[]) => Promise<boolean>;
        setPhraseReplacements: (rules: PhraseReplacementRule[]) => Promise<boolean>;
        setSayEnterToPressEnter: (enabled: boolean) => Promise<boolean>;
        setPushToTalkMode: (enabled: boolean) => Promise<boolean>;
        setHandsFreeMode: (enabled: boolean) => Promise<boolean>;
        setStartAtLogin: (enabled: boolean) => Promise<boolean>;
      };
      voiceCommands?: {
        getSettings: () => Promise<any>;
        saveSettings: (settings: any) => Promise<boolean>;
        onCommandExecuted: (callback: (command: any) => void) => () => void;
      };
      keystroke?: {
        startRecording: () => Promise<{ success: boolean; error?: string }>;
        stopRecording: () => Promise<{ success: boolean; keystroke?: { modifiers: string[]; key: string; formatted: string } | null; error?: string }>;
        isRecording: () => Promise<{ success: boolean; isRecording: boolean }>;
        record: (modifiers: string[], key: string) => Promise<{ success: boolean; error?: string }>;
      };
    };
  }
}

// Settings Icon Component
const SettingsIcon: React.FC = () => {
  const { primary } = useTheme();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowSettings(true)}
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
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </>
  );
};

function App() {
  const { entries, loading, error: storageError, totalCount, addEntry, loadMore, deleteEntry, refresh } = useEntries();
  const [status, setStatus] = useState<string>('stopped');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  
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

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await loadMore(50);
    } finally {
      setLoadingMore(false);
    }
  }, [loadMore, loadingMore]);

  // Initialize sync message handler
  useEffect(() => {
    syncMessageHandler.start();
    return () => {
      syncMessageHandler.stop();
    };
  }, []);

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

    // Load initial status
    window.electronAPI.getStatus().then(setStatus).catch((err) => {
      logger.error('Failed to get status:', err);
    });

    // Set up transcription listener
    const transcriptionCallback = async (data: TranscriptionData) => {
      try {
        await addEntry({
          ...data,
          timestamp: data.timestamp || Date.now(),
        });
        setError(null); // Clear any previous errors
      } catch (err) {
        logger.error('Failed to add entry:', err);
        setError('Failed to save entry');
      }
    };
    window.electronAPI.onTranscription(transcriptionCallback);

    // Set up status listener
    const statusCallback = (newStatus: string) => {
      setStatus(newStatus);
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

  const getStatusDisplay = () => {
    switch (status) {
      case 'running':
        return { text: 'Connected', className: 'running' };
      case 'stopped':
        return { text: 'Disconnected', className: 'stopped' };
      case 'error':
        return { text: 'Error', className: 'error' };
      default:
        return { text: 'Unknown', className: 'stopped' };
    }
  };

  const statusDisplay = getStatusDisplay();

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
          <div className="title-bar" style={{ paddingLeft: navigator.platform.includes('Mac') ? '78px' : '12px' }}>
            <div className="title-bar-left" style={{ display: navigator.platform.includes('Mac') ? 'none' : 'flex' }}>
              <div className="title-bar-button close" />
              <div className="title-bar-button minimize" />
              <div className="title-bar-button maximize" />
            </div>
            <div className="title-bar-right">
              <SettingsIcon />
            </div>
          </div>
          
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
              onDelete={deleteEntry}
              onLoadMore={handleLoadMore}
              onRefresh={refresh}
              loading={loadingMore}
            />
          )}

          <div className="status-bar" style={{ display: 'none' }}>
            <div>{totalCount} memos</div>
          </div>
        </GlassContainer>
        
        <ToastNotification toast={toast} onClose={() => setToast(null)} />
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default App;


