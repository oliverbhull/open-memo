import React from 'react';
import '../styles/glass.css';

interface GlassContainerProps {
  children: React.ReactNode;
}

export const GlassContainer: React.FC<GlassContainerProps> = ({ children }) => {
  return <div className="glass-container">{children}</div>;
};


