import React from 'react';

interface SkeletonProps {
  className?: string;
  height?: string | number;
  width?: string | number;
  rounded?: string;
}

export function Skeleton({ className = '', height, width, rounded = 'rounded-lg' }: SkeletonProps) {
  return (
    <div
      className={`shimmer ${rounded} ${className}`}
      style={{
        height: height,
        width: width,
      }}
    />
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 fade-in">
      {/* KPI row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {['sk-kpi-1', 'sk-kpi-2', 'sk-kpi-3', 'sk-kpi-4'].map((k) => (
          <div key={k} className="rounded-2xl p-5 space-y-3" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Skeleton height={10} width="55%" />
            <Skeleton height={28} width="65%" />
            <Skeleton height={8} width="35%" />
          </div>
        ))}
      </div>
      {/* Site grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-4">
        {['sk-site-1', 'sk-site-2', 'sk-site-3', 'sk-site-4', 'sk-site-5'].map((k) => (
          <div key={k} className="rounded-2xl p-4 space-y-3" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Skeleton height={14} width="75%" />
            <Skeleton height={8} width="45%" />
            <Skeleton height={6} className="rounded-full" />
            <Skeleton height={36} />
          </div>
        ))}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 rounded-2xl p-5" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Skeleton height={200} />
        </div>
        <div className="rounded-2xl p-5" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Skeleton height={200} />
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`sk-row-${i + 1}`} className="flex gap-4 px-4 py-3.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {Array.from({ length: cols }).map((__, j) => (
            <Skeleton key={`sk-cell-${i + 1}-${j + 1}`} height={12} className="flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}