import React, { useState, useEffect } from 'react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  timestamp: number;
  exiting?: boolean;
}

let toastId = 0;

// Global toast trigger
const toastListeners: ((toast: Toast) => void)[] = [];
// eslint-disable-next-line react-refresh/only-export-components -- imperative toast API colocated with container
export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const toast: Toast = { id: `toast_${toastId++}`, message, type, timestamp: Date.now() };
  toastListeners.forEach(fn => fn(toast));
}

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (toast: Toast) => {
      setToasts(prev => [...prev, toast]);
      // Start exit animation
      setTimeout(() => {
        setToasts(prev => prev.map(t => t.id === toast.id ? { ...t, exiting: true } : t));
      }, 2200);
      // Remove after exit animation
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toast.id));
      }, 2500);
    };
    toastListeners.push(handler);
    return () => {
      const idx = toastListeners.indexOf(handler);
      if (idx >= 0) toastListeners.splice(idx, 1);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}${t.exiting ? ' toast-exit' : ''}`}>
          <span className="toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
          </span>
          <span className="toast-message">{t.message}</span>
        </div>
      ))}
    </div>
  );
};
