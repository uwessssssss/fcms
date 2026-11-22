'use client';
import { api, ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import type { DashboardOverview, SiteOverviewRow } from '@/types/api';
import { localDate } from '@/lib/dates';
import React, { useState, useCallback, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import StatusBadge from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';

// Backend: GET /api/v1/reports/performance?period=daily|weekly&siteId=all|:id
// Backend: POST /api/v1/reports/export — returns CSV blob

type Period = 'daily' | 'weekly';

interface FuelGradeMix {
  unleaded: number;
  superUnleaded: number;
  diesel: number;
  premiumDiesel: number;
}

interface SiteReport {
  id: string;
  name: string;
  location: string;
  status: 'active' | 'fault' | 'offline';
  revenue: number;
  revenueTarget: number;
  revenueVsTarget: number;
  transactions: number;
  avgTransaction: number;
  litresDispensed: number;
  pumpUptime: number; // percentage
  pumpsTotal: number;
  pumpsFault: number;
  // Not reported by the server yet; null rather than an invented split (it
  // was read unconditionally and crashed this screen for every site).
  fuelGradeMix: FuelGradeMix | null;
}

/**
 * Per-SITE performance, from GET /api/v1/dashboard/overview
 *
 * This screen compares sites, not days -- so it shares the dashboard's
 * endpoint rather than the daily statement. Two things it asks for that a
 * manual station cannot produce are left at zero rather than invented:
 * transaction count and pump uptime both need a controller polling the pumps.
 */
function toSiteReport(r: SiteOverviewRow): SiteReport {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    status: r.criticalAlerts > 0 ? 'fault' : r.nozzlesActive > 0 ? 'active' : 'offline',
    revenue: r.todayRevenue,
    revenueTarget: r.revenueTarget ?? 0,
    revenueVsTarget:
      r.revenueTarget && r.revenueTarget > 0
        ? Math.round((r.todayRevenue / r.revenueTarget) * 100)
        : 0,
    transactions: 0,
    avgTransaction: r.avgTransaction ?? 0,
    litresDispensed: r.litresDispensed,
    pumpUptime: 0,
    pumpsTotal: r.nozzlesActive + r.nozzlesIdle,
    pumpsFault: 0,
    fuelGradeMix: null,
  };
}

// A weekly view was fabricated here: today's figures multiplied by seven, with
// a random factor between 0.9 and 1.2 sprinkled on the revenue so the numbers
// looked convincingly uneven.
//
// That is worse than showing nothing. A director comparing sites would have
// been reading dice, and the figures would have changed on every refresh while
// looking entirely plausible.
//
// The period selector below now asks the server for the real range.

function fmt(n: number) {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(n);
}

function fmtGbp(n: number) {
  return 'UGX ' + fmt(n);
}


export default function ReportsContent() {
  const [dailyData, setDailyData] = useState<SiteReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<DashboardOverview>('/api/v1/dashboard/overview')
      .then((d) => {
        if (!cancelled) {
          setDailyData(d.sites.map(toSiteReport));
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as ApiError).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [period, setPeriod] = useState<Period>('daily');
  const [selectedSite, setSelectedSite] = useState<string>('all');
  const [exporting, setExporting] = useState(false);
  const { showToast } = useToast();

  const data = period === 'daily' ? dailyData : dailyData;
  const filtered = selectedSite === 'all' ? data : data.filter((s) => s.id === selectedSite);

  const totals = filtered.reduce(
    (acc, s) => ({
      revenue: acc.revenue + s.revenue,
      transactions: acc.transactions + s.transactions,
      litres: acc.litres + s.litresDispensed,
      avgUptime: acc.avgUptime + s.pumpUptime / filtered.length,
    }),
    { revenue: 0, transactions: 0, litres: 0, avgUptime: 0 }
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    setTimeout(() => {
      const headers = [
        'Site', 'Location', 'Status', 'Revenue (UGX)', 'Target (UGX)', 'vs Target (%)', 'Litres Dispensed',
      ];
      const rows = filtered.map((s) => [
        s.name, s.location, s.status,
        s.revenue.toFixed(2), s.revenueTarget > 0 ? s.revenueTarget.toFixed(2) : '', s.revenueTarget > 0 ? s.revenueVsTarget.toFixed(1) : '',
        s.litresDispensed,
      ]);
      const label = period === 'daily' ? 'daily' : 'weekly';
      const dateStr = localDate();   // a file is named by the calendar
      // Quoted cells: a location like "Kiboga town, Hoima Rd" shifted every
      // column after it when cells were joined with bare commas. (W7)
      downloadCsv(`forecourt-${label}-report-${dateStr}.csv`, headers.map(String), rows);
      setExporting(false);
      showToast(`${label.charAt(0).toUpperCase() + label.slice(1)} report exported successfully`, 'success');
    }, 800);
  }, [filtered, period, showToast]);

  const periodLabel = period === 'daily' ? 'Today' : 'This Week';

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
          Could not load site performance
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--foreground)' }}>
            Performance Reports
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            Export {period} summaries by site — revenue, pump uptime, transactions &amp; fuel grade mix
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
              <Icon name="ArrowDownTrayIcon" size={16} />
              Export CSV
            </>
          )}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Period toggle */}
        <div
          className="flex items-center rounded-lg p-1 gap-1"
          style={{ backgroundColor: 'var(--muted)', border: '1px solid var(--border)' }}
        >
          {(['daily', 'weekly'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${
                period === p ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              style={period === p ? { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' } : {}}
            >
              {p === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>

        {/* Site filter */}
        <div className="relative">
          <Icon
            name="BuildingStorefrontIcon"
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--muted-foreground)' } as React.CSSProperties}
          />
          <select
            value={selectedSite}
            onChange={(e) => setSelectedSite(e.target.value)}
            className="input-field pl-8 pr-8 py-2 text-sm appearance-none cursor-pointer"
            style={{ minWidth: 180 }}
          >
            <option value="all">All Sites ({dailyData.length})</option>
            {dailyData.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <Icon
            name="ChevronDownIcon"
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--muted-foreground)' } as React.CSSProperties}
          />
        </div>

        <span className="text-xs ml-auto" style={{ color: 'var(--muted-foreground)' }}>
          {filtered.length} site{filtered.length !== 1 ? 's' : ''} · {periodLabel}
        </span>
      </div>

      {/* Summary strip */}
      {/* Transactions and pump uptime are not measured -- they need a pump
          controller this system does not have -- so they are not shown as 0. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[
          { label: 'Total Revenue', value: fmtGbp(totals.revenue), icon: 'BanknotesIcon', color: 'var(--primary)' },
          { label: 'Litres Dispensed', value: fmt(totals.litres) + ' L', icon: 'BeakerIcon', color: 'var(--accent)' },
        ].map((m) => (
          <div key={m.label} className="card p-4 flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${m.color}18` }}
            >
              <Icon name={m.icon as Parameters<typeof Icon>[0]['name']} size={18} style={{ color: m.color } as React.CSSProperties} />
            </div>
            <div className="min-w-0">
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{m.label}</p>
              <p className="text-base font-semibold font-mono-nums" style={{ color: 'var(--foreground)' }}>{m.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Main table */}
      <div className="card overflow-hidden">
        <div
          className="px-5 py-3.5 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Site Breakdown — {periodLabel}
          </h2>
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {filtered.length} record{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {[
                  'Site', 'Status', 'Revenue', 'vs Target', 'Litres',
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider whitespace-nowrap"
                    style={{ color: 'var(--muted-foreground)', backgroundColor: 'var(--muted)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((site, idx) => {
                const vsTargetPositive = site.revenueVsTarget >= 0;
                return (
                  <tr
                    key={site.id}
                    className="transition-colors duration-100 hover:bg-muted/40"
                    style={{
                      borderBottom: idx < filtered.length - 1 ? '1px solid var(--border)' : undefined,
                    }}
                  >
                    {/* Site */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <p className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>{site.name}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{site.location}</p>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <StatusBadge status={site.status} />
                    </td>

                    {/* Revenue */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <p className="font-semibold font-mono-nums" style={{ color: 'var(--foreground)' }}>
                        {fmtGbp(site.revenue)}
                      </p>
                      {site.revenueTarget > 0 && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                          of {fmtGbp(site.revenueTarget)}
                        </p>
                      )}
                    </td>

                    {/* vs Target: only against a target that exists */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {site.revenueTarget <= 0 ? <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No target</span> : <span
                        className="inline-flex items-center gap-1 text-xs font-semibold font-mono-nums px-2 py-1 rounded-md"
                        style={{
                          backgroundColor: vsTargetPositive ? 'rgba(0,200,150,0.12)' : 'rgba(239,68,68,0.12)',
                          color: vsTargetPositive ? 'var(--status-active)' : 'var(--status-offline)',
                        }}
                      >
                        <Icon
                          name={vsTargetPositive ? 'ArrowTrendingUpIcon' : 'ArrowTrendingDownIcon'}
                          size={12}
                        />
                        {vsTargetPositive ? '+' : ''}{site.revenueVsTarget.toFixed(1)}%
                      </span>}
                    </td>

                    {/* Litres */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <p className="font-mono-nums" style={{ color: 'var(--foreground)' }}>
                        {fmt(site.litresDispensed)} L
                      </p>
                    </td>

                  </tr>
                );
              })}
            </tbody>

            {/* Totals footer */}
            {filtered.length > 1 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }} colSpan={2}>
                    Network Total
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold font-mono-nums text-sm" style={{ color: 'var(--primary)' }}>
                      {fmtGbp(totals.revenue)}
                    </p>
                  </td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3">
                    <p className="font-mono-nums text-sm" style={{ color: 'var(--foreground)' }}>
                      {fmt(totals.litres)} L
                    </p>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Export note */}
      <p className="text-xs text-center pb-2" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="InformationCircleIcon" size={12} className="inline mr-1 -mt-0.5" />
        CSV export includes all columns shown above. Filtered by selected site and period.
      </p>
    </div>
  );
}
