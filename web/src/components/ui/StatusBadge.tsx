import React from 'react';

type StatusType = 'active' | 'idle' | 'fault' | 'offline' | 'maintenance' | 'replenishing' | 'normal' | 'low' | 'critical';

interface StatusBadgeProps {
  status: StatusType;
  label?: string;
  size?: 'sm' | 'md';
  showDot?: boolean;
}

const statusConfig: Record<StatusType, { label: string; dotColor: string; bg: string; text: string; border: string }> = {
  active:       { label: 'Active',       dotColor: '#00D4A0', bg: 'rgba(0,212,160,0.1)',   text: '#00D4A0', border: 'rgba(0,212,160,0.2)' },
  idle:         { label: 'Idle',         dotColor: '#64748B', bg: 'rgba(100,116,139,0.1)', text: '#64748B', border: 'rgba(100,116,139,0.2)' },
  fault:        { label: 'Fault',        dotColor: '#F59E0B', bg: 'rgba(245,158,11,0.1)',  text: '#F59E0B', border: 'rgba(245,158,11,0.2)' },
  offline:      { label: 'Offline',      dotColor: '#F43F5E', bg: 'rgba(244,63,94,0.1)',   text: '#F43F5E', border: 'rgba(244,63,94,0.2)' },
  maintenance:  { label: 'Maintenance',  dotColor: '#A78BFA', bg: 'rgba(167,139,250,0.1)', text: '#A78BFA', border: 'rgba(167,139,250,0.2)' },
  replenishing: { label: 'Replenishing', dotColor: '#60A5FA', bg: 'rgba(96,165,250,0.1)',  text: '#60A5FA', border: 'rgba(96,165,250,0.2)' },
  normal:       { label: 'Normal',       dotColor: '#00D4A0', bg: 'rgba(0,212,160,0.1)',   text: '#00D4A0', border: 'rgba(0,212,160,0.2)' },
  low:          { label: 'Low Stock',    dotColor: '#F59E0B', bg: 'rgba(245,158,11,0.1)',  text: '#F59E0B', border: 'rgba(245,158,11,0.2)' },
  critical:     { label: 'Critical',     dotColor: '#F43F5E', bg: 'rgba(244,63,94,0.1)',   text: '#F43F5E', border: 'rgba(244,63,94,0.2)' },
};

export default function StatusBadge({ status, label, size = 'md', showDot = true }: StatusBadgeProps) {
  const cfg = statusConfig[status];
  const displayLabel = label ?? cfg.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'
      }`}
      style={{
        backgroundColor: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
        letterSpacing: '0.01em',
      }}
    >
      {showDot && (
        <span
          className="rounded-full shrink-0"
          style={{
            width: size === 'sm' ? 5 : 6,
            height: size === 'sm' ? 5 : 6,
            backgroundColor: cfg.dotColor,
            boxShadow: `0 0 4px ${cfg.dotColor}80`,
          }}
        />
      )}
      {displayLabel}
    </span>
  );
}