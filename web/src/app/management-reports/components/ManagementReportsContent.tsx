'use client';

import { businessToday } from '@/lib/dates';
import { useHasDepot } from '@/lib/useHasDepot';
import { shiftLabelName } from '@/lib/shiftLabel';
import React, { useCallback, useEffect, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import type {
  AttendantScoreRow,
  CumulativeLossRow,
  DashboardOverview,
  DirectorsSummary,
  DutyPeriodRow,
  ShiftSalesPoint,
  LossSummary,
  SitePerformanceRow,
  StockCardRow,
  TankInventoryRow,
} from '@/types/api';

/**
 * The reports a director, an auditor or a head office actually asks for.
 *
 * THE MANAGEMENT PACK (once the "directors' pack") comes first because it answers the question an owner
 * asks: are we making money, is the fuel all there, who owes us, what do we
 * owe, and what is waiting on somebody's signature. Every figure is computed
 * by the server from the ledger -- this screen formats, it does not calculate.
 *
 * The other views are the evidence behind those headlines:
 *   loss by grade and cumulatively -- whether a loss is noise or a trend
 *   the attendant scorecard      -- shortages relative to what each person sold
 *   the stock card               -- every movement on one tank, with the running balance
 *   depot against station        -- where the margin is actually made
 *   duty periods                 -- whether each day's shifts were signed off
 *   sales by shift               -- measured at each close. Meters are read per
 *                                   shift, so there is no honest hourly figure;
 *                                   the old "hourly" tab spread totals evenly,
 *                                   in UTC, and folded night shifts into an hour
 */
type Tab = 'directors' | 'loss' | 'scorecard' | 'stockcard' | 'performance' | 'duty' | 'hourly';

const TABS: [Tab, string][] = [
  ['directors', 'Management pack'],
  ['loss', 'Loss trend'],
  ['scorecard', 'Attendants'],
  ['stockcard', 'Stock card'],
  ['performance', 'Depot vs station'],
  ['duty', 'Duty periods'],
  ['hourly', 'By shift'],
];

/** Litres to one place: a loss of 0.4 L rounded to whole litres read as a red "-0". */
const l1 = (v: number) => {
  const r = Math.round(Number(v) * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-UG', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};

export default function ManagementReportsContent() {
  const hasDepot = useHasDepot();
  const today = businessToday();
  const [tab, setTab] = useState<Tab>('directors');
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pack, setPack] = useState<DirectorsSummary | null>(null);
  const [summary, setSummary] = useState<LossSummary[]>([]);
  const [cumulative, setCumulative] = useState<CumulativeLossRow[]>([]);
  const [scores, setScores] = useState<AttendantScoreRow[]>([]);
  const [tanks, setTanks] = useState<TankInventoryRow[]>([]);
  const [tankId, setTankId] = useState('');
  const [card, setCard] = useState<StockCardRow[]>([]);
  const [perf, setPerf] = useState<SitePerformanceRow[]>([]);
  const [duty, setDuty] = useState<DutyPeriodRow[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [siteId, setSiteId] = useState('');
  const [hourDate, setHourDate] = useState(today);
  const [hourly, setHourly] = useState<ShiftSalesPoint[]>([]);

  const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'directors') setPack(await api.get<DirectorsSummary>(`/api/reports/directors?from=${from}&to=${to}`));
      if (tab === 'loss') {
        const [s, c] = await Promise.all([
          api.get<LossSummary[]>(`/api/reports/loss/summary?from=${from}&to=${to}`),
          api.get<CumulativeLossRow[]>(`/api/reports/loss/cumulative?from=${from}&to=${to}`),
        ]);
        setSummary(s);
        setCumulative(c);
      }
      if (tab === 'scorecard') setScores(await api.get<AttendantScoreRow[]>(`/api/reports/scorecard?days=${days}`));
      if (tab === 'stockcard') {
        setCard(tankId ? await api.get<StockCardRow[]>(`/api/reports/stock-card?tankId=${tankId}&from=${from}&to=${to}`) : []);
      }
      if (tab === 'performance') setPerf(await api.get<SitePerformanceRow[]>(`/api/depot/performance?from=${from}&to=${to}`));
      if (tab === 'duty') setDuty(await api.get<DutyPeriodRow[]>(`/api/reports/duty-periods?days=${days}`));
      if (tab === 'hourly') {
        setHourly(siteId ? await api.get<ShiftSalesPoint[]>(`/api/v1/sites/${siteId}/analytics/by-shift?date=${hourDate}`) : []);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [tab, from, to, days, tankId, siteId, hourDate]);

  useEffect(() => {
    void load();
  }, [load]);

  // The tank and site lists, each fetched once when its tab first opens, and
  // the first chosen. This used to happen INSIDE load(): choosing the default
  // changed load's dependencies and ran the report a second time.
  useEffect(() => {
    if (tab !== 'stockcard' || tanks.length) return;
    void api.get<TankInventoryRow[]>('/api/v1/inventory/tanks').then((t) => {
      setTanks(t);
      setTankId((cur) => cur || t[0]?.id || '');
    }).catch(() => undefined);
  }, [tab, tanks.length]);

  useEffect(() => {
    if (tab !== 'hourly' || sites.length) return;
    void api.get<DashboardOverview>('/api/v1/dashboard/overview').then((ov) => {
      const list = ov.sites.filter((x) => x.kind !== 'DEPOT').map((x) => ({ id: x.id, name: x.name }));
      setSites(list);
      setSiteId((cur) => cur || list[0]?.id || '');
    }).catch(() => undefined);
  }, [tab, sites.length]);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const box = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  const red = (bad: boolean) => ({ color: bad ? '#ef4444' : 'var(--foreground)' });

  const Table = ({ head, rows }: { head: string[]; rows: (string | number | React.ReactNode)[][] }) => (
    <div className="rounded-xl border overflow-x-auto" style={box}>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ color: 'var(--muted-foreground)' }}>{head.map((h) => <th key={h} className="text-left p-3">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
              {r.map((c, j) => <td key={j} className="p-3">{c}</td>)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="p-6 text-center" style={{ color: 'var(--muted-foreground)' }}>Nothing in this period.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Management reports</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>Computed by the server from the ledger.</p>
        </div>
        <div className="flex gap-2">
          <input type="date" className="input-field text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="input-field text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
          <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Print</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.filter(([k]) => k !== 'performance' || hasDepot === true).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ background: tab === k ? 'var(--primary)' : 'var(--muted)', color: tab === k ? 'var(--primary-foreground)' : 'var(--foreground)' }}>
            {l}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {!loading && loadError && (
        <div className="rounded-xl border p-4" style={box}>
          <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load this report</p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
        </div>
      )}

      {!loading && !loadError && tab === 'directors' && pack && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            {([
              ['Revenue', `UGX ${fmt(pack.revenue)}`, false],
              ['Gross margin', `UGX ${fmt(pack.grossMargin)}`, pack.grossMargin < 0],
              ['Net position', `UGX ${fmt(pack.netPosition)}`, pack.netPosition < 0],
              ['Margin per litre', `UGX ${fmt(pack.marginPerLitre)}`, pack.marginPerLitre < 0],
              ['Litres sold', `${fmt(pack.totalLitres)} L`, false],
              // negative is fuel missing (the server's sign): said in words, red when lost
              [pack.stockLossLitres < 0 ? 'Stock lost' : 'Stock gained',
               `${fmt(Math.abs(pack.stockLossLitres))} L${pack.stockLossPct !== null ? ` (${Math.abs(pack.stockLossPct).toFixed(2)}%)` : ''}`, pack.stockLossLitres < -0.5],
              ['Owed to us', `UGX ${fmt(pack.receivables)}`, false],
              ['Owed to us, past terms', `UGX ${fmt(pack.receivablesPastTerms)}`, pack.receivablesPastTerms > 0],
              ['We owe', `UGX ${fmt(pack.payables)}`, false],
              ['We owe, overdue', `UGX ${fmt(pack.payablesOverdue)}`, pack.payablesOverdue > 0],
              ['Cash on hand', `UGX ${fmt(pack.cashOnHand)}`, false],
              ['Working capital', `UGX ${fmt(pack.workingCapital)}`, pack.workingCapital < 0],
              ['Open exceptions', `${pack.openExceptions} (${pack.criticalExceptions} critical)`, pack.criticalExceptions > 0],
              ['Loads below cost', `${pack.loadsBelowCost} · UGX ${fmt(pack.belowCostValue)}`, pack.loadsBelowCost > 0],
            ] as [string, string, boolean][]).map(([k, v, bad]) => (
              <div key={k} className="rounded-xl border p-3" style={box}>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{k}</p>
                <p className="text-sm font-bold mt-1" style={red(bad)}>{v}</p>
              </div>
            ))}
          </div>
          <Table head={['Site', 'Kind', 'Litres', 'Revenue', 'Margin', 'Per litre']}
                 rows={pack.sites.map((s) => [s.siteName, s.siteKind.toLowerCase(), fmt(s.litres), fmt(s.revenue),
                   <span key="m" style={red(s.margin < 0)}>{fmt(s.margin)}</span>, s.marginPerLitre === null ? '—' : fmt(s.marginPerLitre)])} />
          {pack.awaiting.length > 0 && (
            <Table head={['Waiting on a signature', 'What', 'Amount', 'Days waiting']}
                   rows={pack.awaiting.map((a) => [a.kind.toLowerCase(), a.description, a.amount === null ? '—' : fmt(a.amount),
                     <span key="d" style={red(a.ageDays > 3)}>{a.ageDays}</span>])} />
          )}
          {pack.concentration.length > 0 && (
            <Table head={['Largest debtors', 'Owed', 'Share of all credit', 'Oldest (days)']}
                   rows={pack.concentration.map((c) => [c.name, <span key="b" style={red(c.overdue)}>{fmt(c.balance)}</span>,
                     `${c.sharePct.toFixed(1)}%`, c.oldestDays ?? '—'])} />
          )}
        </>
      )}

      {!loading && !loadError && tab === 'loss' && (
        <>
          <Table head={['Grade', 'Sold', 'Lost', 'Value', 'Loss %', 'Tolerance', 'Days with a loss', 'Worst day']}
                 rows={summary.map((s) => [s.productCode, fmt(s.totalSold), <span key="l" style={red(s.totalLoss < 0)}>{l1(s.totalLoss)}</span>,
                   fmt(s.totalLossValue),
                   <span key="p" style={red(s.overTolerance)}>{s.lossPct === null ? '—' : `${s.lossPct.toFixed(2)}%`}</span>,
                   s.tolerancePct === null ? '—' : `${Number(s.tolerancePct).toFixed(2)}%`,
                   `${s.daysWithLoss} of ${s.daysMeasured}`, s.worstDate ? `${l1(s.worstDayLitres)} L on ${s.worstDate}` : '—'])} />
          <Table head={['Date', 'Grade', 'Lost that day', 'Lost so far', 'Of all sold']}
                 rows={cumulative.map((c) => [c.businessDate, c.productCode, l1(c.dayLossLitres),
                   <span key="c" style={red(c.cumulativeLossLitres < 0)}>{l1(c.cumulativeLossLitres)}</span>,
                   c.cumulativeLossPct === null ? '—' : `${c.cumulativeLossPct.toFixed(2)}%`])} />
        </>
      )}

      {!loading && !loadError && tab === 'scorecard' && (
        <Table head={['Attendant', 'Shifts', 'Litres', 'Sales', 'Shortages', 'Shortage rate', 'Exceptions']}
               rows={scores.map((s) => [s.fullName, s.shifts, fmt(s.litresSold), fmt(s.salesValue), fmt(s.shortagesRaised),
                 <span key="r" style={red(s.shortageRate > 0.5)}>{s.shortageRate.toFixed(2)}%</span>, s.exceptionsAgainst])} />
      )}

      {!loading && !loadError && tab === 'stockcard' && (
        <>
          <select className="input-field text-xs" value={tankId} onChange={(e) => setTankId(e.target.value)}>
            {tanks.map((t) => <option key={t.id} value={t.id}>{t.site} · {t.code} · {t.gradeCode}</option>)}
          </select>
          <Table head={['When', 'Movement', 'Litres', 'Balance']}
                 rows={card.map((c) => [new Date(c.occurredAt).toLocaleString(), c.kind.toLowerCase().replace(/_/g, ' '),
                   <span key="l" style={{ color: c.signedLitres < 0 ? '#F59E0B' : '#22c55e' }}>{fmt(c.signedLitres)}</span>, fmt(c.runningLitres)])} />
        </>
      )}

      {!loading && !loadError && tab === 'performance' && (
        <Table head={['Date', 'Site', 'Retail L', 'Bulk L', 'Revenue', 'Cost', 'Margin']}
               rows={perf.map((p) => [p.businessDate, `${p.siteName} (${p.siteKind.toLowerCase()})`, fmt(p.retailLitres), fmt(p.bulkLitres),
                 fmt(p.revenue), fmt(p.cost), <span key="m" style={red(p.margin < 0)}>{fmt(p.margin)}</span>])} />
      )}

      {!loading && !loadError && tab === 'duty' && (
        <Table head={['Date', 'Shift', 'Segments', 'Started', 'Ended', 'Signed off', 'Why it was cut']}
               rows={duty.map((d) => [d.businessDate, d.label, d.segments, new Date(d.startedAt).toLocaleTimeString(),
                 d.endedAt ? new Date(d.endedAt).toLocaleTimeString() : 'still open',
                 <span key="s" style={red(!d.fullySignedOff)}>{d.fullySignedOff ? 'yes' : 'NO'}</span>,
                 (d.cutReasons ?? []).join(', ') || '—'])} />
      )}

      {!loading && !loadError && tab === 'hourly' && (
        <>
          <div className="flex gap-2">
            <select className="input-field text-xs" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="date" className="input-field text-xs" value={hourDate} onChange={(e) => setHourDate(e.target.value)} />
          </div>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Measured at each close. A shift still open is counted when it closes.
          </p>
          <Table head={['Shift', 'Opened', 'Closed', 'Litres', 'Revenue']}
                 rows={hourly.map((h) => [
                   `${shiftLabelName(h.label)}${h.segment > 1 ? ` (part ${h.segment})` : ''}`,
                   new Date(h.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                   h.closedAt ? new Date(h.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'open',
                   h.state === 'OPEN' || h.state === 'COUNTING' ? '—' : fmt(h.litres),
                   h.state === 'OPEN' || h.state === 'COUNTING' ? '—' : fmt(h.revenue)])} />
        </>
      )}
    </div>
  );
}
