import React from 'react';

interface KeyboardKeyProps {
  label: string;
  size?: 'small' | 'medium' | 'large';
}

export function KeyboardKey({ label, size = 'medium' }: KeyboardKeyProps) {
  const sizeMap = {
    small: { minWidth: 24, height: 24, fontSize: 10, borderRadius: 4, padding: '2px 4px' },
    medium: { minWidth: 32, height: 32, fontSize: 12, borderRadius: 6, padding: '2px 6px' },
    large: { minWidth: 40, height: 40, fontSize: 14, borderRadius: 8, padding: '2px 8px' },
  };

  const styles = sizeMap[size];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: styles.minWidth,
        height: styles.height,
        backgroundColor: '#000',
        color: '#fff',
        borderRadius: styles.borderRadius,
        fontSize: styles.fontSize,
        fontWeight: '600',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        lineHeight: 1,
        padding: styles.padding,
        margin: '0 2px',
        position: 'relative',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
      }}
    >
      {label}
      {/* Subtle bottom highlight */}
      <span
        style={{
          position: 'absolute',
          bottom: 0,
          left: '10%',
          right: '10%',
          height: '1px',
          backgroundColor: 'rgba(255, 255, 255, 0.2)',
          borderRadius: '0 0 2px 2px',
        }}
      />
    </span>
  );
}
