import { memo, useEffect, useState, type CSSProperties } from 'react';
import { useTheme } from '../context/ThemeContext';

interface AppIconProps {
  appName: string;
  bundleId?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const iconCache = new Map<string, Promise<string | null>>();

function loadIcon(appName: string, bundleId?: string): Promise<string | null> {
  const key = bundleId || appName.toLowerCase();
  const cached = iconCache.get(key);
  if (cached) return cached;
  const request = window.electronAPI.appIcons.get(appName, bundleId).catch(() => null);
  iconCache.set(key, request);
  return request;
}

export const AppIcon = memo(function AppIcon({
  appName,
  bundleId,
  size = 24,
  className,
  style,
}: AppIconProps) {
  const { primary } = useTheme();
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const initials = appName
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  useEffect(() => {
    let cancelled = false;
    loadIcon(appName, bundleId).then((url) => {
      if (!cancelled) setIconUrl(url);
    });
    return () => { cancelled = true; };
  }, [appName, bundleId]);

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-label={appName}
        className={className}
        style={{
          width: size,
          height: size,
          display: 'block',
          objectFit: 'contain',
          borderRadius: size * 0.22,
          ...style,
        }}
      />
    );
  }

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
