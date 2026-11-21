'use client';
import React, { useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';

interface ModalProps {
  /**
   * Every caller passes `isOpen`; the component read `open`.
   *
   * Nine call sites across four screens, none of them using the name the
   * component expected -- so `open` was always undefined, which is falsy, and
   * EVERY MODAL IN THE APPLICATION WAS PERMANENTLY CLOSED. Nothing errored:
   * the button simply did nothing.
   *
   * Both names are accepted so no caller has to change, and `open` stays for
   * anything written against the original signature.
   */
  isOpen?: boolean;
  open?: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  footer?: React.ReactNode;
}

export default function Modal({ isOpen, open, onClose, title, subtitle, children, size = 'md', footer }: ModalProps) {
  const visible = isOpen ?? open ?? false;
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (visible) {
      document.addEventListener('keydown', handleKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [visible, onClose]);

  if (!visible) return null;

  const widthClass = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : size === 'xl' ? 'max-w-4xl' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        backgroundColor: 'rgba(4,8,16,0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
      onClick={onClose}
    >
      <div
        className={`w-full ${widthClass} slide-up`}
        style={{
          background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.8), 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,212,160,0.06)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-6 py-5 shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="flex-1 min-w-0 pr-4">
            <h2 id="modal-title" className="text-base font-bold text-foreground tracking-tight">
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-150 hover:scale-105"
            style={{
              backgroundColor: 'rgba(255,255,255,0.06)',
              color: 'var(--muted-foreground)',
            }}
            aria-label="Close modal"
          >
            <Icon name="XMarkIcon" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            className="px-6 py-4 shrink-0 flex items-center justify-end gap-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}