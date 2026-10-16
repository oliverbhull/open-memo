import { memo, useEffect, useState, type CSSProperties } from 'react';
import { useTheme } from '../context/ThemeContext';

interface AppIconProps {
  appName: string;
  bundleId?: string;
  websiteDomain?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const iconCache = new Map<string, Promise<string | null>>();

function loadIcon(appName: string, bundleId?: string, websiteDomain?: string): Promise<string | null> {
  const key = `${bundleId || appName.toLowerCase()}:${websiteDomain || ''}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const request = window.electronAPI.appIcons.get(appName, bundleId, websiteDomain).catch(() => null);
  iconCache.set(key, request);
  return request;
}

export const AppIcon = memo(function AppIcon({
  appName,
  bundleId,
  websiteDomain,
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
    setIconUrl(null);
    loadIcon(appName, bundleId, websiteDomain).then((url) => {
      if (!cancelled) setIconUrl(url);
    });
    return () => { cancelled = true; };
  }, [appName, bundleId, websiteDomain]);

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        onError={() => {
          if (websiteDomain) {
            loadIcon(appName, bundleId).then(setIconUrl);
          } else {
            setIconUrl(null);
          }
        }}
        alt=""
        aria-label={websiteDomain || appName}
        className={className}
        style={{
          width: size,
          height: size,
          display: 'block',
          objectFit: 'contain',
          // Favicons typically fill their canvas; app artwork includes an inset.
          boxSizing: 'border-box',
          padding: websiteDomain ? size / 9 : 0,
          borderRadius: size * 0.22,
          ...style,
        }}
      />
    );
  }

  return (
    <div
      className={className}
      aria-label={websiteDomain || appName}
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
