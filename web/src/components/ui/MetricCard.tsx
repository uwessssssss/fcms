import React from 'react';
import Icon from '@/components/ui/AppIcon';

interface MetricCardProps {
  label: string;
  value: string;
  unit?: string;
  subtext?: string;
  trend?: { value: string; direction: 'up' | 'down' | 'neutral'; positive: boolean };
  alert?: boolean;
  warning?: boolean;
  icon?: string;
  className?: string;
  featured?: boolean;
  accentColor?: string;
}

export default function MetricCard({
  label,
  value,
  unit,
  subtext,
  trend,
  alert,
  warning,
  icon,
  className = '',
  featured = false,
  accentColor,
}: MetricCardProps) {
  const color = alert
    ? '#F43F5E'
    : warning
    ? '#F59E0B' : accentColor ??'var(--primary)';

  const borderColor = alert
    ? 'rgba(244,63,94,0.25)'
    : warning
    ? 'rgba(245,158,11,0.25)'
    : 'rgba(255,255,255,0.06)';

  const glowClass = alert ? 'glow-danger' : warning ? 'glow-warning' : '';

  return (
    <div
      className={`relative overflow-hidden flex flex-col gap-3 p-5 rounded-2xl transition-all duration-300 hover:translate-y-[-2px] ${glowClass} ${className}`}
      style={{
        background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
        border: `1px solid ${borderColor}`,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3)',
      }}
    >
      {/* Subtle top accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${color}40 50%, transparent 100%)`,
        }}
      />

      {/* Background glow orb */}
      <div
        className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-10 blur-2xl pointer-events-none"
        style={{ backgroundColor: color }}
      />

      <div className="flex items-start justify-between gap-2 relative">
        <p
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
        >
          {label}
        </p>
        {icon && (
          <div
            className="p-2 rounded-xl shrink-0"
            style={{
              backgroundColor: `${color}15`,
              border: `1px solid ${color}25`,
            }}
          >
            <Icon
              name={icon as Parameters<typeof Icon>[0]['name']}
              size={15}
              style={{ color } as React.CSSProperties}
            />
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 relative">
        <span
          className={`font-mono-nums font-bold leading-none tracking-tight ${featured ? 'text-hero-xl' : 'text-2xl'}`}
          style={{ color: alert ? '#F43F5E' : warning ? '#F59E0B' : 'var(--foreground)' }}
        >
          {value}
        </span>
        {unit && (
          <span className="text-sm font-medium mb-0.5" style={{ color: 'var(--muted-foreground)' }}>
            {unit}
          </span>
        )}
      </div>

      {subtext && (
        <p className="text-xs leading-relaxed relative" style={{ color: 'var(--muted-foreground)' }}>
          {subtext}
        </p>
      )}

      {trend && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg w-fit relative"
          style={{
            backgroundColor: trend.positive ? 'rgba(0,212,160,0.08)' : 'rgba(244,63,94,0.08)',
            border: `1px solid ${trend.positive ? 'rgba(0,212,160,0.15)' : 'rgba(244,63,94,0.15)'}`,
          }}
        >
          <Icon
            name={
              trend.direction === 'up' ? 'ArrowTrendingUpIcon'
                : trend.direction === 'down' ? 'ArrowTrendingDownIcon' : 'MinusIcon'
            }
            size={12}
            className={trend.positive ? 'text-primary' : 'text-status-offline'}
          />
          <span
            className="text-xs font-semibold"
            style={{ color: trend.positive ? 'var(--primary)' : 'var(--status-offline)' }}
          >
            {trend.value}
          </span>
        </div>
      )}
    </div>
  );
}