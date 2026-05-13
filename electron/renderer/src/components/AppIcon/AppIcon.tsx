import React from 'react';
import { useTheme } from '../../context/ThemeContext';
import { getIconSlug, findIconBySlug } from './iconLookup';

interface AppIconProps {
  appName: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Component that displays an app icon from simple-icons
 * Falls back to initials if icon not found
 */
export const AppIcon = React.memo(function AppIcon({ 
  appName, 
  size = 24, 
  className,
  style 
}: AppIconProps) {
  const { primary } = useTheme();
  const iconSlug = getIconSlug(appName);
  
  if (iconSlug) {
    const icon = findIconBySlug(iconSlug);
    
    if (icon && icon.path) {
      const svgPath = icon.path;
      // Use the user's primary color instead of the icon's brand color
      const iconColor = primary;
      
      return (
        <svg
          role="img"
          viewBox="0 0 24 24"
          width={size}
          height={size}
          fill={iconColor}
          className={className}
          style={style}
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>{icon.title}</title>
          <path d={svgPath} />
        </svg>
      );
    }
  }
  
  // Fallback to initials
  const initials = appName
    .split(/\s+/)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  
  // Calculate text color that contrasts with primary color
  const getContrastColor = (hex: string): string => {
    // Simple contrast calculation - if primary is dark, use white text, otherwise use dark text
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 128 ? '#000000' : '#ffffff';
  };
  
  return (
    <div
      className={className}
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
        ...style
      }}
    >
      {initials}
    </div>
  );
}, (prevProps, nextProps) => {
  // Only re-render if props change
  return prevProps.appName === nextProps.appName &&
         prevProps.size === nextProps.size &&
         prevProps.className === nextProps.className;
});


