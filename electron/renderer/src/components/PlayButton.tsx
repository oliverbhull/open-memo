import { useTheme } from '../context/ThemeContext';
import { useAudioPlayback } from '../hooks/useAudioPlayback';

interface PlayButtonProps {
  entryId: string;
  size?: number;
}

export function PlayButton({ entryId, size = 18 }: PlayButtonProps) {
  const { primary } = useTheme();
  const { isPlaying, isLoading, progress, toggle } = useAudioPlayback(entryId);
  const radius = (size - 3) / 2;
  const circumference = Math.PI * 2 * radius;

  return (
    <button
      type="button"
      className="copyButton"
      aria-label={isPlaying ? 'Pause saved audio' : 'Play saved audio'}
      title={isPlaying ? 'Pause audio' : 'Play audio'}
      disabled={isLoading}
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
      style={{ color: primary, position: 'relative' }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.25"
        />
        {progress > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {isLoading ? (
          <circle cx={size / 2} cy={size / 2} r="1.5" fill="currentColor" opacity="0.65" />
        ) : isPlaying ? (
          <>
            <rect x={size * 0.36} y={size * 0.31} width={size * 0.1} height={size * 0.38} fill="currentColor" />
            <rect x={size * 0.54} y={size * 0.31} width={size * 0.1} height={size * 0.38} fill="currentColor" />
          </>
        ) : (
          <path d={`M ${size * 0.4} ${size * 0.3} L ${size * 0.7} ${size * 0.5} L ${size * 0.4} ${size * 0.7} Z`} fill="currentColor" />
        )}
      </svg>
    </button>
  );
}
