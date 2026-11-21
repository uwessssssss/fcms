'use client';
import { api, ApiError } from '@/lib/api';
import type { AuditRow, ChannelRef, ProductRow, SessionRow, SettingRow } from '@/types/api';
import React, { useState, useEffect, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';

interface FeatureToggle {
  id: string;
  category: string;
  label: string;
  description: string;
  enabled: boolean;
  icon: string;
}

interface FuelGrade {
  id: string;
  name: string;
  color: string;
  pricePerLitre: number;
  active: boolean;
}

interface MobileMoneyProvider {
  id: string;
  name: string;
  country: string;
  active: boolean;
  color: string;
}

/**
 * The trading policy, from GET /api/v1/settings
 *
 * These were on/off toggles for features. What a station actually configures
 * is its TOLERANCES -- how far a tank may drift from the books before it is an
 * exception -- and those live in the trading policy the database checks read.
 *
 * Shown read-only. Changing a tolerance changes which past shifts count as
 * exceptions, and that is a decision for head office through the policy
 * screen, not a switch a supervisor flips on a Tuesday.
 */
function toFeatureToggle(r: SettingRow): FeatureToggle {
  return {
    id: r.key,
    category: r.category,
    label: `${r.label}: ${r.value}`,
    description: r.description,
    enabled: true,
    icon: r.kind === 'litres' ? 'BeakerIcon' : 'AdjustmentsHorizontalIcon',
  } satisfies FeatureToggle;
}

/** Fuel grades with their pump prices, from GET /api/v1/products. */
function toFuelGrade(r: ProductRow): FuelGrade {
  const colours: Record<string, string> = { PMS: '#00D4A0', AGO: '#F59E0B', IK: '#60A5FA', LPG: '#A78BFA' };
  return {
    id: r.id,
    name: `${r.name} (${r.code})`,
    color: colours[r.code] ?? '#64748B',
    pricePerLitre: r.pumpPrice ?? 0,
    active: r.isActive,
  } satisfies FuelGrade;
}

/**
 * Payment channels, from GET /api/setup/payment-channels.
 *
 * Each carries its merchant TILL NUMBER -- the figure an attendant reads to a
 * customer, and the one an accountant matches against the MTN statement.
 */
function toProvider(r: ChannelRef): MobileMoneyProvider {
  return {
    id: r.id,
    name: r.tillNumber ? `${r.name} · till ${r.tillNumber}` : r.name,
    country: r.kind,
    active: true,
    color: /mtn/i.test(r.name) ? '#FFCC00' : /airtel/i.test(r.name) ? '#E40000' : '#60A5FA',
  } satisfies MobileMoneyProvider;
}

const CATEGORIES = ['Operations', 'Inventory', 'Revenue', 'Finance', 'Reports'];

export default function SystemCustomisationContent() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);




  const { showToast } = useToast();


  /**
   * This said "System settings saved successfully" and saved nothing. The
   * tolerances shown are the trading policy in force, read from the row the
   * variance checks use; changing one changes which past shifts count as
   * exceptions, so it is not a toggle on this page.
   */
  /**
   * Who is signed in, and what has been done.
   *
   * SESSIONS matter on a forecourt: machines are shared, and a session left
   * open on the office computer is somebody else's authority lying around.
   * Revoking one ends it now rather than at expiry.
   *
   * The AUDIT TRAIL is append-only in the database. It is shown, never edited.
   */
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  const loadAdmin = useCallback(async () => {
    const [ss, aa] = await Promise.all([
      api.get<SessionRow[]>('/api/admin/sessions').catch(() => [] as SessionRow[]),
      api.get<AuditRow[]>('/api/admin/audit').catch(() => [] as AuditRow[]),
    ]);
    setSessions(ss);
    setAudit(aa.slice(0, 25));
    // The spinner waits for this: before it, "Nobody is signed in" would be untrue.
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  const revoke = async (id: string, who: string) => {
    try {
      await api.post<unknown>(`/api/admin/sessions/${id}/revoke`, {});
      await loadAdmin();
      showToast(`${who} signed out`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };



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
          Could not load settings
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pt-4 grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="rounded-xl border p-4 space-y-2" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold text-foreground">Who is signed in</h2>
          {sessions.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Nobody, or you cannot see sessions.</p>
          )}
          {sessions.map((x) => (
            <div key={x.id} className="flex items-center justify-between text-xs border-t pt-2"
                 style={{ borderColor: 'var(--border)' }}>
              <span>
                <strong className="text-foreground">{x.fullName}</strong> ({x.employeeNo})
                <br />
                <span style={{ color: 'var(--muted-foreground)' }}>
                  last seen {new Date(x.lastSeenAt).toLocaleString()}{x.ipAddress ? ` from ${x.ipAddress}` : ''}
                </span>
              </span>
              <button onClick={() => revoke(x.id, x.fullName)} className="px-2 py-1 rounded-lg font-semibold"
                      style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>Sign out</button>
            </div>
          ))}
        </div>

        <div className="rounded-xl border p-4 space-y-1" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
          <p className="text-xs mb-1" style={{ color: 'var(--muted-foreground)' }}>
            Append-only. Shown, never edited.
          </p>
          {audit.map((a) => (
            <p key={a.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              <span className="text-foreground">{a.actorName ?? 'system'}</span> {a.action.toLowerCase()} {a.entity}
              {' - '}{new Date(a.occurredAt).toLocaleString()}
            </p>
          ))}
          {audit.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Nothing recorded yet.</p>
          )}
        </div>
      </div>
    {/* The tabs that were here -- feature toggles, fuel grades and prices, payment
        methods, station setup -- kept every change in the browser and saved
        nothing: a price "changed" here changed no price. Each setting has a
        real home that saves it, linked below. */}
    <div className="px-4 pb-4">
      <div className="rounded-xl border p-4 space-y-2" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold text-foreground">Where each setting lives</h2>
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Settings are changed where they take effect, so each change is saved, checked and recorded.
        </p>
        {([
          ['Fuel prices', 'Scheduled per product, and cut the shift when they take effect', '/products'],
          ['Payment methods', 'Payment channels: mobile money, card, voucher', '/administration'],
          ['Trading policy', 'Variance limits, credit sales on or off, the attendant debt limit', '/administration'],
          ['Pumps, tanks and nozzles', 'The equipment at a station, and its calibration', '/pump-setup'],
          ['A depot', 'Set up a depot and its tanks: Administration, under Depot', '/administration'],
          ['People and access', 'Who works where, and who may sign in', '/users'],
        ] as const).map(([what, how, href]) => (
          <a key={what} href={href} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-white/[0.04]">
            <span>
              <span className="text-sm font-medium text-foreground">{what}</span>
              <span className="block text-xs" style={{ color: 'var(--muted-foreground)' }}>{how}</span>
            </span>
            <Icon name="ChevronRightIcon" size={14} className="text-muted-foreground" />
          </a>
        ))}
      </div>
    </div>
    </>
  );
}
