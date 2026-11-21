'use client';
import { api } from '@/lib/api';
import type {
  AlertRow,
  DashboardOverview,
  NozzleState,
  ShiftSalesPoint,
  SiteOperations,
  TankInventoryRow,
} from '@/types/api';
import { useRouter } from 'next/navigation';
import { downloadCsv } from '@/lib/csv';
import { localDate } from '@/lib/dates';
import React, { useState, useEffect } from 'react';
import StatusBadge from '@/components/ui/StatusBadge';
import TankFillBar from '@/components/ui/TankFillBar';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';
import dynamic from 'next/dynamic';

const ShiftSalesChart = dynamic(() => import('./ShiftSalesChart'), { ssr: false });
import { shiftName } from './ShiftSalesChart';

// Backend: GET /api/v1/sites/:siteId/operations — returns full site operational data

type PumpStatus = 'active' | 'idle' | 'fault' | 'offline' | 'maintenance';
type NozzleStatus = 'dispensing' | 'idle' | 'fault' | 'disabled';
type TankStatus = 'normal' | 'low' | 'critical' | 'replenishing';

interface Nozzle {
  id: string;
  grade: string;
  gradeCode: string;
  status: NozzleStatus;
  litresDispensedToday: number;
  lastTransaction: string;
  pricePerLitre: number;
}

interface Pump {
  id: string;
  number: number;
  status: PumpStatus;
  nozzles: Nozzle[];
  totalLitresToday: number;
  totalRevToday: number;
  lastActive: string;
}

interface Tank {
  id: string;
  grade: string;
  gradeCode: string;
  capacityLitres: number;
  currentLitres: number;
  fillPct: number;
  status: TankStatus;
  drawRateLPH: number;
  hoursToEmpty: number;
  lastDelivery: string;
  nextDelivery: string | null;
}


interface SiteAlert {
  id: string;
  type: 'critical' | 'fault' | 'warning' | 'info';
  message: string;
  time: string;
  acknowledged: boolean;
  source: string;
}

// Site-specific data keyed by site name
/**
 * One site's floor, assembled from three endpoints.
 *
 * The mock kept a whole site -- pumps, tanks, transactions, alerts -- in one
 * object keyed by site NAME. The live version asks three questions of three
 * endpoints that already answer them for other screens, so this floor cannot
 * disagree with the tank screen or the alert list about the same site.
 *
 * TRANSACTIONS ARE EMPTY, and deliberately. A station reading meters by hand
 * has no per-transaction record: there is a meter that moved and a shift that
 * totalled it. An itemised list of sales would have to be invented, and a
 * fabricated till roll is the worst thing this screen could show -- it looks
 * exactly like evidence.
 */
type SiteData = {
  siteName: string;
  siteCode: string;
  location: string;
  manager: string;
  status: 'active' | 'fault' | 'offline';
  pumps: Pump[];
  tanks: Tank[];
  alerts: SiteAlert[];
};

const EMPTY_SITE: SiteData = {
  siteName: '',
  siteCode: '',
  location: '',
  manager: '',
  status: 'offline',
  pumps: [],
  tanks: [],
  alerts: [],
};

function toPumps(nozzles: NozzleState[]): Pump[] {
  const byPump = new Map<string, NozzleState[]>();
  for (const n of nozzles) {
    byPump.set(n.pumpCode, [...(byPump.get(n.pumpCode) ?? []), n]);
  }
  return Array.from(byPump.entries()).map(([code, ns], i) => ({
    id: code,
    number: Number(code.replace(/\D/g, '')) || i + 1,
    // Active when somebody is rostered on any of its nozzles. Without a pump
    // controller there is no fault or offline state to report, so none is
    // invented.
    status: ns.some((n) => n.status === 'active') ? 'active' : 'idle',
    nozzles: ns.map((n) => ({
      id: n.id,
      grade: n.gradeName,
      gradeCode: n.gradeCode,
      status: n.status === 'active' ? 'dispensing' : 'idle',
      litresDispensedToday: n.todayLitres,
      lastTransaction: n.lastReadingAt
        ? new Date(n.lastReadingAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
      pricePerLitre: n.todayLitres > 0 ? Math.round(n.todayRevenue / n.todayLitres) : 0,
    })) as Nozzle[],
    totalLitresToday: ns.reduce((a, n) => a + n.todayLitres, 0),
    totalRevToday: ns.reduce((a, n) => a + n.todayRevenue, 0),
    lastActive: ns.find((n) => n.lastReadingAt)?.lastReadingAt ?? '—',
  }));
}

function toSiteTank(r: TankInventoryRow): Tank {
  return {
    id: r.id,
    grade: r.grade,
    gradeCode: r.gradeCode,
    capacityLitres: r.capacityLitres,
    currentLitres: r.currentLitres,
    fillPct: r.fillPct,
    status: r.status as Tank['status'],
    drawRateLPH: r.drawRateLph ?? 0,
    hoursToEmpty: r.hoursToEmpty ?? 0,
    lastDelivery: r.lastDelivery ? r.lastDelivery.slice(0, 10) : '—',
    nextDelivery: null,
  } satisfies Tank;
}

function toSiteAlert(r: AlertRow): SiteAlert {
  return {
    id: r.id,
    type: r.type,
    message: r.message,
    time: new Date(r.raisedAt).toLocaleString(),
    acknowledged: r.acknowledged,
  } as unknown as SiteAlert;
}


const nozzleStatusConfig: Record<NozzleStatus, { color: string; label: string; pulse: boolean }> = {
  dispensing: { color: 'var(--status-active)',      label: 'Dispensing', pulse: true },
  idle:       { color: 'var(--status-idle)',        label: 'Idle',       pulse: false },
  fault:      { color: 'var(--status-fault)',       label: 'Fault',      pulse: true },
  disabled:   { color: 'var(--status-maintenance)', label: 'Disabled',   pulse: false },
};

const gradeColors: Record<string, string> = {
  PMS: 'var(--primary)',
  AGO: '#F59E0B',
  DSL: '#3B82F6',
  ADB: '#8B5CF6',
};

const paymentBadgeConfig: Record<string, { bg: string; text: string }> = {
  Card:         { bg: 'rgba(59,130,246,0.12)',  text: '#3B82F6' },
  Cash:         { bg: 'rgba(107,122,153,0.12)', text: 'var(--muted-foreground)' },
  'Mobile Money': { bg: 'rgba(0,200,150,0.12)', text: 'var(--primary)' },
  Fleet:        { bg: 'rgba(139,92,246,0.12)',  text: '#8B5CF6' },
};

const pumpStatusConfig: Record<PumpStatus, { color: string; label: string }> = {
  active:      { color: 'var(--status-active)',      label: 'Active' },
  idle:        { color: 'var(--status-idle)',        label: 'Idle' },
  fault:       { color: 'var(--status-fault)',       label: 'Fault' },
  offline:     { color: 'var(--status-offline)',     label: 'Offline' },
  maintenance: { color: 'var(--status-maintenance)', label: 'Maintenance' },
};

const tankStatusConfig: Record<TankStatus, { color: string; label: string }> = {
  normal:       { color: 'var(--status-active)', label: 'Normal' },
  low:          { color: 'var(--accent)',         label: 'Low' },
  critical:     { color: 'var(--status-fault)',   label: 'Critical' },
  replenishing: { color: 'var(--primary)',        label: 'Replenishing' },
};

function fmt(n: number) { return n.toLocaleString('en-UG'); }

export default function SiteOperationsContent() {
  const router = useRouter();
  const { isSiteManager, assignedSite, assignedSiteId, user } = useAuth();
  const [activeTab, setActiveTab] = useState<'overview' | 'alerts'>('overview');
  const [shiftSales, setShiftSales] = useState<ShiftSalesPoint[]>([]);
  const { showToast } = useToast();

  // Determine which site data to show
  const [siteData, setSiteData] = useState<SiteData>(EMPTY_SITE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SiteAlert[]>([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // A site manager sees their own site. Head office has no site of its
        // own, so it sees the first trading site -- a picker belongs here, and
        // until there is one this at least shows something real.
        let siteId = isSiteManager ? assignedSiteId : null;
        if (!siteId) {
          const overview = await api.get<DashboardOverview>('/api/v1/dashboard/overview');
          siteId = overview.sites[0]?.id ?? null;
        }
        if (!siteId) throw new Error('There are no trading sites yet.');

        const [ops, tanks, siteAlerts, byShift] = await Promise.all([
          api.get<SiteOperations>(`/api/v1/sites/${siteId}/operations`),
          api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
          api.get<AlertRow[]>('/api/v1/dashboard/alerts'),
          api.get<ShiftSalesPoint[]>(`/api/v1/sites/${siteId}/analytics/by-shift`),
        ]);
        if (cancelled) return;

        const mine = siteAlerts.filter((a) => a.siteId === siteId);
        setSiteData({
          siteName: ops.siteName,
          siteCode: '',
          location: ops.location,
          manager: ops.manager,
          status: mine.some((a) => a.type === 'critical')
            ? 'fault'
            : ops.shiftOpen
              ? 'active'
              : 'offline',
          pumps: toPumps(ops.nozzles),
          tanks: tanks.filter((t) => t.site === ops.siteName).map(toSiteTank),
                  alerts: mine.map(toSiteAlert),
        });
        setAlerts(mine.map(toSiteAlert));
        setShiftSales(byShift);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSiteManager, assignedSiteId]);

  const pumps = siteData.pumps;
  const tanks = siteData.tanks;

  const totalRevToday = pumps.reduce((s, p) => s + p.totalRevToday, 0);
  const totalLitresToday = pumps.reduce((s, p) => s + p.totalLitresToday, 0);
  const activePumpsCount = pumps.filter((p) => p.status === 'active').length;
  const openAlertsCount = alerts.filter((a) => !a.acknowledged).length;
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const acknowledgeAlert = (_id: string) => {
    router.push('/shift-operations');
  };


  const tabs: { key: typeof activeTab; label: string; badge?: number }[] = [
    { key: 'overview', label: 'Operations Overview' },
    { key: 'alerts', label: 'Alerts', badge: openAlertsCount },
  ];

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
          Could not load the site
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Site Header */}
      <div
        className="card p-5"
        style={{ borderColor: siteData.status === 'fault' ? 'rgba(245,158,11,0.3)' : siteData.status === 'active' ? 'rgba(0,212,160,0.2)' : 'rgba(239,68,68,0.3)', backgroundColor: 'var(--card)' }}
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(0,200,150,0.1)' }}
            >
              <Icon name="BuildingStorefrontIcon" size={24} className="text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-semibold text-foreground">{siteData.siteName}</h1>
                <StatusBadge
                  status={siteData.status === 'active' ? 'active' : siteData.status === 'fault' ? 'fault' : 'offline'}
                  label={siteData.status === 'active' ? 'Operational' : siteData.status === 'fault' ? 'Attention Required' : 'Offline'}
                />
                <span
                  className="text-xs px-2 py-0.5 rounded font-mono-nums"
                  style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}
                >
                  {siteData.siteCode}
                </span>
              </div>
              <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
                {siteData.location} · Site Manager: {siteData.manager}
              </p>
              <div className="flex items-center gap-4 mt-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--status-active)' }} />
                  <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {activePumpsCount} of {pumps.length} pumps active
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Icon name="BanknotesIcon" size={12} className="text-primary" />
                  <span className="text-xs font-mono-nums font-semibold text-foreground">
                    UGX {fmt(totalRevToday)}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>today</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Icon name="BeakerIcon" size={12} className="text-muted-foreground" />
                  <span className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>
                    {(totalLitresToday / 1000).toFixed(1)}k L dispensed
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-secondary text-sm" onClick={() => downloadCsv(`${siteData.siteName || 'site'}-sales-by-shift-${localDate()}.csv`,
                ['Shift', 'Opened', 'Closed', 'State', 'Litres', 'Revenue (UGX)'],
                shiftSales.map((x) => [shiftName(x), x.openedAt, x.closedAt ?? '', x.state, x.litres, x.revenue]))}>
              <Icon name="ArrowDownTrayIcon" size={15} />
              Export Report
            </button>
            <button className="btn-primary text-sm" onClick={() => router.push('/inventory/deliveries')}>
              <Icon name="TruckIcon" size={15} />
              Book a Delivery
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {tabs.map((tab) => (
          <button
            key={`tab-${tab.key}`}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-150 -mb-px ${
              activeTab === tab.key
                ? 'border-primary text-primary' :'border-transparent hover:text-foreground'
            }`}
            style={{ color: activeTab === tab.key ? 'var(--primary)' : 'var(--muted-foreground)' }}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span
                className="px-1.5 py-0.5 rounded-full text-xs font-bold"
                style={{
                  backgroundColor: activeTab === tab.key ? 'rgba(0,212,160,0.15)' : 'var(--muted)',
                  color: activeTab === tab.key ? 'var(--primary)' : 'var(--muted-foreground)',
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* KPI Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Today\'s Revenue', value: `UGX ${fmt(totalRevToday)}`, icon: 'BanknotesIcon', color: 'var(--primary)' },
              { label: 'Litres Dispensed', value: `${(totalLitresToday / 1000).toFixed(1)}k L`, icon: 'BeakerIcon', color: '#60A5FA' },
              { label: 'Active Pumps', value: `${activePumpsCount} / ${pumps.length}`, icon: 'BoltIcon', color: '#A78BFA' },
              { label: 'Open Alerts', value: String(openAlertsCount), icon: 'BellAlertIcon', color: openAlertsCount > 0 ? '#F59E0B' : 'var(--primary)' },
            ].map((kpi) => (
              <div
                key={`kpi-${kpi.label}`}
                className="card p-4"
                style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)' }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${kpi.color}20` }}>
                    <Icon name={kpi.icon as Parameters<typeof Icon>[0]['name']} size={14} style={{ color: kpi.color }} />
                  </div>
                  <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{kpi.label}</span>
                </div>
                <p className="text-lg font-bold font-mono-nums text-foreground">{kpi.value}</p>
              </div>
            ))}
          </div>

          {/* Pumps Grid */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">Pump Status</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {pumps.map((pump) => {
                const cfg = pumpStatusConfig[pump.status] ?? pumpStatusConfig.idle;   // an unknown status must not take the screen down
                return (
                  <div
                    key={pump.id}
                    className="card p-4 space-y-3"
                    style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${cfg.color}15` }}
                        >
                          <Icon name="BoltIcon" size={16} style={{ color: cfg.color }} />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">Pump {pump.number}</p>
                          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Last: {pump.lastActive}</p>
                        </div>
                      </div>
                      <span
                        className="text-xs px-2 py-1 rounded-full font-medium"
                        style={{ backgroundColor: `${cfg.color}15`, color: cfg.color }}
                      >
                        {cfg.label}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {pump.nozzles.map((nozzle) => {
                        const nCfg = nozzleStatusConfig[nozzle.status] ?? nozzleStatusConfig.idle;
                        return (
                          <div
                            key={nozzle.id}
                            className="flex items-center justify-between px-3 py-2 rounded-lg"
                            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                          >
                            <div className="flex items-center gap-2">
                              <div
                                className={`w-1.5 h-1.5 rounded-full ${nCfg.pulse ? 'pulse-dot' : ''}`}
                                style={{ backgroundColor: nCfg.color }}
                              />
                              <span className="text-xs font-medium text-foreground">{nozzle.grade}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>
                                {fmt(nozzle.litresDispensedToday)} L
                              </span>
                              <span className="text-xs" style={{ color: nCfg.color }}>{nCfg.label}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                      <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Today</span>
                      <span className="text-xs font-mono-nums font-semibold text-foreground">
                        UGX {fmt(pump.totalRevToday)} · {fmt(pump.totalLitresToday)} L
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tanks */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">Tank Levels</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {tanks.map((tank) => {
                const tCfg = tankStatusConfig[tank.status] ?? tankStatusConfig.normal;
                return (
                  <div
                    key={tank.id}
                    className="card p-4 space-y-3"
                    style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon name="BeakerIcon" size={16} style={{ color: gradeColors[tank.gradeCode] ?? 'var(--primary)' }} />
                        <span className="text-sm font-semibold text-foreground">{tank.grade}</span>
                      </div>
                      <span
                        className="text-xs px-2 py-1 rounded-full"
                        style={{ backgroundColor: `${tCfg.color}15`, color: tCfg.color }}
                      >
                        {tCfg.label}
                      </span>
                    </div>
                    <TankFillBar fillPct={tank.fillPct} status={tank.status} />
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p style={{ color: 'var(--muted-foreground)' }}>Current</p>
                        <p className="font-mono-nums font-semibold text-foreground">{fmt(tank.currentLitres)} L</p>
                      </div>
                      <div>
                        <p style={{ color: 'var(--muted-foreground)' }}>Capacity</p>
                        <p className="font-mono-nums font-semibold text-foreground">{fmt(tank.capacityLitres)} L</p>
                      </div>
                      <div>
                        <p style={{ color: 'var(--muted-foreground)' }}>Hrs to Empty</p>
                        <p className="font-mono-nums font-semibold" style={{ color: tank.status === 'critical' ? 'var(--status-fault)' : 'var(--foreground)' }}>
                          {tank.hoursToEmpty.toFixed(1)}h
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                      <span style={{ color: 'var(--muted-foreground)' }}>Last delivery: {tank.lastDelivery}</span>
                      <span style={{ color: tank.nextDelivery === 'Today' ? 'var(--primary)' : 'var(--muted-foreground)' }}>
                        Next: {tank.nextDelivery ?? 'Not scheduled'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sales by shift */}
          <div className="card p-4" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)' }}>
            <h2 className="text-sm font-semibold text-foreground mb-1">Sales by shift — this business day</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--muted-foreground)' }}>
              Measured from the meters when each shift closes. Sales are not recorded hour by hour, so no hourly figure is shown.
            </p>
            <ShiftSalesChart rows={shiftSales} />
          </div>
        </div>
      )}

      {/* Transactions Tab */}
      {activeTab === 'alerts' && (
        <div className="space-y-3">
          {alerts.length === 0 && (
            <div className="card p-8 text-center">
              <Icon name="CheckCircleIcon" size={32} className="text-primary mx-auto mb-2" />
              <p className="text-sm text-foreground font-medium">No active alerts</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>All systems operating normally</p>
            </div>
          )}
          {alerts.map((alert) => {
            const alertColors: Record<string, { bg: string; border: string; dot: string }> = {
              critical: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)', dot: '#ef4444' },
              fault:    { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', dot: '#f59e0b' },
              warning:  { bg: 'rgba(234,179,8,0.06)',  border: 'rgba(234,179,8,0.25)',  dot: '#EAB308' },
              info:     { bg: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.2)', dot: '#3b82f6' },
            };
            const ac = alertColors[alert.type];
            return (
              <div
                key={alert.id}
                className="card p-4 flex items-start gap-3"
                style={{ backgroundColor: ac.bg, borderColor: ac.border, opacity: alert.acknowledged ? 0.6 : 1 }}
              >
                <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: ac.dot }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{alert.message}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{alert.time}</span>
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>· {alert.source}</span>
                    {alert.acknowledged && <span className="text-xs text-primary">· Acknowledged</span>}
                  </div>
                </div>
                {!alert.acknowledged && (
                  <button
                    onClick={() => acknowledgeAlert(alert.id)}
                      title="Resolve it in Shift Operations, with what was found"
                    className="text-xs px-3 py-1.5 rounded-lg shrink-0 transition-all hover:opacity-80"
                    style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'var(--muted-foreground)', border: '1px solid rgba(255,255,255,0.08)' }}
                  >Resolve</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}