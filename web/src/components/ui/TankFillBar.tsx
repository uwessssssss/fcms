import React from 'react';

interface TankFillBarProps {
  /**
   * Called two different ways across the app: `percentage` on the dashboard
   * and `fillPct` on site operations. One of those was always undefined, so
   * the bar rendered at NaN% -- which draws as empty, making a full tank look
   * like an empty one.
   *
   * Both are accepted. `status`, where given, overrides the band the
   * percentage would choose: a tank being refilled is blue rather than red,
   * because a delivery in progress is not an alarm.
   */
  percentage?: number;
  fillPct?: number;
  status?: 'normal' | 'low' | 'critical' | 'replenishing';
  height?: number;
  showLabel?: boolean;
  animated?: boolean;
}

function getTankColor(pct: number): string {
  if (pct <= 15) return '#F43F5E';
  if (pct <= 30) return '#F59E0B';
  if (pct <= 50) return '#EAB308';
  return '#00D4A0';
}

function getTankGradient(pct: number): string {
  if (pct <= 15) return 'linear-gradient(90deg, #F43F5E, #E11D48)';
  if (pct <= 30) return 'linear-gradient(90deg, #F59E0B, #D97706)';
  if (pct <= 50) return 'linear-gradient(90deg, #EAB308, #CA8A04)';
  return 'linear-gradient(90deg, #00D4A0, #00B888)';
}

export default function TankFillBar({ percentage, fillPct, status, height = 8, showLabel = false, animated = true }: TankFillBarProps) {
  const raw = percentage ?? fillPct ?? 0;
  const clampedPct = Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 0));
  const color =
    status === 'replenishing' ? '#60A5FA' : getTankColor(clampedPct);
  const gradient =
    status === 'replenishing'
      ? 'linear-gradient(90deg, #60A5FA, #3B82F6)'
      : getTankGradient(clampedPct);

  return (
    <div className="w-full">
      <div
        className="w-full rounded-full overflow-hidden"
        style={{
          height,
          backgroundColor: 'rgba(255,255,255,0.06)',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.4)',
        }}
      >
        <div
          className={animated ? 'tank-fill-bar rounded-full' : 'rounded-full'}
          style={{
            width: `${clampedPct}%`,
            height: '100%',
            background: gradient,
            boxShadow: `0 0 10px ${color}50`,
          }}
        />
      </div>
      {showLabel && (
        <div className="flex justify-between mt-1.5">
          <span
            className="text-xs font-mono-nums font-semibold"
            style={{ color }}
          >
            {clampedPct}%
          </span>
        </div>
      )}
    </div>
  );
}