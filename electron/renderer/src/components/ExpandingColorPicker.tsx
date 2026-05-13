import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../context/ThemeContext';
import titleImage from '../assets/title.png';
import '../styles/color-picker.css';
import { hexToHsl, hslToHex } from '../utils/colorUtils';
import { syncOrchestrator, SyncStatus } from '../services/SyncOrchestrator';
import { QRCodeDisplay } from './QRCodeDisplay';

export const ExpandingColorPicker: React.FC = () => {
  const { primary, setPrimary } = useTheme();
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedHue, setSelectedHue] = useState(0);
  const [selectedSaturation, setSelectedSaturation] = useState(100);
  const [selectedLightness, setSelectedLightness] = useState(50);
  const spectrumRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [showSyncQR, setShowSyncQR] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<{ ip: string; port: number; token: string } | null>(null);

  // Initialize from current primary color
  useEffect(() => {
    if (primary) {
      const [h, s, l] = hexToHsl(primary);
      setSelectedHue(h);
      setSelectedSaturation(s);
      setSelectedLightness(l);
    }
  }, [primary]);

  // Initialize sync status and subscribe to changes
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
        // Close QR code when connection is established or when stopped
        setShowSyncQR(false);
        if (newStatus === 'idle') {
          setConnectionInfo(null);
        }
      }
    });

    return unsubscribe;
  }, []);

  // Handle spectrum click/drag for color selection
  const handleSpectrumMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!spectrumRef.current) return;
    
    const rect = spectrumRef.current.getBoundingClientRect();
    const updateHue = (clientX: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const hue = Math.round(x * 360);
      setSelectedHue(hue);
      
      // Update color immediately
      const newColor = hslToHex(hue, selectedSaturation, selectedLightness);
      setPrimary(newColor);
    };
    
    updateHue(e.clientX);
    setIsExpanded(true);
    
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
  }, [selectedSaturation, selectedLightness, setPrimary]);

  // Close on outside click and save color
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        // Ensure final color is saved when closing
        const finalColor = hslToHex(selectedHue, selectedSaturation, selectedLightness);
        setPrimary(finalColor);
        setIsExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded, selectedHue, selectedSaturation, selectedLightness, setPrimary]);

  const handleIconClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isExpanded) {
      // Save color when closing via icon click
      const finalColor = hslToHex(selectedHue, selectedSaturation, selectedLightness);
      setPrimary(finalColor);
    }
    setIsExpanded(!isExpanded);
  }, [isExpanded, selectedHue, selectedSaturation, selectedLightness, setPrimary]);

  const handleStartSync = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const info = await syncOrchestrator.startListening();
      setConnectionInfo(info);
      setShowSyncQR(true);
    } catch (error) {
      console.error('Failed to start sync:', error);
    }
  }, []);

  const handleStopSync = useCallback(async () => {
    await syncOrchestrator.stopListening();
    setShowSyncQR(false);
    setConnectionInfo(null);
  }, []);

  const handleSyncNow = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await syncOrchestrator.syncNow();
    } catch (error) {
      console.error('Failed to sync:', error);
    }
  }, []);

  const getSyncButtonText = () => {
    switch (syncStatus) {
      case 'listening':
        return 'Listening...';
      case 'connected':
        return 'Connected';
      case 'syncing':
        return 'Syncing...';
      case 'error':
        return 'Error';
      default:
        return 'Start Sync';
    }
  };

  const getSyncButtonIcon = () => {
    switch (syncStatus) {
      case 'listening':
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

  return (
    <div className="expanding-color-picker" ref={containerRef}>
      <div 
        className="color-picker-icon" 
        onClick={handleIconClick}
        title="Color Picker"
        style={{
          position: 'relative',
          height: '24px',
          width: 'auto',
          minWidth: '60px',
          background: primary,
          WebkitMaskImage: `url(${titleImage})`,
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          WebkitMaskPosition: 'center',
          maskImage: `url(${titleImage})`,
          maskRepeat: 'no-repeat',
          maskSize: 'contain',
          maskPosition: 'center',
          transform: 'translateZ(0)',
          transition: 'background-color 0s',
        }}
      />
      
      <div 
        className={`color-spectrum ${isExpanded ? 'expanded' : ''}`}
        ref={spectrumRef}
        onMouseDown={handleSpectrumMouseDown}
      >
        <div className="spectrum-gradient" />
        <div 
          className="spectrum-selector"
          style={{ left: `${(selectedHue / 360) * 100}%` }}
        />
      </div>


      {showSyncQR && connectionInfo && createPortal(
        <>
          <div className="sync-qr-backdrop" onClick={handleStopSync} />
          <div className="sync-qr-overlay">
            <QRCodeDisplay 
              connectionInfo={connectionInfo}
              onClose={handleStopSync}
            />
          </div>
        </>,
        document.body
      )}
    </div>
  );
};


