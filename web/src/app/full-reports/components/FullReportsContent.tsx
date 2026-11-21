'use client';
import { useStatement, field, num } from '@/lib/useStatement';
import { useSites } from '@/lib/useSites';
import type { DailyLossRow, DivergenceRow } from '@/types/api';
import { api } from '@/lib/api';
import { businessToday, localDate, monthStartOf } from '@/lib/dates';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────
type ReportType = 'daily' | 'weekly' | 'monthly' | 'shift' | 'gainloss' | 'expenses' | 'credit' | 'payments' | 'stock' | 'dipping' | 'variances' | 'pump';

interface DailySummary {
  date: string;
  site: string;
  totalSales: number;
  cashSales: number;
  mobileMoney: number;
  visa: number;
  credit: number;
  discounts: number;
  expenses: number;
  litresSold: number;
  gainLoss: number;
  short: number;
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

/**
 * A day's trading, from GET /api/statements/daily-summary
 *
 * One row a day, assembled server-side from six separate sources -- meter
 * sales, tenders, credit, discounts, expenses and the dip variance. Doing that
 * join here would mean six requests and a different answer from the statement
 * showing the same period.
 */
function toDailySummary(r: Record<string, unknown>): DailySummary {
  return {
    date: field(r, 'date'),
    site: field(r, 'site'),
    totalSales: num(r, 'total_sales'),
    cashSales: num(r, 'cash'),
    mobileMoney: num(r, 'mobile_money'),
    visa: num(r, 'card'),
    credit: num(r, 'credit'),
    discounts: num(r, 'discounts'),
    expenses: num(r, 'expenses'),
    litresSold: num(r, 'litres'),
    gainLoss: num(r, 'gain_loss'),
    short: num(r, 'short'),
  } satisfies DailySummary;
}



// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n: number, dec = 0) { return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function fmtUGX(n: number) { return 'UGX ' + fmt(n); }

const reportMenu: { key: ReportType; label: string; icon: string; group: string; description: string }[] = [
  { key: 'daily', label: 'Daily Statement', icon: 'CalendarDaysIcon', group: 'Statements', description: 'Full daily sales, payments & reconciliation' },
  { key: 'weekly', label: 'Weekly Summary', icon: 'CalendarIcon', group: 'Statements', description: '7-day aggregated performance overview' },
  { key: 'monthly', label: 'Monthly Report', icon: 'ChartBarIcon', group: 'Statements', description: 'Monthly totals, trends and comparisons' },
  { key: 'shift', label: 'Shift Reports', icon: 'ClipboardDocumentCheckIcon', group: 'Statements', description: 'Per-shift closure statements' },
  { key: 'gainloss', label: 'Gain / Loss', icon: 'ArrowTrendingUpIcon', group: 'Stock', description: 'Daily & cumulative stock gain/loss analysis' },
  { key: 'stock', label: 'Stock Movement', icon: 'BeakerIcon', group: 'Stock', description: 'Opening, received, sold, closing stock' },
  { key: 'dipping', label: 'Dipping Report', icon: 'BeakerIcon', group: 'Stock', description: 'Tank dipping records and variances' },
  { key: 'expenses', label: 'Expenses Report', icon: 'ReceiptRefundIcon', group: 'Finance', description: 'All operational expenses by category' },
  { key: 'credit', label: 'Credit Statement', icon: 'UserGroupIcon', group: 'Finance', description: 'Credit customer balances and transactions' },
  { key: 'payments', label: 'Payments Breakdown', icon: 'CreditCardIcon', group: 'Finance', description: 'Mobile money, Visa, cash breakdown' },
  { key: 'variances', label: 'Variances Report', icon: 'AdjustmentsHorizontalIcon', group: 'Analysis', description: 'Meter vs dipping variances per grade' },
  { key: 'pump', label: 'Pump Performance', icon: 'BoltIcon', group: 'Analysis', description: 'Pump uptime, litres, transactions, revenue' },
];

const groups = ['Statements', 'Stock', 'Finance', 'Analysis'];

const groupColors: Record<string, string> = {
  Statements: '#00D4A0',
  Stock: '#60A5FA',
  Finance: '#A78BFA',
  Analysis: '#F59E0B',
};

// ─── Sub-components ───────────────────────────────────────────────────────────
function GainLossBadge({ value, decimals = 1, suffix = ' L' }: { value: number; decimals?: number; suffix?: string }) {
  const positive = value >= 0;
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold font-mono-nums"
      style={{
        background: positive ? 'rgba(0,212,160,0.1)' : 'rgba(244,63,94,0.1)',
        color: positive ? '#00D4A0' : '#F43F5E',
        border: `1px solid ${positive ? 'rgba(0,212,160,0.2)' : 'rgba(244,63,94,0.2)'}`,
      }}
    >
      {positive ? '▲' : '▼'} {positive ? '+' : ''}{fmt(value, decimals)}{suffix}
    </span>
  );
}

function TableWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div className="overflow-x-auto scrollbar-thin">
        {children}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FullReportsContent() {
  const [partial, setPartial] = useState<string[]>([]);
  const SITES = useSites();
  const {
    rows: dailyData,
    loading,
    error: loadError,
  } = useStatement<DailySummary>('daily-summary', toDailySummary);

  const { isSiteManager, assignedSite } = useAuth();
  const [activeReport, setActiveReport] = useState<ReportType>('daily');
  const [filterSite, setFilterSite] = useState('all');
  const [dateFrom, setDateFrom] = useState(monthStartOf(businessToday()));
  const [dateTo, setDateTo] = useState(businessToday());

  // ── STOCK AND PUMPS, FROM THE LEDGER ──
  //
  // Both tables were fixed arrays. The stock one invented gain and loss by
  // grade; the pump one reported TRANSACTIONS, UPTIME and AVERAGE TRANSACTION
  // -- things a manually-read forecourt never records at all. Both also fed
  // the export, so a downloaded report carried the invented figures too.
  //
  // Stock now comes from the daily reconciliation (book against dip) and
  // pumps from the meter readings. Where a figure does not exist, it is not
  // drawn.
  const [lossRows, setLossRows] = useState<DailyLossRow[]>([]);
  const [divRows, setDivRows] = useState<DivergenceRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<DailyLossRow[]>(`/api/reports/loss/daily?from=${dateFrom}&to=${dateTo}`),
      api.get<DivergenceRow[]>(`/api/reports/loss/divergence?from=${dateFrom}&to=${dateTo}`),
    ])
      .then(([l, d]) => {
        if (!cancelled) {
          setLossRows(l);
          setDivRows(d);
        }
      })
      .catch(() => setPartial((x) => (x.includes('the stock and pump figures') ? x : [...x, 'the stock and pump figures'])));
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo]);

  const stockData = useMemo(() => {
    const byGrade = new Map<string, DailyLossRow[]>();
    for (const r of lossRows) byGrade.set(r.productCode, [...(byGrade.get(r.productCode) ?? []), r]);
    return Array.from(byGrade.entries()).map(([grade, rows]) => {
      const sold = rows.reduce((t, r) => t + r.soldLitres, 0);
      const received = rows.reduce((t, r) => t + r.receivedLitres, 0);
      const loss = rows.reduce((t, r) => t + r.lossLitres, 0);
      const lossValue = rows.reduce((t, r) => t + r.lossValue, 0);
      // Closing is each tank's LAST dip in the period, summed across tanks.
      const lastByTank = new Map<string, DailyLossRow>();
      for (const r of rows) {
        const prev = lastByTank.get(r.tankCode);
        if (!prev || r.businessDate > prev.businessDate) lastByTank.set(r.tankCode, r);
      }
      const closingStock = Array.from(lastByTank.values()).reduce((t, r) => t + r.actualLitres, 0);
      return {
        grade,
        // Derived, not invented: what must have been there for the period's
        // movements and the final dip to agree.
        openingStock: closingStock + sold - received + loss,
        received,
        sold,
        closingStock,
        // Litres, positive for a gain -- the sign the export column states.
        gainLoss: -loss,
        gainLossValue: -lossValue,
        price: loss !== 0 ? Math.abs(lossValue / loss) : 0,
      };
    });
  }, [lossRows]);

  const pumpData = useMemo(() => {
    const byNozzle = new Map<string, DivergenceRow[]>();
    for (const r of divRows) byNozzle.set(r.nozzleLabel, [...(byNozzle.get(r.nozzleLabel) ?? []), r]);
    return Array.from(byNozzle.entries()).map(([pump, rows]) => {
      const mech = rows.reduce((t, r) => t + r.mechanicalLitres, 0);
      const withElec = rows.filter((r) => r.electronicLitres !== null);
      const elec = withElec.length ? withElec.reduce((t, r) => t + (r.electronicLitres ?? 0), 0) : null;
      return {
        pump,
        grade: rows[0]?.productCode ?? '',
        totalLitres: mech,
        electronicLitres: elec,
        drift: elec === null ? null : elec - mech,
      };
    });
  }, [divRows]);
  const [exporting, setExporting] = useState(false);
  const { showToast } = useToast();

  // Site managers are locked to their assigned site
  const effectiveSiteFilter = isSiteManager && assignedSite ? assignedSite : filterSite;

  const filteredDaily = dailyData.filter(d => {
    if (isSiteManager && assignedSite && d.site && d.site !== assignedSite) return false;   // W1
    if (!isSiteManager && filterSite !== 'all' && d.site !== filterSite) return false;
    if (d.date < dateFrom || d.date > dateTo) return false;
    return true;
  });

  const totals = filteredDaily.reduce((acc, d) => ({
    totalSales: acc.totalSales + d.totalSales,
    cashSales: acc.cashSales + d.cashSales,
    mobileMoney: acc.mobileMoney + d.mobileMoney,
    visa: acc.visa + d.visa,
    credit: acc.credit + d.credit,
    discounts: acc.discounts + d.discounts,
    expenses: acc.expenses + d.expenses,
    litresSold: acc.litresSold + d.litresSold,
    gainLoss: acc.gainLoss + d.gainLoss,
    short: acc.short + d.short,
  }), { totalSales: 0, cashSales: 0, mobileMoney: 0, visa: 0, credit: 0, discounts: 0, expenses: 0, litresSold: 0, gainLoss: 0, short: 0 });

  const handleExport = useCallback(() => {
    setExporting(true);
    setTimeout(() => {
      let headers: string[] = [];
      let rows: (string | number)[][] = [];
      switch (activeReport) {
        case 'daily': case 'weekly': case 'monthly':
          headers = ['Date', 'Site', 'Total Sales', 'Cash', 'Mobile Money', 'Visa', 'Credit', 'Discounts', 'Expenses', 'Litres', 'Gain/Loss (L)', 'Short'];
          rows = filteredDaily.map(d => [d.date, d.site, d.totalSales, d.cashSales, d.mobileMoney, d.visa, d.credit, d.discounts, d.expenses, d.litresSold, d.gainLoss, d.short]);
          break;
        case 'stock': case 'gainloss':
          headers = ['Grade', 'Opening Stock', 'Received', 'Sold', 'Closing Stock', 'Gain/Loss (L)', 'Gain/Loss Value (UGX)', 'Price/L'];
          rows = stockData.map(s => [s.grade, s.openingStock, s.received, s.sold, s.closingStock, s.gainLoss, s.gainLossValue, s.price]);
          break;
        case 'pump':
          headers = ['Pump / Nozzle', 'Grade', 'Mechanical (L)', 'Electronic (L)', 'Drift (L)'];
          rows = pumpData.map(p => [p.pump, p.grade, p.totalLitres, p.electronicLitres ?? '', p.drift ?? '']);
          break;
        default:
          headers = ['Date', 'Site', 'Total Sales'];
          rows = filteredDaily.map(d => [d.date, d.site, d.totalSales]);
      }
      const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeReport}-report-${localDate()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setExporting(false);
      showToast('Report exported successfully', 'success');
    }, 800);
  // stockData and pumpData became live data (they were fixed arrays); without
  // them here the export kept the empty lists from before the data loaded.
  }, [activeReport, filteredDaily, showToast, stockData, pumpData]);

  const currentReport = reportMenu.find(r => r.key === activeReport);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not load the daily summary
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-1 h-6 rounded-full"
              style={{ background: 'linear-gradient(180deg, var(--primary) 0%, #007A5C 100%)' }}
            />
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Reports & Statements</h1>
          </div>
          <p className="text-sm pl-3" style={{ color: 'var(--muted-foreground)' }}>
            Daily, weekly, monthly statements — stock, payments, expenses, gain/loss and more
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="btn-primary shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {exporting ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Exporting…
            </>
          ) : (
            <>
              <Icon name="ArrowDownTrayIcon" size={15} />
              Export CSV
            </>
          )}
        </button>
      </div>

      <div className="flex gap-5">
        {/* ── Left: Report Menu ── */}
        <div className="w-52 shrink-0 space-y-5">
          {groups.map(group => {
            const items = reportMenu.filter(r => r.group === group);
            const color = groupColors[group];
            return (
              <div key={group}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
                  <p
                    className="text-xs font-bold uppercase tracking-widest"
                    style={{ color: 'rgba(100,116,139,0.7)', letterSpacing: '0.12em' }}
                  >
                    {group}
                  </p>
                </div>
                <div className="space-y-0.5">
                  {items.map(item => {
                    const isActive = activeReport === item.key;
                    return (
                      <button
                        key={item.key}
                        onClick={() => setActiveReport(item.key)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-medium text-left transition-all duration-200"
                        style={
                          isActive
                            ? {
                                background: `linear-gradient(135deg, ${color}18 0%, ${color}0A 100%)`,
                                color,
                                border: `1px solid ${color}25`,
                                boxShadow: `0 2px 8px ${color}15`,
                              }
                            : {
                                color: 'var(--muted-foreground)',
                                border: '1px solid transparent',
                              }
                        }
                      >
                        <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={13} />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Right: Report Content ── */}
        <div className="flex-1 space-y-4 min-w-0">
          {/* Filters bar */}
          <div
            className="rounded-2xl p-4"
            style={{
              background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
              border: '1px solid rgba(255,255,255,0.06)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-bold text-foreground tracking-tight">{currentReport?.label}</h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{currentReport?.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isSiteManager && assignedSite ? (
                  <span className="px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
                    📍 {assignedSite}
                  </span>
                ) : (
                  <select
                    value={filterSite}
                    onChange={e => setFilterSite(e.target.value)}
                    className="input-field py-2 px-3 text-xs w-auto"
                    style={{ minWidth: 140 }}
                  >
                    <option value="all">All Sites</option>
                    {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={e => setDateFrom(e.target.value)}
                    className="input-field py-2 px-3 text-xs w-auto"
                  />
                  <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>→</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={e => setDateTo(e.target.value)}
                    className="input-field py-2 px-3 text-xs w-auto"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* KPI Summary Cards */}
          {(activeReport === 'daily' || activeReport === 'weekly' || activeReport === 'monthly') && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Total Sales', value: fmtUGX(totals.totalSales), color: '#00D4A0', icon: 'BanknotesIcon', sub: `${filteredDaily.length} records` },
                { label: 'Mobile Money', value: fmtUGX(totals.mobileMoney), color: '#F59E0B', icon: 'DevicePhoneMobileIcon', sub: `${fmt((totals.mobileMoney / (totals.totalSales || 1)) * 100, 1)}% of sales` },
                { label: 'Litres Sold', value: `${fmt(totals.litresSold)} L`, color: '#60A5FA', icon: 'BeakerIcon', sub: 'Total dispensed' },
                { label: 'Net Gain/Loss', value: `${totals.gainLoss >= 0 ? '+' : ''}${fmt(totals.gainLoss, 2)} L`, color: totals.gainLoss >= 0 ? '#00D4A0' : '#F43F5E', icon: 'ArrowTrendingUpIcon', sub: 'Stock variance' },
              ].map((c, idx) => (
                <div
                  key={c.label}
                  className={`relative overflow-hidden rounded-2xl p-4 fade-in stagger-${idx + 1}`}
                  style={{
                    background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
                    border: `1px solid ${c.color}20`,
                    boxShadow: `0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px ${c.color}10`,
                  }}
                >
                  <div className="absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-10 blur-xl" style={{ backgroundColor: c.color }} />
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}>{c.label}</span>
                    <div className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: `${c.color}15`, border: `1px solid ${c.color}25` }}>
                      <Icon name={c.icon as Parameters<typeof Icon>[0]['name']} size={13} style={{ color: c.color } as React.CSSProperties} />
                    </div>
                  </div>
                  <p className="text-base font-bold font-mono-nums text-foreground tracking-tight">{c.value}</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>{c.sub}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── Daily / Weekly / Monthly Table ── */}
          {(activeReport === 'daily' || activeReport === 'weekly' || activeReport === 'monthly') && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Date', 'Site', 'Total Sales', 'Cash', 'Mobile Money', 'Visa', 'Credit', 'Discounts', 'Expenses', 'Litres', 'Gain/Loss', 'Short'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredDaily.map((d) => (
                    <tr key={`${d.date}-${d.site}`}>
                      <td className="text-xs font-mono-nums whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>{d.date}</td>
                      <td className="text-xs font-semibold text-foreground">{d.site}</td>
                      <td className="font-mono-nums text-xs font-bold" style={{ color: '#00D4A0' }}>{fmtUGX(d.totalSales)}</td>
                      <td className="font-mono-nums text-xs text-foreground">{fmtUGX(d.cashSales)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#F59E0B' }}>{fmtUGX(d.mobileMoney)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#60A5FA' }}>{fmtUGX(d.visa)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#A78BFA' }}>{fmtUGX(d.credit)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#F59E0B' }}>-{fmtUGX(d.discounts)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#F43F5E' }}>-{fmtUGX(d.expenses)}</td>
                      <td className="font-mono-nums text-xs text-foreground">{fmt(d.litresSold)} L</td>
                      <td><GainLossBadge value={d.gainLoss} /></td>
                      <td>
                        {d.short > 0
                          ? <span className="text-xs font-bold font-mono-nums" style={{ color: '#F43F5E' }}>-{fmtUGX(d.short)}</span>
                          : <span className="text-xs" style={{ color: '#00D4A0' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} className="text-xs font-bold text-foreground">TOTALS ({filteredDaily.length} records)</td>
                    <td className="font-mono-nums text-sm font-bold" style={{ color: '#00D4A0' }}>{fmtUGX(totals.totalSales)}</td>
                    <td className="font-mono-nums text-xs font-bold text-foreground">{fmtUGX(totals.cashSales)}</td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#F59E0B' }}>{fmtUGX(totals.mobileMoney)}</td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#60A5FA' }}>{fmtUGX(totals.visa)}</td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#A78BFA' }}>{fmtUGX(totals.credit)}</td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#F59E0B' }}>-{fmtUGX(totals.discounts)}</td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#F43F5E' }}>-{fmtUGX(totals.expenses)}</td>
                    <td className="font-mono-nums text-xs font-bold text-foreground">{fmt(totals.litresSold)} L</td>
                    <td><GainLossBadge value={totals.gainLoss} /></td>
                    <td className="font-mono-nums text-xs font-bold" style={{ color: '#F43F5E' }}>{totals.short > 0 ? `-${fmtUGX(totals.short)}` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </TableWrapper>
          )}

          {/* ── Stock / Gain-Loss / Dipping ── */}
          {(activeReport === 'stock' || activeReport === 'gainloss' || activeReport === 'dipping') && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Grade', 'Opening Stock', 'Received', 'Sold', 'Closing Stock', 'Gain/Loss (L)', 'Gain/Loss Value', 'Price/L'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stockData.map((s) => (
                    <tr key={s.grade}>
                      <td className="text-xs font-semibold text-foreground">{s.grade}</td>
                      <td className="font-mono-nums text-xs text-foreground">{fmt(s.openingStock)} L</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#00D4A0' }}>{s.received > 0 ? `+${fmt(s.received)} L` : <span style={{ color: 'var(--muted-foreground)' }}>—</span>}</td>
                      <td className="font-mono-nums text-xs text-foreground">{fmt(s.sold)} L</td>
                      <td className="font-mono-nums text-xs text-foreground">{fmt(s.closingStock)} L</td>
                      <td><GainLossBadge value={s.gainLoss} /></td>
                      <td className="font-mono-nums text-xs font-semibold" style={{ color: s.gainLossValue >= 0 ? '#00D4A0' : '#F43F5E' }}>
                        {s.gainLossValue >= 0 ? '+' : ''}UGX {fmt(Math.abs(s.gainLossValue))}
                      </td>
                      <td className="font-mono-nums text-xs text-foreground">UGX {fmt(s.price)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="text-xs font-bold text-foreground">TOTALS</td>
                    <td className="font-mono-nums text-xs font-bold text-foreground">{fmt(stockData.reduce((s, d) => s + d.openingStock, 0))} L</td>
                    <td />
                    <td className="font-mono-nums text-xs font-bold text-foreground">{fmt(stockData.reduce((s, d) => s + d.sold, 0))} L</td>
                    <td className="font-mono-nums text-xs font-bold text-foreground">{fmt(stockData.reduce((s, d) => s + d.closingStock, 0))} L</td>
                    <td><GainLossBadge value={stockData.reduce((s, d) => s + d.gainLoss, 0)} /></td>
                    <td className="font-mono-nums text-sm font-bold" style={{ color: stockData.reduce((s, d) => s + d.gainLossValue, 0) >= 0 ? '#00D4A0' : '#F43F5E' }}>
                      {stockData.reduce((s, d) => s + d.gainLossValue, 0) >= 0 ? '+' : ''}UGX {fmt(Math.abs(stockData.reduce((s, d) => s + d.gainLossValue, 0)))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </TableWrapper>
          )}

          {/* ── Pump Performance ──
              Meter readings by nozzle. The mechanical head is the legal figure
              and what the attendant is billed on; the electronic one is the
              cross-check. No transactions, uptime or average sale: a
              manually-read forecourt does not record them, and this table used
              to invent all three. */}
          {activeReport === 'pump' && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Pump / Nozzle', 'Grade', 'Mechanical', 'Electronic', 'Drift'].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pumpData.map((p) => (
                    <tr key={p.pump}>
                      <td className="text-xs font-semibold text-foreground">{p.pump}</td>
                      <td className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{p.grade}</td>
                      <td className="font-mono-nums text-xs font-semibold" style={{ color: '#60A5FA' }}>{fmt(p.totalLitres)} L</td>
                      <td className="font-mono-nums text-xs text-foreground">
                        {p.electronicLitres === null ? '—' : `${fmt(p.electronicLitres)} L`}
                      </td>
                      <td className="font-mono-nums text-xs font-semibold"
                          style={{ color: p.drift !== null && Math.abs(p.drift) > 1 ? '#F43F5E' : 'var(--foreground)' }}>
                        {p.drift === null ? '—' : `${fmt(p.drift)} L`}
                      </td>
                    </tr>
                  ))}
                  {pumpData.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-xs text-center p-6" style={{ color: 'var(--muted-foreground)' }}>
                        No meter readings in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} className="text-xs font-bold text-foreground">TOTALS</td>
                    <td className="font-mono-nums text-sm font-bold" style={{ color: '#60A5FA' }}>
                      {fmt(pumpData.reduce((t, p) => t + p.totalLitres, 0))} L
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </TableWrapper>
          )}

          {/* ── Variances ── */}
          {activeReport === 'variances' && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Grade', 'Elec. Meter (L)', 'Dip Consumed (L)', 'Variance (L)', 'Variance %', 'Value Impact', 'Status'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stockData.map((s) => {
                    const variance = s.gainLoss;
                    const variancePct = s.sold > 0 ? (variance / s.sold) * 100 : 0;
                    const valueImpact = variance * s.price;
                    const status = Math.abs(variancePct) < 0.5 ? 'Normal' : Math.abs(variancePct) < 1 ? 'Watch' : 'Alert';
                    const statusColor = status === 'Normal' ? '#00D4A0' : status === 'Watch' ? '#F59E0B' : '#F43F5E';
                    return (
                      <tr key={s.grade}>
                        <td className="text-xs font-semibold text-foreground">{s.grade}</td>
                        <td className="font-mono-nums text-xs text-foreground">{fmt(s.sold)} L</td>
                        <td className="font-mono-nums text-xs text-foreground">{fmt(s.sold - variance, 1)} L</td>
                        <td><GainLossBadge value={variance} decimals={2} /></td>
                        <td className="font-mono-nums text-xs" style={{ color: Math.abs(variancePct) > 1 ? '#F43F5E' : 'var(--muted-foreground)' }}>
                          {fmt(variancePct, 2)}%
                        </td>
                        <td className="font-mono-nums text-xs font-semibold" style={{ color: valueImpact >= 0 ? '#00D4A0' : '#F43F5E' }}>
                          {valueImpact >= 0 ? '+' : ''}UGX {fmt(Math.abs(valueImpact))}
                        </td>
                        <td>
                          <span
                            className="text-xs px-2.5 py-1 rounded-full font-semibold"
                            style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}25` }}
                          >
                            {status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrapper>
          )}

          {/* ── Expenses ── */}
          {activeReport === 'expenses' && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Date', 'Site', 'Total Expenses', 'vs Sales %'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredDaily.map((d) => (
                    <tr key={`${d.date}-${d.site}`}>
                      <td className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{d.date}</td>
                      <td className="text-xs font-semibold text-foreground">{d.site}</td>
                      <td className="font-mono-nums text-xs font-semibold" style={{ color: '#F43F5E' }}>UGX {fmt(d.expenses)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: 'var(--muted-foreground)' }}>{fmt((d.expenses / d.totalSales) * 100, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrapper>
          )}

          {/* ── Credit ── */}
          {activeReport === 'credit' && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Date', 'Site', 'Credit Sales', '% of Total Sales'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredDaily.map((d) => (
                    <tr key={`${d.date}-${d.site}`}>
                      <td className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{d.date}</td>
                      <td className="text-xs font-semibold text-foreground">{d.site}</td>
                      <td className="font-mono-nums text-xs font-semibold" style={{ color: '#A78BFA' }}>UGX {fmt(d.credit)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: 'var(--muted-foreground)' }}>{fmt((d.credit / d.totalSales) * 100, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrapper>
          )}

          {/* ── Payments Breakdown ── */}
          {activeReport === 'payments' && (
            <TableWrapper>
              <table className="table-premium">
                <thead>
                  <tr>
                    {['Date', 'Site', 'Cash', 'Mobile Money', 'Visa/Card', 'Credit', 'Total'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredDaily.map((d) => (
                    <tr key={`${d.date}-${d.site}`}>
                      <td className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{d.date}</td>
                      <td className="text-xs font-semibold text-foreground">{d.site}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#00D4A0' }}>UGX {fmt(d.cashSales)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#F59E0B' }}>UGX {fmt(d.mobileMoney)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#60A5FA' }}>UGX {fmt(d.visa)}</td>
                      <td className="font-mono-nums text-xs" style={{ color: '#A78BFA' }}>UGX {fmt(d.credit)}</td>
                      <td className="font-mono-nums text-xs font-bold text-foreground">UGX {fmt(d.totalSales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrapper>
          )}

          {/* ── Shift redirect ── */}
          {activeReport === 'shift' && (
            <div
              className="rounded-2xl p-10 text-center"
              style={{
                background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
                style={{ background: 'rgba(0,212,160,0.1)', border: '1px solid rgba(0,212,160,0.2)' }}
              >
                <Icon name="ClipboardDocumentCheckIcon" size={28} className="text-primary" />
              </div>
              <h3 className="text-base font-bold text-foreground mb-2">Shift Closure Reports</h3>
              <p className="text-sm mb-6 max-w-sm mx-auto" style={{ color: 'var(--muted-foreground)' }}>
                Detailed per-shift statements are available in the dedicated Shift Reports section.
              </p>
              <a
                href="/shift-closure/reports"
                className="btn-primary inline-flex"
              >
                <Icon name="ArrowTopRightOnSquareIcon" size={14} />
                Open Shift Reports
              </a>
            </div>
          )}
        </div>
      </div>
      <PartialLoadNotice missing={partial} />
    </div>
  );
}
