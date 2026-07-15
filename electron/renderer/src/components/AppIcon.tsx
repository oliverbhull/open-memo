import { memo, type CSSProperties } from 'react';
import { useTheme } from '../context/ThemeContext';

interface AppIconProps {
  appName: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export const AppIcon = memo(function AppIcon({
  appName,
  size = 24,
  className,
  style,
}: AppIconProps) {
  const { primary } = useTheme();
  const initials = appName
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div
      className={className}
      aria-label={appName}
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        color: primary,
        background: 'transparent',
        borderRadius: size * 0.25,
        ...style,
      }}
    >
      {initials || '?'}
    </div>
  );
});
