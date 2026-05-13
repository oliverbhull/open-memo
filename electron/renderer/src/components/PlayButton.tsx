import React from 'react';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useTheme } from '../context/ThemeContext';
import '../styles/feed.css';

interface PlayButtonProps {
  entryId: string;
  size?: number;
}

export const PlayButton: React.FC<PlayButtonProps> = ({ entryId, size = 32 }) => {
  const { primary } = useTheme();
  const { isPlaying, progress, isLoading, hasAudio, toggle } = useAudioPlayback(entryId);

  // Don't render if no audio available
  if (!hasAudio) {
    return null;
  }

  const radius = (size - 6) / 2; // Slightly larger radius for better visibility
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <button
      className="playButton"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      style={{
        width: size,
        height: size,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginLeft: 'auto',
        position: 'relative',
      }}
      disabled={isLoading}
    >
      <svg
        width={size}
        height={size}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          overflow: 'visible',
        }}
        viewBox={`0 0 ${size} ${size}`}
      >
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={primary}
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: 'stroke-dashoffset 0.1s linear',
            opacity: 0.5,
          }}
        />
      </svg>
      
      {/* Play/Pause icon */}
      {isLoading ? (
        <div
          style={{
            width: size * 0.4,
            height: size * 0.4,
            border: `2px solid ${primary}`,
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            position: 'relative',
            zIndex: 2,
          }}
        />
      ) : isPlaying ? (
        // Pause icon (two bars)
        <svg
          width={size * 0.5}
          height={size * 0.5}
          viewBox="0 0 24 24"
          fill={primary}
          style={{ position: 'relative', zIndex: 2 }}
        >
          <rect x="6" y="4" width="4" height="16" />
          <rect x="14" y="4" width="4" height="16" />
        </svg>
      ) : (
        // Play icon (triangle)
        <svg
          width={size * 0.5}
          height={size * 0.5}
          viewBox="0 0 24 24"
          fill={primary}
          style={{ position: 'relative', zIndex: 2 }}
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
      
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  );
};
