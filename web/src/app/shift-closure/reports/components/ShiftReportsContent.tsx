'use client';
import { api } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import type { AttendantTenderRow, ShiftActivity, ShiftReportRow } from '@/types/api';
import { localDate } from '@/lib/dates';
import { shiftLabelName } from '@/lib/shiftLabel';
import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShiftRecord {
  id: string;
  date: string;
  shift: string;   // Day, Mid or Night (570)
  attendant: string;
  site: string;
  elecSales: number;
  dipConsumed: number;
  gainLoss: number;
  totalSales: number;
  cashSales: number;
  mobileMoney: number;
  visa: number;
  credit: number;
  discounts: number;
  short: number;
  status: 'closed' | 'pending' | 'flagged';
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

// Served by the statements registry: GET /api/statements/shift-log
//
// This screen's content is a statement the server already produces --
// same query, same columns, same totals, already validated against the
// schema. Wiring it here rather than adding a fifth endpoint that would
// drift from the statement showing the same figures.
/**
 * A closed shift, as this report shows it -- built from the shift's own
 * detail, not invented.
 *
 * This screen had NO data source at all: an empty array that nothing filled,
 * so "Shift Reports" in the sidebar has always been blank. It now reads the
 * last fortnight's shifts and each one's cash-ups and tank reconciliation.
 *
 * DERIVED, EXACTLY: dip-consumed is litres metered minus the tank variance,
 * because variance = dip - book and book = opening + received - metered.
 *
 * NOT SPLIT: the server records electronic tenders per attendant as one
 * figure. Mobile money carries all of it and card reads 0 -- splitting them
 * per shift would need the tender lines, which this report does not fetch.
 */
function toShiftRecord(r: ShiftReportRow): ShiftRecord {
  const state = r.state.toUpperCase();
  return {
    id: r.id,
    date: r.businessDate,
    shift: shiftLabelName(r.label),
    attendant: r.openedByName,
    site: '',
    elecSales: r.salesLitres,
    dipConsumed: r.salesLitres - r.varianceLitres,
    gainLoss: r.varianceLitres,
    totalSales: r.salesValue,
    cashSales: r.cashDeclared,
    mobileMoney: r.electronicDeclared,
    visa: 0,
    credit: r.creditTotal,
    discounts: r.discountTotal,
    short: r.shortageRaised,
    status: r.openExceptions > 0 ? 'flagged' : state === 'DECLARED' ? 'pending' : 'closed',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtUgx(n: number) { return 'UGX ' + fmt(n, 2); }
function fmtL(n: number) { return fmt(n, 1) + ' L'; }

const statusConfig = {
  closed: { label: 'Closed', color: '#22c55e', bg: 'rgba(34,197,94,0.1)', icon: 'CheckCircleIcon' },
  pending: { label: 'Pending', color: 'var(--primary)', bg: 'rgba(0,200,150,0.1)', icon: 'ClockIcon' },
  flagged: { label: 'Flagged', color: '#ef4444', bg: 'rgba(239,68,68,0.1)', icon: 'FlagIcon' },
} as const;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ShiftReportsContent() {
  const [shiftRecords, setShiftRecords] = useState<ShiftRecord[]>([]);
  const [loadingShifts, setLoadingShifts] = useState(true);
  const [shiftsError, setShiftsError] = useState<string | null>(null);
  // A shift, opened: what happened during it and who handed in what.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [activity, setActivity] = useState<ShiftActivity | null>(null);
  const [tenders, setTenders] = useState<AttendantTenderRow[]>([]);
  useEffect(() => {
    if (!detailFor) return;
    setActivity(null);
    setTenders([]);
    void Promise.all([
      api.get<ShiftActivity>(`/api/shifts/${detailFor}/activity`),
      api.get<AttendantTenderRow[]>(`/api/shifts/${detailFor}/tenders`),
    ]).then(([x, t]) => { setActivity(x); setTenders(t); }).catch(() => undefined);
  }, [detailFor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // ONE request. This fetched the list, then every shift's full detail
        // separately -- forty requests for a fortnight, each one a round trip
        // on a forecourt's connection.
        const rows = await api.get<ShiftReportRow[]>('/api/shifts/report?days=14');
        if (!cancelled) setShiftRecords(rows.map(toShiftRecord));
      } catch (e) {
        // Said, not swallowed: an empty report reads as "no shifts", which
        // is a different claim from "could not load them".
        if (!cancelled) setShiftsError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingShifts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [activeReport, setActiveReport] = useState<'summary' | 'gainloss' | 'sales' | 'variances' | 'statement'>('summary');
  const [selectedShift, setSelectedShift] = useState<string>('all');
  const [exporting, setExporting] = useState(false);
  const { showToast } = useToast();

  const filtered = selectedShift === 'all' ? shiftRecords : shiftRecords.filter((r) => r.shift.toLowerCase() === selectedShift);

  const totals = filtered.reduce((acc, r) => ({
    elecSales: acc.elecSales + r.elecSales,
    dipConsumed: acc.dipConsumed + r.dipConsumed,
    gainLoss: acc.gainLoss + r.gainLoss,
    totalSales: acc.totalSales + r.totalSales,
    cashSales: acc.cashSales + r.cashSales,
    mobileMoney: acc.mobileMoney + r.mobileMoney,
    visa: acc.visa + r.visa,
    credit: acc.credit + r.credit,
    discounts: acc.discounts + r.discounts,
    short: acc.short + r.short,
  }), { elecSales: 0, dipConsumed: 0, gainLoss: 0, totalSales: 0, cashSales: 0, mobileMoney: 0, visa: 0, credit: 0, discounts: 0, short: 0 });

  const handleExport = useCallback(() => {
    setExporting(true);
    setTimeout(() => {
      const headers = ['Date', 'Shift', 'Attendant', 'Site', 'Elec Sales (L)', 'Dip Consumed (L)', 'Gain/Loss (L)', 'Total Sales (UGX)', 'Cash (UGX)', 'Mobile Money (UGX)', 'Visa (UGX)', 'Credit (UGX)', 'Discounts (UGX)', 'Short (UGX)', 'Status'];
      const rows = filtered.map((r) => [r.date, r.shift, r.attendant, r.site, r.elecSales, r.dipConsumed, r.gainLoss, r.totalSales, r.cashSales, r.mobileMoney, r.visa, r.credit, r.discounts, r.short, r.status]);
      // Quoted cells: a location like "Kiboga town, Hoima Rd" shifted every
      // column after it when cells were joined with bare commas. (W7)
      downloadCsv(`shift-closure-report-${localDate()}.csv`, headers.map(String), rows);
      setExporting(false);
      showToast('Shift closure report exported successfully', 'success');
    }, 800);
  }, [filtered, showToast]);

  const reportTabs = [
    { key: 'summary', label: 'Shift Summary', icon: 'TableCellsIcon' },
    { key: 'gainloss', label: 'Gain / Loss', icon: 'ArrowTrendingUpIcon' },
    { key: 'sales', label: 'Sales & Payments', icon: 'CreditCardIcon' },
    { key: 'variances', label: 'Variances', icon: 'AdjustmentsHorizontalIcon' },
    { key: 'statement', label: 'Statement', icon: 'DocumentTextIcon' },
  ] as const;


  if (shiftsError) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load shifts</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{shiftsError}</p>
      </div>
    );
  }

  if (loadingShifts) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/shift-closure" className="text-sm hover:underline" style={{ color: 'var(--muted-foreground)' }}>Shift Closure</Link>
            <Icon name="ChevronRightIcon" size={14} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
            <span className="text-sm font-medium text-foreground">Reports</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Shift Closure Reports</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Full statements, gain/loss analysis, variances and payment breakdowns
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
        >
          {exporting ? (
            <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>Exporting…</>
          ) : (
            <><Icon name="ArrowDownTrayIcon" size={16} />Export CSV</>
          )}
        </button>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: 'Total Shifts', value: String(filtered.length), icon: 'ClipboardDocumentListIcon', color: 'var(--primary)' },
          { label: 'Total Sales', value: fmtUgx(totals.totalSales), icon: 'BanknotesIcon', color: '#22c55e' },
          { label: 'Net (after disc.)', value: fmtUgx(totals.totalSales - totals.discounts), icon: 'ReceiptPercentIcon', color: '#3b82f6' },
          { label: 'Cumul. Gain/Loss', value: fmtL(Math.abs(totals.gainLoss)), icon: totals.gainLoss >= 0 ? 'ArrowTrendingUpIcon' : 'ArrowTrendingDownIcon', color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444', suffix: totals.gainLoss >= 0 ? 'GAIN' : 'LOSS' },
          { label: 'Total Shorts', value: fmtUgx(totals.short), icon: 'ExclamationTriangleIcon', color: totals.short > 0 ? '#ef4444' : '#22c55e' },
        ].map((card) => (
          <div key={card.label} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${card.color}20` }}>
                <Icon name={card.icon as Parameters<typeof Icon>[0]['name']} size={14} style={{ color: card.color } as React.CSSProperties} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{card.label}</span>
            </div>
            <div className="flex items-end gap-1.5">
              <p className="text-lg font-bold font-mono-nums text-foreground">{card.value}</p>
              {card.suffix && <span className="text-xs font-bold mb-0.5" style={{ color: card.color }}>{card.suffix}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Filters + Tabs */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Labelled at every width; scrolls sideways on a phone. (D3) */}
        <div className="flex gap-1 p-1 rounded-xl overflow-x-auto max-w-full" style={{ backgroundColor: 'var(--muted)', border: '1px solid var(--border)' }}>
          {reportTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveReport(tab.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex-none"
              style={{
                backgroundColor: activeReport === tab.key ? 'var(--card)' : 'transparent',
                color: activeReport === tab.key ? 'var(--primary)' : 'var(--muted-foreground)',
                boxShadow: activeReport === tab.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <select
            value={selectedShift}
            onChange={(e) => setSelectedShift(e.target.value)}
            className="input-field py-1.5 px-3 text-xs appearance-none cursor-pointer pr-7"
          >
            <option value="all">All Shifts</option>
            <option value="day">Day</option>
            <option value="mid">Mid</option>
            <option value="night">Night</option>
          </select>
          <Icon name="ChevronDownIcon" size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
        </div>
      </div>

      {/* Report: Shift Summary */}
      {activeReport === 'summary' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  {['Status', 'Date', 'Shift', 'Attendant', 'Elec Sales', 'Dip Consumed', 'Gain/Loss', 'Total Sales', 'Short'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const sc = statusConfig[r.status] ?? { ...Object.values(statusConfig)[0], label: String(r.status) };   // unknown value: neutral, not a crash
                  return (
                    <tr key={r.id} onClick={() => setDetailFor(r.id)} title="Open this shift" style={{ cursor: 'pointer', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: sc.bg, color: sc.color }}>
                          <Icon name={sc.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                          {sc.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{r.date}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--muted)', color: 'var(--foreground)' }}>{r.shift}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.attendant}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtL(r.elecSales)}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtL(r.dipConsumed)}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: r.gainLoss >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: r.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                          {r.gainLoss >= 0 ? '+' : ''}{fmt(r.gainLoss, 1)} L
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono-nums text-xs font-semibold text-foreground">{fmtUgx(r.totalSales)}</td>
                      <td className="px-4 py-3">
                        {r.short > 0 ? (
                          <span className="text-xs font-bold font-mono-nums" style={{ color: '#ef4444' }}>-{fmtUgx(r.short)}</span>
                        ) : (
                          <span className="text-xs" style={{ color: '#22c55e' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td colSpan={4} className="px-4 py-3 text-xs font-bold text-foreground">TOTALS ({filtered.length} shifts)</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold" style={{ color: 'var(--primary)' }}>{fmtL(totals.elecSales)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold" style={{ color: 'var(--primary)' }}>{fmtL(totals.dipConsumed)}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: totals.gainLoss >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                      {totals.gainLoss >= 0 ? '+' : ''}{fmt(totals.gainLoss, 1)} L
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: '#22c55e' }}>{fmtUgx(totals.totalSales)}</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: '#ef4444' }}>{totals.short > 0 ? `-${fmtUgx(totals.short)}` : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Report: Gain/Loss */}
      {activeReport === 'gainloss' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
              <Icon name="ArrowTrendingUpIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
              <h3 className="text-sm font-semibold text-foreground">Daily Gain / Loss per Shift</h3>
            </div>
            <div className="p-5 space-y-3">
              {filtered.map((r) => (
                <div key={r.id} className="flex items-center gap-3">
                  <div className="w-24 shrink-0">
                    <p className="text-xs font-medium text-foreground">{r.shift}</p>
                    <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{r.date}</p>
                  </div>
                  <div className="flex-1 h-2 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${Math.min(Math.abs(r.gainLoss) / 5 * 100, 100)}%`,
                        backgroundColor: r.gainLoss >= 0 ? '#22c55e' : '#ef4444',
                      }}
                    />
                  </div>
                  <span className="text-xs font-bold font-mono-nums w-16 text-right" style={{ color: r.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                    {r.gainLoss >= 0 ? '+' : ''}{fmt(r.gainLoss, 1)} L
                  </span>
                </div>
              ))}
              <div className="pt-3 border-t flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                <span className="text-xs font-bold text-foreground">Cumulative</span>
                <span className="text-sm font-bold font-mono-nums" style={{ color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                  {totals.gainLoss >= 0 ? '+' : ''}{fmt(totals.gainLoss, 1)} L
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
              <Icon name="ChartBarIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
              <h3 className="text-sm font-semibold text-foreground">Gain/Loss Financial Impact</h3>
            </div>
            <div className="p-5 space-y-4">
              {[
                { label: 'Total Gain (L)', value: filtered.filter((r) => r.gainLoss > 0).reduce((s, r) => s + r.gainLoss, 0), unit: 'L', color: '#22c55e' },
                { label: 'Total Loss (L)', value: Math.abs(filtered.filter((r) => r.gainLoss < 0).reduce((s, r) => s + r.gainLoss, 0)), unit: 'L', color: '#ef4444' },
                { label: 'Net Gain/Loss (L)', value: totals.gainLoss, unit: 'L', color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' },
                { label: 'Net Value @ UGX 1.589/L', value: totals.gainLoss * 1.589, unit: 'UGX ', color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between p-3 rounded-lg" style={{ backgroundColor: 'var(--muted)' }}>
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  <span className="text-sm font-bold font-mono-nums" style={{ color: item.color }}>
                    {item.unit === 'UGX ' ? fmtUgx(item.value) : `${item.value >= 0 ? '+' : ''}${fmt(item.value, 1)} L`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Report: Sales & Payments */}
      {activeReport === 'sales' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
            <Icon name="CreditCardIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
            <h3 className="text-sm font-semibold text-foreground">Sales & Payment Breakdown by Shift</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  {['Date', 'Shift', 'Total Sales', 'Cash', 'Mobile Money', 'Visa/Card', 'Credit', 'Discounts', 'Net Sales'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id} onClick={() => setDetailFor(r.id)} title="Open this shift" style={{ cursor: 'pointer', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{r.date}</td>
                    <td className="px-4 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--muted)', color: 'var(--foreground)' }}>{r.shift}</span></td>
                    <td className="px-4 py-3 font-mono-nums text-xs font-semibold text-foreground">{fmtUgx(r.totalSales)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtUgx(r.cashSales)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtUgx(r.mobileMoney)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtUgx(r.visa)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmtUgx(r.credit)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs" style={{ color: '#ef4444' }}>-{fmtUgx(r.discounts)}</td>
                    <td className="px-4 py-3 font-mono-nums text-xs font-bold" style={{ color: '#22c55e' }}>{fmtUgx(r.totalSales - r.discounts)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td colSpan={2} className="px-4 py-3 text-xs font-bold text-foreground">TOTALS</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold text-foreground">{fmtUgx(totals.totalSales)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold text-foreground">{fmtUgx(totals.cashSales)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold text-foreground">{fmtUgx(totals.mobileMoney)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold text-foreground">{fmtUgx(totals.visa)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold text-foreground">{fmtUgx(totals.credit)}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-bold" style={{ color: '#ef4444' }}>-{fmtUgx(totals.discounts)}</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: '#22c55e' }}>{fmtUgx(totals.totalSales - totals.discounts)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Report: Variances */}
      {activeReport === 'variances' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[
              { label: 'Meter vs Dip Variance', value: totals.gainLoss, unit: 'L', desc: 'Electronic meter sales vs tank dip consumed', icon: 'BeakerIcon' },
              { label: 'Total Cash Shorts', value: -totals.short, unit: 'UGX ', desc: 'Expected vs actual cash collected', icon: 'ExclamationTriangleIcon' },
              { label: 'Discount Variance', value: totals.discounts, unit: 'UGX ', desc: 'Total discounts applied this period', icon: 'TagIcon' },
            ].map((v) => (
              <div key={v.label} className="rounded-xl border p-5" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon name={v.icon as Parameters<typeof Icon>[0]['name']} size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                  <p className="text-xs font-semibold text-foreground">{v.label}</p>
                </div>
                <p className="text-2xl font-bold font-mono-nums" style={{ color: v.value >= 0 ? '#22c55e' : '#ef4444' }}>
                  {v.value >= 0 ? '+' : ''}{v.unit === 'UGX ' ? fmtUgx(v.value) : fmt(v.value, 1) + ' L'}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>{v.desc}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
              <Icon name="AdjustmentsHorizontalIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
              <h3 className="text-sm font-semibold text-foreground">Variance Detail per Shift</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                    {['Date', 'Shift', 'Attendant', 'Meter/Dip Var (L)', 'Cash Short (UGX)', 'Discounts (UGX)', 'Status'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => {
                    const sc = statusConfig[r.status] ?? { ...Object.values(statusConfig)[0], label: String(r.status) };   // unknown value: neutral, not a crash
                    return (
                      <tr key={r.id} onClick={() => setDetailFor(r.id)} title="Open this shift" style={{ cursor: 'pointer', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{r.date}</td>
                        <td className="px-4 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--muted)', color: 'var(--foreground)' }}>{r.shift}</span></td>
                        <td className="px-4 py-3 text-xs text-foreground">{r.attendant}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: r.gainLoss >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: r.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                            {r.gainLoss >= 0 ? '+' : ''}{fmt(r.gainLoss, 1)} L
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono-nums text-xs" style={{ color: r.short > 0 ? '#ef4444' : '#22c55e' }}>
                          {r.short > 0 ? `-${fmtUgx(r.short)}` : '—'}
                        </td>
                        <td className="px-4 py-3 font-mono-nums text-xs" style={{ color: '#ef4444' }}>-{fmtUgx(r.discounts)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: sc.bg, color: sc.color }}>
                            <Icon name={sc.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                            {sc.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Report: Statement */}
      {activeReport === 'statement' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2">
              <Icon name="DocumentTextIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
              <h3 className="text-sm font-semibold text-foreground">Shift Closure Statement</h3>
            </div>
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{filtered.length} shift(s)</span>
          </div>
          <div className="p-6 space-y-6 max-w-2xl">
            {/* Sales Summary */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--muted-foreground)' }}>Sales Summary</p>
              <div className="space-y-2">
                {[
                  { label: 'Gross Sales', value: totals.totalSales, bold: false },
                  { label: 'Less: Discounts', value: -totals.discounts, bold: false, color: '#ef4444' },
                  { label: 'Net Sales', value: totals.totalSales - totals.discounts, bold: true },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px dashed var(--border)' }}>
                    <span className={`text-sm ${row.bold ? 'font-bold' : ''} text-foreground`}>{row.label}</span>
                    <span className={`text-sm font-mono-nums ${row.bold ? 'font-bold' : ''}`} style={{ color: row.color ?? 'var(--foreground)' }}>
                      {row.value < 0 ? `-${fmtUgx(Math.abs(row.value))}` : fmtUgx(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Payment Reconciliation */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--muted-foreground)' }}>Payment Reconciliation</p>
              <div className="space-y-2">
                {[
                  { label: 'Physical Cash', value: totals.cashSales },
                  { label: 'Mobile Money', value: totals.mobileMoney },
                  { label: 'Visa / Card', value: totals.visa },
                  { label: 'Credit Accounts', value: totals.credit },
                  { label: 'Total Collected', value: totals.cashSales + totals.mobileMoney + totals.visa + totals.credit, bold: true },
                  { label: 'Less: Cash Shorts', value: -totals.short, color: '#ef4444' },
                  { label: 'Net Collected', value: totals.cashSales + totals.mobileMoney + totals.visa + totals.credit - totals.short, bold: true, color: '#22c55e' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px dashed var(--border)' }}>
                    <span className={`text-sm ${row.bold ? 'font-bold' : ''} text-foreground`}>{row.label}</span>
                    <span className={`text-sm font-mono-nums ${row.bold ? 'font-bold' : ''}`} style={{ color: row.color ?? 'var(--foreground)' }}>
                      {row.value < 0 ? `-${fmtUgx(Math.abs(row.value))}` : fmtUgx(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Fuel Reconciliation */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--muted-foreground)' }}>Fuel Reconciliation</p>
              <div className="space-y-2">
                {[
                  { label: 'Electronic Meter Sales', value: totals.elecSales, unit: 'L' },
                  { label: 'Dip Consumed', value: totals.dipConsumed, unit: 'L' },
                  { label: 'Net Gain / Loss', value: totals.gainLoss, unit: 'L', bold: true, color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' },
                  { label: 'Financial Impact @ UGX 1.589/L', value: totals.gainLoss * 1.589, unit: 'UGX ', color: totals.gainLoss >= 0 ? '#22c55e' : '#ef4444' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px dashed var(--border)' }}>
                    <span className={`text-sm ${row.bold ? 'font-bold' : ''} text-foreground`}>{row.label}</span>
                    <span className={`text-sm font-mono-nums ${row.bold ? 'font-bold' : ''}`} style={{ color: row.color ?? 'var(--foreground)' }}>
                      {row.unit === 'UGX '
                        ? (row.value >= 0 ? '+' : '') + fmtUgx(row.value)
                        : (row.value >= 0 ? '+' : '') + fmt(row.value, 1) + ' L'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Generated: {new Date().toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' })} · Forecourt Management System
              </p>
            </div>
          </div>
        </div>
      )}
      {detailFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}
             onClick={() => setDetailFor(null)}>
          <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border p-5 space-y-4"
               style={{ background: 'var(--card)', borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-foreground">The shift, opened</h2>
            {!activity && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Loading...</p>}
            {activity && (
              <>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {activity.pumpTests} pump test(s), {activity.pumpTestLitres.toLocaleString()} L ·
                  {' '}{activity.ownUseDraws} own-use draw(s), {activity.ownUseLitres.toLocaleString()} L ·
                  {' '}{activity.creditSales} credit sale(s), UGX {activity.creditValue.toLocaleString()} ·
                  {' '}{activity.drySales} shop sale(s), UGX {activity.dryValue.toLocaleString()} ·
                  {' '}{activity.handovers} handover(s)
                </p>
                <div className="space-y-1">
                  {activity.items.map((it, i) => (
                    <p key={i} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span className="text-foreground">{new Date(it.at).toLocaleTimeString()}</span> · {it.kind.toLowerCase().replace(/_/g, ' ')}
                      {' '}· {it.description}{it.litres !== null ? ` · ${it.litres.toLocaleString()} L` : ''}
                      {it.amount !== null ? ` · UGX ${it.amount.toLocaleString()}` : ''} · {it.recordedBy}
                    </p>
                  ))}
                </div>
              </>
            )}
            {tenders.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: 'var(--muted-foreground)' }}>
                    {['Attendant', 'How', 'Channel', 'Till', 'Amount', 'Reference'].map((h) => <th key={h} className="text-left p-2">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {tenders.map((t, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="p-2">{t.attendantName}</td>
                      <td className="p-2">{t.settlement.toLowerCase().replace('_', ' ')}</td>
                      <td className="p-2">{t.channelName ?? ''}</td>
                      <td className="p-2">{t.tillNumber ?? ''}</td>
                      <td className="p-2">{t.amount.toLocaleString()}</td>
                      <td className="p-2">{t.reference ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button onClick={() => setDetailFor(null)} className="px-3 py-2 rounded-xl text-sm"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
