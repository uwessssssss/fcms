'use client';
import { shiftLabelName } from '@/lib/shiftLabel';
import React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipProps } from 'recharts';

import type { ShiftSalesPoint } from '@/types/api';

/**
 * Today's sales, shift by shift -- what the meters measured at each close.
 *
 * This replaced an "hourly" chart drawn from twelve invented numbers. A station
 * that reads its meters per shift knows its sales per shift and no finer, so a
 * per-hour shape would be made up. A shift still open shows nothing yet: its
 * litres are counted when it closes, and it says so.
 */
export const shiftName = (p: ShiftSalesPoint) =>
  `${shiftLabelName(p.label)}${p.segment > 1 ? ` (part ${p.segment})` : ''}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ShiftSalesChart({ rows }: { rows: ShiftSalesPoint[] }) {
  if (rows.length === 0) {
    return <p className="text-sm py-8 text-center" style={{ color: 'var(--muted-foreground)' }}>No shift has been opened on this business day yet.</p>;
  }
  const data = rows.map((p) => ({
    name: shiftName(p),
    when: `${hhmm(p.openedAt)} - ${p.closedAt ? hhmm(p.closedAt) : 'open'}`,
    open: p.state === 'OPEN' || p.state === 'COUNTING',
    revenue: Math.round(p.revenue),
    litres: Math.round(p.litres * 10) / 10,
  }));
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false}
                 tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v))} width={44} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={({ active, payload }: TooltipProps<number, string>) => {
              // recharts types each entry's payload loosely; it is our row.
              const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
              if (!d) return null;
              return (
                <div className="card p-3 text-xs space-y-1" style={{ borderColor: 'var(--border)' }}>
                  <p className="font-semibold text-foreground">{d.name} · {d.when}</p>
                  {d.open
                    ? <p style={{ color: 'var(--muted-foreground)' }}>Still open - counted when it closes</p>
                    : <><p>UGX {d.revenue.toLocaleString()}</p><p>{d.litres.toLocaleString()} L</p></>}
                </div>
              );
            }}
          />
          <Bar dataKey="revenue" name="Revenue" fill="var(--primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
        {data.map((d) => (
          <div key={d.name + d.when} className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <p className="font-semibold text-foreground">{d.name}</p>
            <p style={{ color: 'var(--muted-foreground)' }}>{d.when}</p>
            {d.open
              ? <p style={{ color: '#F59E0B' }}>Open - counted at close</p>
              : <p className="font-mono-nums text-foreground">UGX {d.revenue.toLocaleString()} · {d.litres.toLocaleString()} L</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
