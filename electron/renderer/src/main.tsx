import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { brightenAccentColor, DEFAULT_ACCENT_COLOR } from './utils/colorUtils';

// Initialize primary color from localStorage on load
const storedPrimary = brightenAccentColor(localStorage.getItem('primary') || DEFAULT_ACCENT_COLOR);
document.documentElement.style.setProperty('--primary', storedPrimary);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

