'use client';
import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

import { api } from '@/lib/api';
import type { FuelGradeSlice } from '@/types/api';

/**
 * Litres sold today, by grade, from GET /api/v1/analytics/fuel.
 *
 * This drew a hardcoded array -- "Unleaded 22,840 L, Diesel 18,620 L, Super
 * 8,940 L" -- left over from the template it was adopted from. Those are not
 * even the grades sold here (PMS, AGO, IK), and the figures never changed. It
 * sat on the dashboard, the first screen anyone opens, looking exactly like a
 * live reading.
 */
const GRADE_COLOUR: Record<string, string> = {
  PMS: '#00D4A0',
  AGO: '#F59E0B',
  IK: '#60A5FA',
  LPG: '#A78BFA',
};

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card p-3 shadow-xl text-xs" style={{ borderColor: 'var(--border)' }}>
      <p className="font-semibold text-foreground mb-1">{label}</p>
      <p className="font-mono-nums" style={{ color: 'var(--primary)' }}>
        {payload[0].value.toLocaleString()} L
      </p>
    </div>
  );
}

export default function FuelGradeBarChart() {
  const [data, setData] = useState<FuelGradeSlice[] | null>(null);

  useEffect(() => {
    void api
      .get<FuelGradeSlice[]>('/api/v1/analytics/fuel?days=1')
      .then(setData)
      .catch(() => setData([]));
  }, []);

  if (data === null) {
    return <div className="h-[220px] flex items-center justify-center text-xs" style={{ color: 'var(--muted-foreground)' }}>Loading...</div>;
  }
  if (data.length === 0) {
    // Said plainly rather than drawn as an empty axis, which reads as "zero
    // litres sold" -- a different and alarming claim.
    return (
      <div className="h-[220px] flex items-center justify-center text-xs text-center px-6" style={{ color: 'var(--muted-foreground)' }}>
        Nothing sold yet today. Litres appear here as shifts close.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barSize={28}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal vertical={false} />
        <XAxis dataKey="gradeCode" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          width={36}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="litres" radius={[4, 4, 0, 0]}>
          {data.map((entry) => (
            <Cell key={`cell-${entry.gradeCode}`} fill={GRADE_COLOUR[entry.gradeCode] ?? '#64748B'} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
