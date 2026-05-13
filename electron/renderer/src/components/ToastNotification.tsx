import React, { useState, useEffect } from 'react';

export type ToastSeverity = 'success' | 'warning' | 'error' | 'info';

export interface ToastData {
  message: string;
  severity: ToastSeverity;
  duration: number;
}

interface ToastNotificationProps {
  toast: ToastData | null;
  onClose: () => void;
}

export const ToastNotification: React.FC<ToastNotificationProps> = ({ toast, onClose }) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (toast) {
      setIsVisible(true);

      const hideTimeout = setTimeout(() => {
        setIsVisible(false);
        setTimeout(onClose, 300); // Wait for fade out animation
      }, toast.duration);

      return () => clearTimeout(hideTimeout);
    } else {
      setIsVisible(false);
    }
  }, [toast, onClose]);

  if (!toast) return null;

  return (
    <div
      className={`toast ${isVisible ? 'toast-visible' : ''}`}
      role="status"
      aria-live="polite"
    >
      {toast.severity === 'success' && (
        <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {toast.severity === 'warning' && (
        <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
      {toast.severity === 'error' && (
        <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      )}
      {toast.severity === 'info' && (
        <svg className="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      )}
      <span>{toast.message}</span>
    </div>
  );
};
