import { useTheme } from '../context/ThemeContext';
import { useAudioPlayback } from '../hooks/useAudioPlayback';

interface PlayButtonProps {
  entryId: string;
  size?: number;
}

export function PlayButton({ entryId, size = 18 }: PlayButtonProps) {
  const { primary } = useTheme();
  const { isPlaying, isLoading, toggle } = useAudioPlayback(entryId);

  return (
    <button
      type="button"
      className="copyButton"
      aria-label={isPlaying ? 'Pause saved audio' : 'Play saved audio'}
      aria-pressed={isPlaying}
      title={isPlaying ? 'Pause audio' : 'Play audio'}
      disabled={isLoading}
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
      style={{ color: primary, background: 'transparent', border: 0, borderRadius: 0, position: 'relative' }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
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
