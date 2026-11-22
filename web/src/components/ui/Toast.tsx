'use client';
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

interface ToastMessage {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastMessage['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string, type: ToastMessage['type'] = 'success') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  const iconMap: Record<ToastMessage['type'], string> = {
    success: 'CheckCircleIcon',
    error: 'XCircleIcon',
    warning: 'ExclamationTriangleIcon',
    info: 'InformationCircleIcon',
  };

  const colorMap: Record<ToastMessage['type'], string> = {
    success: 'var(--primary)',
    error: 'var(--status-offline)',
    warning: 'var(--accent)',
    info: 'var(--secondary-foreground)',
  };

  const bgMap: Record<ToastMessage['type'], string> = {
    success: 'rgba(0,212,160,0.08)',
    error: 'rgba(244,63,94,0.08)',
    warning: 'rgba(245,158,11,0.08)',
    info: 'rgba(147,197,253,0.08)',
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="slide-in-right pointer-events-auto flex items-center gap-3 px-4 py-3.5 min-w-[280px] max-w-[380px]"
            style={{
              background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderLeft: `3px solid ${colorMap[t.type]}`,
              borderRadius: '14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
              backgroundColor: bgMap[t.type],
            }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${colorMap[t.type]}15` }}
            >
              <Icon
                name={iconMap[t.type] as Parameters<typeof Icon>[0]['name']}
                size={16}
                style={{ color: colorMap[t.type] }}
              />
            </div>
            <p className="text-sm font-medium text-foreground flex-1 leading-snug">{t.message}</p>
            <button
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="w-6 h-6 flex items-center justify-center rounded-md transition-colors hover:bg-white/10"
              style={{ color: 'var(--muted-foreground)' }}
             aria-label="Close" title="Close">
              <Icon name="XMarkIcon" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}