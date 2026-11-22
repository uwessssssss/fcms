'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

import { api } from '@/lib/api';
import type { RevenuePoint } from '@/types/api';

/**
 * Revenue by day and site, from GET /api/v1/analytics/revenue.
 *
 * This drew fixed revenue for HARLOW, BASILDON, CHELMSFORD, ROMFORD and GRAYS
 * -- towns in Essex, from the template this screen was adopted from -- in
 * pounds sterling, on a business that trades in shillings in Uganda. It is
 * now pivoted from the server's rows: one series per site that actually
 * traded, whatever they are called.
 */
const PALETTE = ['#00D4A0', '#3B82F6', '#F59E0B', '#8B5CF6', '#EF4444', '#14B8A6'];

export default function RevenueAreaChart({ days = 7 }: { days?: number }) {
  const [rows, setRows] = useState<RevenuePoint[] | null>(null);

  useEffect(() => {
    void api
      .get<RevenuePoint[]>(`/api/v1/analytics/revenue?days=${days}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [days]);

  // One row per day, one key per site -- recharts wants the wide shape.
  const { data, sites } = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>();
    const siteSet = new Set<string>();
    for (const r of rows ?? []) {
      siteSet.add(r.siteName);
      const d = byDay.get(r.date) ?? { date: r.date.slice(5) };
      d[r.siteName] = r.revenue;
      byDay.set(r.date, d);
    }
    const ordered = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
    return { data: ordered, sites: Array.from(siteSet) };
  }, [rows]);

  if (rows === null) {
    return <div className="h-[220px] flex items-center justify-center text-xs" style={{ color: 'var(--muted-foreground)' }}>Loading...</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-xs text-center px-6" style={{ color: 'var(--muted-foreground)' }}>
        No closed shifts in the last {days} days, so there is no revenue to chart yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {sites.map((_, i) => (
            <linearGradient key={`grad-${i}`} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.25} />
              <stop offset="95%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${(v / 1000).toFixed(0)}k`)}
          width={44}
        />
        <Tooltip
          formatter={(v: number, name: string) => [`UGX ${v.toLocaleString()}`, name]}
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', fontSize: 12 }}
        />
        {/* Its own legend, from the same series as the lines: the dashboard's
            legend took its colours from a different list of sites, so a line
            could wear another site's colour. */}
        <Legend wrapperStyle={{ fontSize: 11, color: 'var(--muted-foreground)' }} iconType="circle" iconSize={8} />
        {sites.map((s, i) => (
          <Area
            key={`area-${i}`}
            type="monotone"
            dataKey={s}
            stroke={PALETTE[i % PALETTE.length]}
            strokeWidth={2}
            fill={`url(#grad-${i})`}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
