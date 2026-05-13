import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Initialize primary color from localStorage on load
const storedPrimary = localStorage.getItem('primary') || '#C26D50';
document.documentElement.style.setProperty('--primary', storedPrimary);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


