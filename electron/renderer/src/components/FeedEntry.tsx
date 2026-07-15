import React, { useState, forwardRef, useRef, useEffect } from 'react';
import { formatTimestamp } from '../utils/formatTimestamp';
import { formatAddress, type LocationData } from '../utils/addressFormatter';
import { AppIcon } from './AppIcon';
import { useTheme } from '../context/ThemeContext';
import appIconBase from '../assets/app-icon-base.png';
import type { AppContext, AudioAttachment } from '../../../shared/electron-api';
import { PlayButton } from './PlayButton';
import '../styles/feed.css';

export type { AppContext };

export interface FeedEntryData {
  id: string;
  text: string;
  timestamp: number;
  createdAt?: number; // Support both timestamp and createdAt
  rawTranscript?: string;
  wasProcessedByLLM?: boolean;
  appContext?: AppContext;
  audio?: AudioAttachment;
  context?: Record<string, unknown>; // Full context for accessing mobile location data
}

interface FeedEntryProps {
  entry: FeedEntryData;
  onCopy?: (text: string) => void;
  isExpanded?: boolean;
  onExpandToggle?: () => void;
}

export const FeedEntry = React.memo(forwardRef<HTMLDivElement, FeedEntryProps>(
  ({ entry, onCopy, isExpanded: controlledIsExpanded, onExpandToggle }, ref) => {
    const { primary } = useTheme();
    const [internalIsExpanded, setInternalIsExpanded] = useState(false);
    const expandContentRef = useRef<HTMLDivElement>(null);
    const isExpanded = controlledIsExpanded !== undefined ? controlledIsExpanded : internalIsExpanded;

    // Extract fields from context for backward compatibility
    const context = entry.context || {};
    const recordingState = (context.recordingState as string) || 'completed';
    const location = context.location as LocationData | undefined;
    const appContext = entry.appContext;
    // Determine if this is a desktop entry (has appContext)
    const isDesktopEntry = !!appContext?.appName;
    
    // For mobile: show location (formatted address)
    // For desktop: show windowTitle
    const subtitleText = isDesktopEntry 
      ? appContext.windowTitle || 'Unknown'
      : (location ? formatAddress(location) : 'Unknown Location');
    
    const isProcessing = recordingState === 'processing';
    
    // Use createdAt if available, fallback to timestamp
    const entryTimestamp = entry.createdAt || entry.timestamp;

    // Animate expand/collapse
    useEffect(() => {
      if (expandContentRef.current) {
        if (isExpanded) {
          expandContentRef.current.style.maxHeight = expandContentRef.current.scrollHeight + 'px';
        } else {
          expandContentRef.current.style.maxHeight = '0px';
        }
      }
    }, [isExpanded]);

    const handleClick = (e: React.MouseEvent) => {
      if (isProcessing) {
        return; // Don't expand if still processing
      }
      e.stopPropagation();
      if (onExpandToggle) {
        onExpandToggle();
      } else {
        setInternalIsExpanded(!internalIsExpanded);
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      if (isProcessing) {
        return; // Don't copy if still processing
      }
      if (onCopy) {
        onCopy(entry.text);
      } else {
        navigator.clipboard.writeText(entry.text);
      }
    };

    const handleCopyClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (isProcessing) {
        return;
      }
      if (onCopy) {
        onCopy(entry.text);
      } else {
        navigator.clipboard.writeText(entry.text);
      }
    };

    const displayText = isProcessing ? 'Transcribing...' : entry.text;
    const sourceIcon = isDesktopEntry ? (
      <AppIcon appName={appContext.appName || 'Unknown'} bundleId={appContext.bundleId} size={18} />
    ) : (
      <img 
        src={appIconBase} 
        alt="Memo" 
        className="appIcon" 
        style={{ 
          width: 14, 
          height: 14,
          filter: 'brightness(0) saturate(100%) invert(1)',
          opacity: 0.8
        }} 
      />
    );
    const headerContent = (
      <div className="textContainer">
        {sourceIcon}
        <div className="titleText">{subtitleText}</div>
        <div className="timestamp" style={{ color: primary }}>
          {formatTimestamp(entryTimestamp)}
        </div>
        <button
          type="button"
          className="copyButton"
          aria-label="Copy memo to clipboard"
          title="Copy memo"
          disabled={isProcessing}
          onClick={handleCopyClick}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        {entry.audio && <PlayButton entryId={entry.id} size={18} />}
      </div>
    );

    return (
      <div
        ref={ref}
        className={`container glass-card ${isProcessing ? 'processing' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{
          cursor: isProcessing ? 'default' : 'pointer',
          opacity: isProcessing ? 1 : undefined,
          position: 'relative',
        }}
      >

        {isExpanded ? (
          <>
            <div className="row">
              {headerContent}
            </div>
            <div 
              ref={expandContentRef}
              className="expandedContent"
              style={{
                overflow: 'hidden',
                transition: 'max-height 300ms ease, opacity 300ms ease',
                opacity: isExpanded ? 1 : 0,
              }}
            >
              <div className="fullTextContainer">
                <div 
                  className={`fullText ${isProcessing ? 'processing-text' : ''}`}
                >
                  {displayText}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="row">
              {headerContent}
            </div>
            <div className="collapsedContent">
              <div className="fullTextContainer">
                <div 
                  className={`text ${isProcessing ? 'processing-text' : ''}`}
                >
                  {displayText}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
), (prevProps, nextProps) => {
  return (
    prevProps.entry.id === nextProps.entry.id &&
    prevProps.entry.text === nextProps.entry.text &&
    prevProps.entry.timestamp === nextProps.entry.timestamp &&
    prevProps.entry.createdAt === nextProps.entry.createdAt &&
    prevProps.entry.audio?.fileName === nextProps.entry.audio?.fileName &&
    prevProps.isExpanded === nextProps.isExpanded
  );
});

FeedEntry.displayName = 'FeedEntry';
