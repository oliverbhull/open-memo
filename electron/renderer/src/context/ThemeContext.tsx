import React from 'react';

type ThemeContextValue = {
  primary: string;
  setPrimary: (c: string) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

function applyPrimary(color: string) {
  document.documentElement.style.setProperty('--primary', color);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [primary, setPrimaryState] = React.useState<string>(() => {
    const stored = localStorage.getItem('primary');
    return stored || '#C26D50'; // Default to Terracotta
  });

  React.useEffect(() => {
    applyPrimary(primary);
    localStorage.setItem('primary', primary);
  }, [primary]);

  const value: ThemeContextValue = {
    primary,
    setPrimary: (c) => setPrimaryState(c),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

