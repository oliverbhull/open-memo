import React, { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { syncOrchestrator, SyncStatus as SyncStatusType } from '../services/SyncOrchestrator';
import { QRCodeDisplay } from './QRCodeDisplay';
import '../styles/feed.css';

interface SyncStatusProps {
  onSyncClick?: () => void;
}

export const SyncStatus: React.FC<SyncStatusProps> = ({ onSyncClick }) => {
  const { primary } = useTheme();
  const [status, setStatus] = useState<SyncStatusType>('idle');
  const [lastSyncTime, setLastSyncTime] = useState<number>(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<{ ip: string; port: number; token: string } | null>(null);

  useEffect(() => {
    // Load initial status
    syncOrchestrator.getStatus().then(setStatus);
    syncOrchestrator.getLastSyncTime().then(setLastSyncTime);

    // Subscribe to status changes
    const unsubscribe = syncOrchestrator.onStatusChange((newStatus) => {
      setStatus(newStatus);
      if (newStatus === 'listening') {
        syncOrchestrator.getConnectionInfo().then((info) => {
          setConnectionInfo(info);
        });
      }
    });

    return unsubscribe;
  }, []);

  const handleStartListening = async () => {
    const info = await syncOrchestrator.startListening();
    setConnectionInfo(info);
    setShowQR(true);
  };

  const handleStopListening = async () => {
    await syncOrchestrator.stopListening();
    setShowQR(false);
    setConnectionInfo(null);
  };

  const getStatusText = () => {
    switch (status) {
      case 'searching':
        return 'Searching for devices...';
      case 'connected':
        return 'Connected';
      case 'syncing':
        return 'Syncing...';
      case 'error':
        return 'Sync error';
      default:
        return 'Not syncing';
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case 'searching':
        return '🔍';
      case 'connected':
        return '✓';
      case 'syncing':
        return '↻';
      case 'error':
        return '⚠';
      default:
        return '○';
    }
  };

  const formatLastSync = () => {
    if (!lastSyncTime) return 'Never';
    const diff = Date.now() - lastSyncTime;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(lastSyncTime).toLocaleTimeString();
  };

  if (showQR && connectionInfo) {
    return (
      <div className="glass-card" style={{ padding: '16px', margin: '8px' }}>
        <QRCodeDisplay 
          connectionInfo={connectionInfo}
          onClose={() => {
            setShowQR(false);
            handleStopListening();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="sync-status glass-card"
      style={{ padding: '8px 12px', margin: '8px', cursor: 'pointer' }}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>{getStatusIcon()}</span>
        <span style={{ fontSize: '12px', color: primary }}>{getStatusText()}</span>
        {status === 'idle' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleStartListening();
            }}
            style={{
              marginLeft: 'auto',
              padding: '4px',
              background: 'transparent',
              border: 'none',
              color: primary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Start Sync"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
            </svg>
          </button>
        )}
        {status === 'connected' && onSyncClick && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSyncClick();
            }}
            style={{
              marginLeft: 'auto',
              padding: '4px 8px',
              fontSize: '10px',
              background: 'transparent',
              border: `1px solid ${primary}`,
              color: primary,
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Sync Now
          </button>
        )}
      </div>
      {isExpanded && lastSyncTime > 0 && (
        <div style={{ marginTop: '8px', fontSize: '11px', opacity: 0.7 }}>
          Last sync: {formatLastSync()}
        </div>
      )}
    </div>
  );
};

