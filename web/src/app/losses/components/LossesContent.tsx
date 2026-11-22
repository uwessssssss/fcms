'use client';

import { businessToday } from '@/lib/dates';
import React, { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import type { DailyLossRow, DivergenceRow } from '@/types/api';

/**
 * Where fuel going missing actually shows up.
 *
 * Two different questions, and they are not interchangeable:
 *
 *   STOCK LOSS asks whether the fuel in the ground matches the books. Book
 *   minus dip, per tank per day. It catches a leak, a delivery short-landed,
 *   fuel drawn without a record -- anything where the litres left the tank
 *   without the meter counting them.
 *
 *   METER DIVERGENCE asks whether the two heads on the same nozzle agree. The
 *   MECHANICAL totalizer is the legal figure and what the attendant is billed
 *   on; the electronic one is a cross-check. When they drift apart it is
 *   usually the pump, occasionally the reading, and rarely nothing.
 *
 * A tank can be perfectly reconciled while a nozzle diverges badly, and the
 * reverse. Showing them apart is the point.
 *
 * THE SIGN MATTERS. A positive loss is fuel that should be there and is not.
 * A NEGATIVE loss -- more fuel than the books expect -- is not good news: it
 * usually means a delivery was recorded short, a dip was misread, or litres
 * were poured back without a return-to-tank. Both directions are flagged.
 */
export default function LossesContent() {
  const today = businessToday();
  const monthStart = today.slice(0, 8) + '01';

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<'stock' | 'meters'>('stock');
  const [daily, setDaily] = useState<DailyLossRow[]>([]);
  const [divergence, setDivergence] = useState<DivergenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, v] = await Promise.all([
        api.get<DailyLossRow[]>(`/api/reports/loss/daily?from=${from}&to=${to}`),
        api.get<DivergenceRow[]>(`/api/reports/loss/divergence?from=${from}&to=${to}`),
      ]);
      setDaily(d);
      setDivergence(v);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const totalLoss = daily.reduce((t, r) => t + r.lossLitres, 0);
  const totalValue = daily.reduce((t, r) => t + r.lossValue, 0);

  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  // The server's sign: NEGATIVE is fuel the dips did not find (v_daily_stock_loss,
  // as the profit statement reads it). This screen read it the other way, so a
  // real loss showed as a gain.
  const lossColour = (l: number) => (Math.abs(l) < 0.5 ? 'var(--foreground)' : l < 0 ? '#ef4444' : '#F59E0B');

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Losses</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Fuel against the books, and the two meter heads against each other.
          </p>
        </div>
        <div className="flex gap-2">
          <input type="date" className="input-field text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="input-field text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="flex gap-2">
        {(['stock', 'meters'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{
              background: tab === t ? 'var(--primary)' : 'var(--muted)',
              color: tab === t ? 'var(--primary-foreground)' : 'var(--foreground)',
            }}
          >
            {t === 'stock' ? 'Stock loss' : 'Meter divergence'}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border p-4" style={card}>
          <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load</p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
        </div>
      )}

      {!loading && !loadError && tab === 'stock' && (
        <>
          <div className="rounded-xl border p-4" style={card}>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Over this period, book against dip
            </p>
            <p className="text-lg font-bold mt-1" style={{ color: lossColour(totalLoss) }}>
              {/* a loss is shown negative, a gain positive, nothing as 0 (it read "+-0") */}
              {Math.abs(totalLoss) < 0.05 ? '0' : totalLoss < 0 ? `-${fmt(-totalLoss)}` : `+${fmt(totalLoss)}`} L
              <span className="text-xs font-normal" style={{ color: 'var(--muted-foreground)' }}>
                {' '}worth UGX {fmt(Math.abs(totalValue))}
              </span>
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
              {totalLoss <= -0.05
                ? 'Fuel the books expect that the dips did not find.'
                : totalLoss >= 0.05
                  ? 'More fuel than the books expect. Usually a delivery recorded short, a misread dip, or litres poured back without a return-to-tank.'
                  : 'The tanks agree with the books.'}
            </p>
          </div>

          <div className="rounded-xl border overflow-x-auto" style={card}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--muted-foreground)' }}>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Tank</th>
                  <th className="text-right p-3">Received</th>
                  <th className="text-right p-3">Sold</th>
                  <th className="text-right p-3">Book</th>
                  <th className="text-right p-3">Dipped</th>
                  <th className="text-right p-3">Loss</th>
                  <th className="text-right p-3">Value</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r, i) => (
                  <tr key={`${r.businessDate}-${r.tankCode}-${i}`} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="p-3">{r.businessDate}</td>
                    <td className="p-3">{r.tankCode} · {r.productCode}</td>
                    <td className="p-3 text-right">{fmt(r.receivedLitres)}</td>
                    <td className="p-3 text-right">{fmt(r.soldLitres)}</td>
                    <td className="p-3 text-right">{fmt(r.bookLitres)}</td>
                    <td className="p-3 text-right">{fmt(r.actualLitres)}</td>
                    <td className="p-3 text-right font-semibold" style={{ color: lossColour(r.lossLitres) }}>
                      {fmt(r.lossLitres)}
                      {r.lossPct !== null && (
                        <span className="font-normal" style={{ color: 'var(--muted-foreground)' }}>
                          {' '}({r.lossPct.toFixed(2)}%)
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right">{fmt(r.lossValue)}</td>
                  </tr>
                ))}
                {daily.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-6 text-center" style={{ color: 'var(--muted-foreground)' }}>
                      Nothing reconciled in this period. A day appears once its shift has closed
                      and its tanks have been dipped.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && !loadError && tab === 'meters' && (
        <div className="rounded-xl border overflow-x-auto" style={card}>
          <p className="text-xs p-3" style={{ color: 'var(--muted-foreground)' }}>
            The mechanical head is the legal figure and what the attendant is billed on.
            The electronic one is the cross-check. Drift is usually the pump.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--muted-foreground)' }}>
                <th className="text-left p-3">Date</th>
                <th className="text-left p-3">Nozzle</th>
                <th className="text-left p-3">Held by</th>
                <th className="text-right p-3">Mechanical</th>
                <th className="text-right p-3">Electronic</th>
                <th className="text-right p-3">Drift</th>
              </tr>
            </thead>
            <tbody>
              {divergence.map((r, i) => (
                <tr key={`${r.businessDate}-${r.nozzleLabel}-${i}`} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3">{r.businessDate}</td>
                  <td className="p-3">{r.nozzleLabel} · {r.productCode}</td>
                  <td className="p-3">{r.attendantName}</td>
                  <td className="p-3 text-right">{fmt(r.mechanicalLitres)}</td>
                  <td className="p-3 text-right">
                    {r.electronicLitres === null ? '—' : fmt(r.electronicLitres)}
                  </td>
                  <td
                    className="p-3 text-right font-semibold"
                    style={{ color: r.divergencePct !== null && Math.abs(r.divergencePct) > 0.5 ? '#ef4444' : 'var(--foreground)' }}
                  >
                    {r.divergenceLitres === null ? '—' : fmt(r.divergenceLitres)}
                    {r.divergencePct !== null && (
                      <span className="font-normal" style={{ color: 'var(--muted-foreground)' }}>
                        {' '}({r.divergencePct.toFixed(2)}%)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {divergence.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center" style={{ color: 'var(--muted-foreground)' }}>
                    No divergence recorded. A nozzle appears here once a closing reading has
                    carried both heads.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
