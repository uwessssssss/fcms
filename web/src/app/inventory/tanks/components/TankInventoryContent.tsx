'use client';
import { api, ApiError } from '@/lib/api';
import type { TankInventoryRow } from '@/types/api';
import { useSites } from '@/lib/useSites';
import React, { useState, useEffect} from 'react';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/context/AuthContext';



interface Tank {
  id: string;
  site: string;
  grade: string;
  gradeCode: string;
  gradeColor: string;
  capacityLitres: number;
  currentLitres: number;
  fillPct: number;
  status: 'normal' | 'low' | 'critical' | 'replenishing';
  drawRateLPH: number;
  hoursToEmpty: number | null;
  lastDelivery: string;
  nextDelivery: string | null;
}

/**
 * Grade colours, which the server does not send.
 *
 * A colour is a presentation decision, not a fact about a tank -- it belongs
 * here rather than in the database, where it would have to be migrated every
 * time the palette changed.
 */
const GRADE_COLOUR: Record<string, string> = {
  PMS: '#00D4A0',
  AGO: '#F59E0B',
  IK: '#60A5FA',
  LPG: '#A78BFA',
};

function toTank(r: TankInventoryRow): Tank {
  return {
    id: r.id,
    site: r.site,
    grade: r.grade,
    gradeCode: r.gradeCode,
    gradeColor: GRADE_COLOUR[r.gradeCode] ?? '#64748B',
    capacityLitres: r.capacityLitres,
    currentLitres: r.currentLitres,
    fillPct: r.fillPct,
    status: r.status as Tank['status'],
    drawRateLPH: r.drawRateLph ?? 0,
    hoursToEmpty: r.hoursToEmpty && r.hoursToEmpty > 0 ? r.hoursToEmpty : null,   // nothing drawing: no time to empty
    lastDelivery: r.lastDelivery ? r.lastDelivery.slice(0, 10) : '—',
    // No delivery scheduling exists in this system yet, so this is null rather
    // than a date invented to fill the column.
    nextDelivery: null,
  };
}

const statusColors: Record<string, string> = {
  normal: 'var(--status-active)',
  low: 'var(--accent)',
  critical: 'var(--status-fault)',
  replenishing: 'var(--primary)',
};

export default function TankInventoryContent() {
  const allSites = ['All Sites', ...useSites()];
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<TankInventoryRow[]>('/api/v1/inventory/tanks')
      .then((rows) => {
        if (!cancelled) {
          setTanks(rows.map(toTank));
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

  const { isSiteManager, assignedSite } = useAuth();
  const [selectedSite, setSelectedSite] = useState('All Sites');

  // Site managers are locked to their assigned site
  const effectiveSite = isSiteManager && assignedSite ? assignedSite : selectedSite;

  const scopedTanks = isSiteManager && assignedSite
    ? tanks.filter((t) => !t.site || t.site === assignedSite)   // the API scopes a station's rows; some carry no site (W1)
    : tanks;

  const filtered = effectiveSite === 'All Sites'
    ? scopedTanks
    : scopedTanks.filter((t) => t.site === effectiveSite);

  const criticalCount = scopedTanks.filter((t) => t.status === 'critical').length;
  const lowCount = scopedTanks.filter((t) => t.status === 'low').length;
  const totalLitres = scopedTanks.reduce((s, t) => s + t.currentLitres, 0);
  const totalCapacity = scopedTanks.reduce((s, t) => s + t.capacityLitres, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Reading tank levels&hellip;
          </p>
        </div>
      </div>
    );
  }

  if (loadError) {
    // Named, not swallowed. An empty tank list reads as "no tanks", which is a
    // different and much worse answer than "could not ask the server".
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not read tank levels
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tank Inventory</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            {isSiteManager && assignedSite
              ? `Fuel stock levels — ${assignedSite}`
              : 'Live fuel stock levels across all sites'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Icon name="ArrowPathIcon" size={14} className="text-primary" />
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Updated 16:57</span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Stock', value: `${(totalLitres / 1000).toFixed(0)}k L`, sub: `of ${(totalCapacity / 1000).toFixed(0)}k L capacity`, icon: 'BeakerIcon', color: 'var(--primary)' },
          { label: 'Critical Tanks', value: String(criticalCount), sub: criticalCount ? 'Order a delivery today' : 'None below the critical level', icon: 'ExclamationTriangleIcon', color: 'var(--status-fault)' },
          { label: 'Low Stock', value: String(lowCount), sub: lowCount ? 'Order within 48 hours' : 'None running low', icon: 'ExclamationCircleIcon', color: 'var(--accent)' },
          { label: isSiteManager ? 'Your Site' : 'Sites Monitored', value: isSiteManager ? '1' : String(new Set(scopedTanks.map((t) => t.site).filter(Boolean)).size), sub: isSiteManager ? (assignedSite ?? 'Assigned site') : 'Stations and depots with tanks', icon: 'MapPinIcon', color: 'var(--primary)' },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl p-4 border"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${card.color}20` }}>
                <Icon name={card.icon as Parameters<typeof Icon>[0]['name']} size={16} style={{ color: card.color }} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{card.label}</span>
            </div>
            <p className="text-2xl font-bold font-mono-nums text-foreground">{card.value}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{card.sub}</p>
          </div>
        ))}
      </div>

      {/* Site filter — only shown to head office */}
      {!isSiteManager && (
        <div className="flex items-center gap-2 flex-wrap">
          {allSites.map((site) => (
            <button
              key={site}
              onClick={() => setSelectedSite(site)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                backgroundColor: selectedSite === site ? 'var(--primary)' : 'var(--muted)',
                color: selectedSite === site ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
              }}
            >
              {site}
            </button>
          ))}
        </div>
      )}

      {/* Site manager locked-site badge */}
      {isSiteManager && assignedSite && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl w-fit"
          style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}
        >
          <Icon name="MapPinIcon" size={14} style={{ color: 'rgb(96,165,250)' }} />
          <span className="text-xs font-semibold" style={{ color: 'rgb(96,165,250)' }}>
            {assignedSite}
          </span>
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>— your assigned site</span>
        </div>
      )}

      {/* Tank grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((tank) => (
          <div
            key={tank.id}
            className="rounded-xl p-5 border"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: tank.gradeColor }}
                  />
                  <span className="text-sm font-semibold text-foreground">{tank.grade}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-xs font-mono font-bold"
                    style={{ backgroundColor: `${tank.gradeColor}20`, color: tank.gradeColor }}
                  >
                    {tank.gradeCode}
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{tank.site}</p>
              </div>
              <span
                className="px-2 py-0.5 rounded-full text-xs font-semibold capitalize"
                style={{
                  backgroundColor: `${statusColors[tank.status]}20`,
                  color: statusColors[tank.status],
                }}
              >
                {tank.status}
              </span>
            </div>

            <div className="mb-3">
              <div className="flex justify-between text-xs mb-1.5">
                <span style={{ color: 'var(--muted-foreground)' }}>
                  {(tank.currentLitres / 1000).toFixed(1)}k / {(tank.capacityLitres / 1000).toFixed(0)}k L
                </span>
                <span className="font-semibold text-foreground">{tank.fillPct}%</span>
              </div>
              <div className="w-full h-3 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--muted)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${tank.fillPct}%`,
                    backgroundColor: tank.status === 'critical' ? 'var(--status-fault)' : tank.status === 'low' ? 'var(--accent)' : tank.gradeColor,
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p style={{ color: 'var(--muted-foreground)' }}>Draw rate</p>
                <p className="font-semibold text-foreground font-mono-nums">{tank.drawRateLPH} L/h</p>
              </div>
              <div>
                <p style={{ color: 'var(--muted-foreground)' }}>Est. empty</p>
                <p className="font-semibold text-foreground font-mono-nums">{tank.hoursToEmpty == null ? '—' : `${tank.hoursToEmpty.toFixed(1)}h`}</p>
              </div>
              <div>
                <p style={{ color: 'var(--muted-foreground)' }}>Last delivery</p>
                <p className="font-semibold text-foreground">{tank.lastDelivery}</p>
              </div>
              <div>
                <p style={{ color: 'var(--muted-foreground)' }}>Next delivery</p>
                <p
                  className="font-semibold"
                  style={{ color: tank.nextDelivery === 'Today' ? 'var(--status-fault)' : 'var(--foreground)' }}
                >
                  {tank.nextDelivery ?? '—'}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
