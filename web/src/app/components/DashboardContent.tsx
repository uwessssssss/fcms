'use client';
import { api, ApiError } from '@/lib/api';
import type { AlertRow, DashboardOverview, SiteOverviewRow } from '@/types/api';
import { downloadCsv } from '@/lib/csv';
import { localDate } from '@/lib/dates';
import React, { useState, useEffect } from 'react';
import MetricCard from '@/components/ui/MetricCard';
import StatusBadge from '@/components/ui/StatusBadge';
import TankFillBar from '@/components/ui/TankFillBar';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import dynamic from 'next/dynamic';

const RevenueAreaChart = dynamic(() => import('./RevenueAreaChart'), { ssr: false });
const FuelGradeBarChart = dynamic(() => import('./FuelGradeBarChart'), { ssr: false });

// --- Mock Data ---
// Backend: GET /api/v1/dashboard/overview — returns aggregated cross-site metrics

interface Site {
  id: string;
  name: string;
  location: string;
  manager: string;
  status: 'active' | 'fault' | 'offline';
  pumps: { active: number; idle: number; fault: number; offline: number; total: number };
  lowestTankPct: number;
  lowestTankGrade: string;
  todayRevenue: number;
  revenueTarget: number;
  litresDispensed: number;
  alertCount: number;
  avgTransaction: number;
}

/**
 * The sites, from the server.
 *
 * Replaces a hardcoded array of five English forecourts. The mapping is not
 * one to one, and the gaps are deliberate rather than filled in with something
 * plausible:
 *
 *   STATUS. The mock had active/fault/offline from a live pump controller.
 *   This station reads meters by hand, so a site is `active` when somebody is
 *   working a nozzle, `fault` when it has unresolved criticals, and `offline`
 *   when neither -- which is honest about what the data can say.
 *
 *   AVERAGE TRANSACTION arrives null, because a shift total cannot be divided
 *   into transactions that were never recorded separately. The card shows a
 *   dash.
 */
function toSite(r: SiteOverviewRow): Site {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    manager: r.manager,
    status:
      r.criticalAlerts > 0 ? 'fault' : r.nozzlesActive > 0 ? 'active' : 'offline',
    pumps: {
      active: r.nozzlesActive,
      idle: r.nozzlesIdle,
      fault: 0,
      offline: 0,
      total: r.nozzlesActive + r.nozzlesIdle,
    },
    lowestTankPct: r.lowestTankPct ?? 0,
    lowestTankGrade: r.lowestTankGrade ?? '',
    todayRevenue: r.todayRevenue,
    revenueTarget: r.revenueTarget ?? 0,
    litresDispensed: r.litresDispensed,
    alertCount: r.alertCount,
    avgTransaction: r.avgTransaction ?? 0,
  };
}

interface AlertItem {
  id: string;
  siteId: string;
  siteName: string;
  type: 'fault' | 'critical' | 'warning' | 'info';
  message: string;
  time: string;
  acknowledged: boolean;
}

/** Unresolved exceptions, from GET /api/v1/dashboard/alerts. */
function toAlert(r: AlertRow): AlertItem {
  return {
    id: r.id,
    siteId: r.siteId,
    siteName: r.siteName,
    type: r.type as AlertItem['type'],
    message: r.message,
    time: new Date(r.raisedAt).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
    acknowledged: r.acknowledged,
  };
}

const alertTypeConfig = {
  critical: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)', dot: 'var(--status-offline)', textColor: 'var(--status-offline)' },
  fault:    { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', dot: 'var(--status-fault)',   textColor: 'var(--status-fault)' },
  warning:  { bg: 'rgba(234,179,8,0.06)',  border: 'rgba(234,179,8,0.25)',  dot: '#EAB308',              textColor: '#EAB308' },
  info:     { bg: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.2)', dot: 'var(--tank-replenishing)', textColor: 'var(--tank-replenishing)' },
};

function formatCurrency(v: number) {
  // Shillings. This formatted every dashboard figure as pounds sterling, in the
  // en-GB locale, inherited from the template -- on a business in Uganda.
  return `UGX ${v.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatLitres(v: number) {
  return `${(v / 1000).toFixed(1)}k L`;
}

export default function DashboardContent() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  // The sites, live.
  const [sites, setSites] = useState<Site[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api
      .get<AlertRow[]>('/api/v1/dashboard/alerts')
      .then((rows) => {
        if (!cancelled) setAlerts(rows.map(toAlert));
      })
      .catch(() => {
        // The alert strip is secondary; a failure here must not blank the
        // figures the dashboard is actually for.
      });

    void api
      .get<DashboardOverview>('/api/v1/dashboard/overview')
      .then((d) => {
        if (cancelled) return;
        setSites(d.sites.map(toSite));
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        // Say what happened. A dashboard that silently shows zeros is worse
        // than one that says it could not reach the server -- zeros look like
        // a quiet day.
        setLoadError((e as ApiError).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingSites(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);
  const [selectedPeriod, setSelectedPeriod] = useState<'day' | 'week' | 'month'>('day');
  const { showToast } = useToast();
  const { isSiteManager } = useAuth();
  const router = useRouter();

  // Site managers should not see the head-office dashboard — redirect them
  React.useEffect(() => {
    if (isSiteManager) {
      router.replace('/site-operations-detail');
    }
  }, [isSiteManager, router]);

  if (isSiteManager) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>Redirecting to your site…</p>
        </div>
      </div>
    );
  }

  if (loadingSites) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Reading the station&rsquo;s figures&hellip;
          </p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not reach the server
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          {loadError}
        </p>
      </div>
    );
  }

  const totalRevenue = sites.reduce((s, x) => s + x.todayRevenue, 0);
  const totalTarget = sites.reduce((s, x) => s + x.revenueTarget, 0);
  const totalLitres = sites.reduce((s, x) => s + x.litresDispensed, 0);
  const totalPumps = sites.reduce((s, x) => s + x.pumps.total, 0);
  const activePumps = sites.reduce((s, x) => s + x.pumps.active, 0);
  const pumpPct = totalPumps ? Math.round((activePumps / totalPumps) * 100) : 0;   // no pumps yet: 0, not NaN
  const criticalTanks = sites.filter((s) => s.lowestTankPct <= 15).length;
  const lowTanks = sites.filter((s) => s.lowestTankPct <= 30).length;
  const openAlerts = alerts.filter((a) => !a.acknowledged).length;
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  // Alerts are resolved where the facts are -- this takes you there, rather than
  // a button labelled Acknowledge that only explained why it would not.
  const acknowledgeAlert = (_id: string) => {
    router.push('/shift-operations');
  };

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    showToast('Alert dismissed', 'info');
  };

  const periods: { key: 'day' | 'week' | 'month'; label: string }[] = [
    { key: 'day', label: 'Today' },
    { key: 'week', label: '7 Days' },
    { key: 'month', label: '30 Days' },
  ];

  return (
    <div className="space-y-6 fade-in">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">All Sites Overview</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            5 locations · Tuesday 15 September 2026
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1 rounded-lg p-1"
            style={{ backgroundColor: 'var(--muted)' }}
          >
            {periods.map((p) => (
              <button
                key={`period-${p.key}`}
                onClick={() => setSelectedPeriod(p.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
                  selectedPeriod === p.key
                    ? 'text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                style={
                  selectedPeriod === p.key
                    ? { backgroundColor: 'var(--card)' }
                    : {}
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <button className="btn-primary text-sm" onClick={() => downloadCsv(`sites-${localDate()}.csv`,
              ['Site', 'Location', 'Manager', 'Status', 'Revenue today', 'Litres today', 'Lowest tank %', 'Lowest tank grade', 'Open alerts'],
              sites.map((x) => [x.name, x.location, x.manager, x.status, x.todayRevenue, x.litresDispensed, x.lowestTankPct, x.lowestTankGrade, x.alertCount]))}>
            <Icon name="ArrowDownTrayIcon" size={16} />
            Export
          </button>
        </div>
      </div>

      {/* Hero KPI Grid — 4 cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-4">
        <MetricCard
          featured
          label="Total Revenue Today"
          value={formatCurrency(totalRevenue)}
          subtext={totalTarget > 0 ? `Target: ${formatCurrency(totalTarget)} · ${Math.round((totalRevenue / totalTarget) * 100)}% achieved` : 'No revenue target set'}
          trend={{ value: '+8.4% vs yesterday', direction: 'up', positive: true }}
          icon="CurrencyPoundIcon"
        />
        <MetricCard
          label="Pump Availability"
          value={`${pumpPct}%`}
          subtext={`${activePumps} active of ${totalPumps} total across all sites`}
          trend={{ value: '-4% vs this time yesterday', direction: 'down', positive: false }}
          icon="BoltIcon"
          warning={pumpPct < 80}
        />
        <MetricCard
          label="Critical Tank Alerts"
          value={String(criticalTanks)}
          subtext={`${lowTanks} tanks below 30% · immediate delivery required`}
          icon="ExclamationTriangleIcon"
          alert={criticalTanks > 0}
        />
        <MetricCard
          label="Litres Dispensed Today"
          value={formatLitres(totalLitres)}
          subtext={(() => { const active = sites.filter(s => s.litresDispensed > 0).length; return active ? `Across all ${sites.length} sites · avg ${Math.round(totalLitres / active / 100) * 100}L per active site` : `Across all ${sites.length} sites · none has sold yet today`; })()}
          trend={{ value: '+3.1% vs yesterday', direction: 'up', positive: true }}
          icon="BeakerIcon"
        />
      </div>

      {/* Site Status Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-foreground">Site Status</h2>
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {sites.filter((s) => s.status === 'active').length} operational · {sites.filter((s) => s.status !== 'active').length} with issues
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-4">
          {sites.map((site) => {
            const revenueProgress = site.revenueTarget > 0 ? (site.todayRevenue / site.revenueTarget) * 100 : 0;
            const isOffline = site.status === 'offline';
            const hasFault = site.status === 'fault';
            return (
              <Link
                key={site.id}
                href="/site-operations-detail"
                className="card p-4 flex flex-col gap-3 hover:border-primary/40 transition-all duration-200 cursor-pointer group"
                style={{
                  borderColor: isOffline
                    ? 'rgba(239,68,68,0.35)'
                    : hasFault
                    ? 'rgba(245,158,11,0.35)'
                    : 'var(--border)',
                }}
              >
                {/* Site header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                      {site.name}
                    </p>
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {site.manager}
                    </p>
                  </div>
                  <StatusBadge
                    status={site.status === 'fault' ? 'fault' : site.status === 'offline' ? 'offline' : 'active'}
                    size="sm"
                  />
                </div>

                {/* Pump counts */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-active)' }} />
                    <span className="text-xs font-mono-nums font-medium text-foreground">{site.pumps.active}</span>
                  </div>
                  {site.pumps.idle > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-idle)' }} />
                      <span className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{site.pumps.idle}</span>
                    </div>
                  )}
                  {site.pumps.fault > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-fault)' }} />
                      <span className="text-xs font-mono-nums font-medium" style={{ color: 'var(--status-fault)' }}>{site.pumps.fault}</span>
                    </div>
                  )}
                  {site.pumps.offline > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2rounded-full" style={{ backgroundColor: 'var(--status-offline)' }} />
                      <span className="text-xs font-mono-nums font-medium" style={{ color: 'var(--status-offline)' }}>{site.pumps.offline}</span>
                    </div>
                  )}
                  <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>pumps</span>
                </div>

                {/* Lowest tank */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      {site.lowestTankGrade}
                    </span>
                    <span
                      className="text-xs font-mono-nums font-semibold"
                      style={{
                        color:
                          site.lowestTankPct <= 15
                            ? 'var(--tank-critical)'
                            : site.lowestTankPct <= 30
                            ? 'var(--tank-low)'
                            : 'var(--tank-normal)',
                      }}
                    >
                      {site.lowestTankPct}%
                    </span>
                  </div>
                  <TankFillBar percentage={site.lowestTankPct} height={6} />
                </div>

                {/* Revenue */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Revenue today</span>
                    <span className="text-xs font-mono-nums font-semibold text-foreground">
                      {formatCurrency(site.todayRevenue)}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                    <div
                      className="h-1.5 rounded-full transition-all duration-700"
                      style={{
                        width: `${Math.min(100, revenueProgress)}%`,
                        backgroundColor: revenueProgress >= 90 ? 'var(--primary)' : revenueProgress >= 60 ? 'var(--accent)' : 'var(--status-offline)',
                      }}
                    />
                  </div>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    {Math.round(revenueProgress)}% of {formatCurrency(site.revenueTarget)} target
                  </p>
                </div>

                {/* Alerts + litres footer */}
                <div className="flex items-center justify-between pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-1.5">
                    {site.alertCount > 0 ? (
                      <>
                        <Icon name="BellAlertIcon" size={12} className="text-status-fault" />
                        <span className="text-xs font-medium" style={{ color: 'var(--status-fault)' }}>
                          {site.alertCount} alert{site.alertCount > 1 ? 's' : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <Icon name="CheckCircleIcon" size={12} className="text-primary" />
                        <span className="text-xs" style={{ color: 'var(--primary)' }}>No alerts</span>
                      </>
                    )}
                  </div>
                  <span className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>
                    {formatLitres(site.litresDispensed)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
        {/* Revenue trend */}
        <div className="xl:col-span-2 card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Revenue by Site — Last 7 Days</h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                Daily revenue (UGX) per site
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {sites.slice(0, 4).map((s, i) => {
                const colors = ['var(--primary)', '#3B82F6', '#F59E0B', '#8B5CF6'];
                return (
                  <div key={`legend-${s.id}`} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: colors[i] }} />
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{s.name.split(' ')[0]}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <RevenueAreaChart />
        </div>

        {/* Fuel grade bar */}
        <div className="card p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">Volume by Fuel Grade</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
              Litres dispensed today · all sites
            </p>
          </div>
          <FuelGradeBarChart />
        </div>
      </div>

      {/* Alerts Feed */}
      <div className="card" id="alerts">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-foreground">Live Alerts</h3>
            {openAlerts > 0 && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-semibold"
                style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: 'var(--status-offline)' }}
              >
                {openAlerts} open
              </span>
            )}
          </div>
          <button
            // It said "All alerts acknowledged" as a success, but told the server
            // nothing: after a refresh they were all back. It hides; it does not resolve.
            onClick={() => {
              setAlerts((prev) => prev.map((a) => ({ ...a, acknowledged: true })));
              showToast('Hidden until you refresh - they stay open until resolved in Shift Operations', 'info');
            }}
            title="Hide from this view until refresh. Alerts are resolved in Shift Operations." 
            className="btn-ghost text-xs"
          >
            Hide all
          </button>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {alerts.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>No active alerts across all sites</p>
            </div>
          ) : (
            alerts.map((alert) => {
              const cfg = alertTypeConfig[alert.type] ?? { ...Object.values(alertTypeConfig)[0], label: String(alert.type) };   // unknown value: neutral, not a crash
              return (
                <div
                  key={alert.id}
                  className={`flex items-start gap-4 px-5 py-3.5 transition-all duration-200 ${
                    alert.acknowledged ? 'opacity-50' : ''
                  }`}
                  style={!alert.acknowledged ? { backgroundColor: cfg.bg } : {}}
                >
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: alert.acknowledged ? 'var(--muted-foreground)' : cfg.dot }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-xs font-semibold"
                        style={{ color: alert.acknowledged ? 'var(--muted-foreground)' : cfg.textColor }}
                      >
                        {alert.siteName}
                      </span>
                      <span className="text-xs uppercase font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                        {alert.type}
                      </span>
                      {alert.acknowledged && (
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>· Acknowledged</span>
                      )}
                    </div>
                    <p className="text-xs mt-0.5 text-foreground leading-relaxed">{alert.message}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>
                      {alert.time}
                    </span>
                    {!alert.acknowledged && (
                      <button
                        onClick={() => acknowledgeAlert(alert.id)}
                        className="btn-ghost text-xs px-2 py-1"
                        title="Resolve it in Shift Operations, with what was found"
                      >
                        <Icon name="CheckIcon" size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => dismissAlert(alert.id)}
                      className="btn-ghost text-xs px-2 py-1"
                      title="Dismiss alert — removes from feed"
                    >
                      <Icon name="XMarkIcon" size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}