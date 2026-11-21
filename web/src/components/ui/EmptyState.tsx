import React from 'react';
import Icon from '@/components/ui/AppIcon';

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
        style={{
          background: 'linear-gradient(135deg, rgba(0,212,160,0.1) 0%, rgba(0,212,160,0.05) 100%)',
          border: '1px solid rgba(0,212,160,0.15)',
          boxShadow: '0 4px 20px rgba(0,212,160,0.08)',
        }}
      >
        <Icon name={icon as Parameters<typeof Icon>[0]['name']} size={26} className="text-primary" />
      </div>
      <h3 className="text-base font-bold text-foreground mb-2 tracking-tight">{title}</h3>
      <p className="text-sm max-w-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
        {description}
      </p>
      {action && (
        <button onClick={action.onClick} className="btn-primary mt-6">
          {action.label}
        </button>
      )}
    </div>
  );
}