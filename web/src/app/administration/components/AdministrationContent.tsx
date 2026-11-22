'use client';

import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker, hasErrors } from '@/lib/checks';
import React, { useCallback, useEffect, useState, useMemo } from 'react';

import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import type { ChannelRef, DashboardOverview, PolicyRow, ProductRow, SiteOverviewRow, TankInventoryRow } from '@/types/api';

/**
 * The settings that decide what counts as a problem.
 *
 * THE TRADING POLICY holds every tolerance the variance checks read: how far a
 * tank may drift from the books before it is an exception, how much water
 * raises the alarm, how far the two meter heads may disagree. Changing one
 * changes which shifts are flagged -- including, on re-read, past ones -- so it
 * is head office's decision, and the server refuses anyone else.
 *
 * PAYMENT CHANNELS are the mobile-money tills and card terminals attendants
 * declare against at close. Each carries its merchant till number, which is
 * what an accountant matches against the MTN or Airtel statement.
 *
 * CALIBRATION is the chart that turns a dip in millimetres into litres. Every
 * dip taken with a stick depends on it, so it is loaded from the tank's own
 * certificate -- one line per reading, millimetres then litres.
 */
type Field = [keyof PolicyRow, string, string];

const POLICY_FIELDS: Field[] = [
  ['shiftVariancePct', 'Shift variance tolerance (%)', 'A tank further than this from the books at close, as a share of what it sold, is an exception.'],
  // A CAP, not a floor. This said "floor - below this, a variance is ignored";
  // the close flags a shift that breaks EITHER limit. Read as a floor, it would
  // be set low to quieten noise -- and every shift would be flagged.
  ['shiftVarianceLitres', 'Most litres a shift may lose (L)', 'Beyond this it is an exception, whatever the percentage: on a busy day a large loss hides inside a small one.'],
  ['monthlyVariancePct', 'Monthly loss tolerance (%)', 'A grade losing more than this share of what it sold is shown in red on the reports.'],
  ['maxShortageCarry', 'Most an attendant may owe (UGX)', 'Putting someone who owes more on a nozzle raises a warning. It does not stop them working.'],
  ['meterPairToleranceLitres', 'Meters may disagree by (L)', 'Electronic against manual litres on each nozzle at a close. Beyond this the close needs a reason and goes to the manager flagged.'],
  ['pumpTestTolerancePct', 'Pump test tolerance (%)', 'A test can outside this means the pump needs calibrating.'],
  ['transitLossPct', 'Allowed transit loss (%)', 'Between the depot note and the dips at the station.'],
  ['waterAlarmMm', 'Water alarm (mm)', 'Water above this in a tank raises a critical exception.'],
  ['waterAlarmLitres', 'Water alarm (L)', 'The same, in litres. Tune to tank size - litres do not scale like millimetres.'],
  ['postDecantSettleMin', 'Settle after a delivery (minutes)', 'Dipping before fuel settles reads high.'],
  ['cashVarianceAlert', 'Cash variance alert (UGX)', 'A cash-up further off than this is flagged.'],
  ['attendantCashCap', 'Most cash carried between drops (UGX)', 'Attendants drop cash in the safe, witnessed, before reaching this. A drop or a cash-up bigger than this shows someone carried too much, and is flagged. 0 turns the check off.'],
  ['dipNoiseLitres', 'Dipstick noise (L)', 'A tank this close to the books is within what the stick can read, and is not raised however quiet the shift.'],
];

const POLICY_FLAGS: Field[] = [
  ['allowCreditSales', 'Allow credit sales', 'Fuel on account to trade customers.'],
];

/**
 * Stored in the policy but enforced by NOTHING yet -- so not offered as
 * controls. They were: a head office could change them and nothing happened.
 * Each needs a decision about what it should do before it does anything.
 */
const NOT_ENFORCED = [
  'How closely two dips must agree',
  'Second approver above an amount', 'How late a reading\'s photo may follow',
  'Allow a dip above the calibration chart', 'A price change cuts the shift',
];

export default function AdministrationContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const { showToast } = useToast();
  const [tab, setTab] = useState<'policy' | 'channels' | 'calibration' | 'depot'>('policy');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [policy, setPolicy] = useState<PolicyRow | null>(null);
  const [channels, setChannels] = useState<ChannelRef[]>([]);
  const [tanks, setTanks] = useState<TankInventoryRow[]>([]);
  const [chan, setChan] = useState({ code: '', name: '', kind: 'MOBILE_MONEY', till: '' });
  const [calTank, setCalTank] = useState('');

  // ---- the policy: numbers that govern everything downstream ----
  // A tolerance typed as 50 (%) for 0.5 would pass every loss in the company.
  const [policyTried, setPolicyTried] = useState(false);
  const policyIssues = useMemo(() => {
    const c = new Checker();
    if (!policy) return c.issues;
    const neg = Object.entries(policy).filter(([, v]) => typeof v === 'number' && v < 0).map(([k]) => k);
    if (neg.length) c.error('policy', `These cannot be negative: ${neg.join(', ')}`);
    const pct = (v: number, what: string) => { if (v > 2) c.warn('policy', `${what} is ${v}% - did you mean ${v / 100}%? A wide tolerance hides losses`); };
    pct(policy.shiftVariancePct, 'Shift variance tolerance'); pct(policy.monthlyVariancePct, 'Monthly loss tolerance');
    pct(policy.transitLossPct, 'Transit loss allowed'); 
    if (policy.shiftVarianceLitres > 500) c.warn('policy', `A shift could lose ${policy.shiftVarianceLitres.toLocaleString()} L before it is an exception`);
    if (policy.shiftVarianceLitres === 0) c.warn('policy', 'A litres cap of 0 makes every shift an exception');
    if (policy.maxShortageCarry > 2000000) c.warn('policy', `An attendant could owe UGX ${policy.maxShortageCarry.toLocaleString()} before a warning`);
    return c.issues;
  }, [policy]);

  // ---- depot ----
  // Most companies have no depot; the few that do set it up here. A depot is a
  // site of kind DEPOT -- adding one makes the Depot screens appear -- and its
  // tanks are added here too, because the head office that sets it up cannot
  // add equipment from the Pump Setup screen (that adds to its own site).
  const [depots, setDepots] = useState<SiteOverviewRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [newDepot, setNewDepot] = useState({ code: '', name: '', address: '' });
  const [depTank, setDepTank] = useState({ depotId: '', code: '', productId: '', capacity: '', safeFill: '', deadStock: '0', depthMm: '3000' });
  const [calText, setCalText] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, c, t, ov, prods] = await Promise.all([
        api.get<PolicyRow>('/api/admin/policy').catch(() => null),
        api.get<ChannelRef[]>('/api/setup/payment-channels'),
        api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
        api.get<DashboardOverview>('/api/v1/dashboard/overview').catch(() => null),
        api.get<ProductRow[]>('/api/v1/products').catch(() => [] as ProductRow[]),
      ]);
      setPolicy(p);
      setChannels(c);
      setTanks(t);
      setDepots(ov ? ov.sites.filter((x) => x.kind === 'DEPOT') : []);
      setProducts(prods);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      showToast(done, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // "mm litres" per line, separators forgiving: space, tab, comma or semicolon.
  const points = calText
    .split('\n')
    .map((l) => l.trim().split(/[\s,;]+/).map(Number))
    .filter((x) => x.length >= 2 && x.every((n) => Number.isFinite(n)))
    .map(([dipMm, litres]) => ({ dipMm, litres }));
  const rising = points.every((p, i) => i === 0 || (p.dipMm > points[i - 1].dipMm && p.litres >= points[i - 1].litres));

  const box = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  const btn = { background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' };

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
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Administration</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          The settings that decide what counts as a problem.
        </p>
      </div>

      <div className="flex gap-2">
        {([['policy', 'Trading policy'], ['channels', 'Payment channels'], ['calibration', 'Tank calibration'], ['depot', 'Depot']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ background: tab === k ? 'var(--primary)' : 'var(--muted)', color: tab === k ? 'var(--primary-foreground)' : 'var(--foreground)' }}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'policy' && !policy && (
        <div className="rounded-xl border p-4" style={box}>
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            The trading policy is set by head office. This account can see its effects but not change it.
          </p>
        </div>
      )}

      {tab === 'policy' && policy && (
        <div className="rounded-xl border p-4 space-y-3" style={box}>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
            {POLICY_FIELDS.map(([key, label, help]) => (
              <label key={key} className="block text-xs">
                <span className="block font-semibold text-foreground">{label}</span>
                <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>{help}</span>
                <input type="number" min={0} step="any" className="input-field w-full"
                       value={String(policy[key] ?? '')}
                       onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <div className="space-y-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            {POLICY_FLAGS.map(([key, label, help]) => (
              <label key={key} className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={Boolean(policy[key])}
                       onChange={(e) => setPolicy({ ...policy, [key]: e.target.checked })} />
                <span><span className="font-semibold text-foreground">{label}</span>
                  <span style={{ color: 'var(--muted-foreground)' }}> - {help}</span></span>
              </label>
            ))}
          </div>
          <p className="text-xs pt-2 border-t" style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}>
            Also held in the policy, but not yet enforced by anything, so not offered here: {NOT_ENFORCED.join(' · ')}.
          </p>
          <IssueSummary issues={policyIssues} tried={policyTried} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold"
                  style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                  onClick={() => { setPolicyTried(true); if (hasErrors(policyIssues)) return; void run('Trading policy saved', () => api.put<unknown>('/api/admin/policy', policy)); }}>
            Save the policy
          </button>
        </div>
      )}

      {tab === 'channels' && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
          <div className="rounded-xl border p-4 space-y-1" style={box}>
            <h2 className="text-sm font-semibold text-foreground">In use</h2>
            {channels.map((c) => (
              <p key={c.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <span className="text-foreground">{c.name}</span> · {c.kind.toLowerCase().replace('_', ' ')}
                {c.tillNumber ? ` · till ${c.tillNumber}` : ''}
              </p>
            ))}
            {channels.length === 0 && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>None yet.</p>}
          </div>
          <div className="rounded-xl border p-4 space-y-2" style={box}>
            <h2 className="text-sm font-semibold text-foreground">Add a channel</h2>
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Code, e.g. MTN" className="input-field text-xs" value={chan.code} onChange={(e) => setChan({ ...chan, code: e.target.value })} />
              <input placeholder="Name, e.g. MTN Mobile Money" className="input-field text-xs" value={chan.name} onChange={(e) => setChan({ ...chan, name: e.target.value })} />
              <select className="input-field text-xs" value={chan.kind} onChange={(e) => setChan({ ...chan, kind: e.target.value })}>
                <option value="MOBILE_MONEY">Mobile money</option>
                <option value="CARD">Card terminal</option>
                <option value="VOUCHER">Fuel voucher</option>
              </select>
              <input placeholder="Merchant till number" className="input-field text-xs" value={chan.till} onChange={(e) => setChan({ ...chan, till: e.target.value })} />
            </div>
            <FormProblem msg={problems.p0} />
            <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                    onClick={() => {
      clearProblem('p0');
                      if (!chan.code.trim() || !chan.name.trim()) { flagProblem('p0', 'Code and name are needed'); return; }
                      void run(`${chan.name.trim()} added`, async () => {
                        await api.post<unknown>('/api/admin/channels', {
                          code: chan.code.trim().toUpperCase(), name: chan.name.trim(), kind: chan.kind,
                          tillNumber: chan.till.trim() || null,
                        }, { idempotencyKey: `channel-${chan.code.trim().toUpperCase()}` });
                        setChan({ code: '', name: '', kind: 'MOBILE_MONEY', till: '' });
                      });
                    }}>
              Add channel
            </button>
          </div>
        </div>
      )}

      {tab === 'depot' && (
        <div className="space-y-4">
          <div className="rounded-xl border p-4 space-y-2" style={box}>
            <h2 className="text-sm font-semibold text-foreground">
              {depots.length === 0 ? 'This company has no depot' : `Depots (${depots.length})`}
            </h2>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {depots.length === 0
                ? 'Most stations sell only at the pump. If the company also loads trucks in bulk from its own tanks, set the depot up here - the Depot screens appear once it exists.'
                : 'Each depot runs its own day: loads out, transfers to stations, and its own tank count.'}
            </p>
            {depots.map((d) => (
              <div key={d.id} className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <p className="text-xs font-semibold text-foreground">{d.name}</p>
                {tanks.filter((t) => t.site === d.name).map((t) => (
                  <p key={t.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {t.code} · {t.gradeCode} · {t.capacityLitres.toLocaleString()} L
                  </p>
                ))}
                {tanks.filter((t) => t.site === d.name).length === 0 && (
                  <p className="text-xs" style={{ color: '#F59E0B' }}>No tanks yet - add one below before it can trade.</p>
                )}
              </div>
            ))}
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
            <div className="rounded-xl border p-4 space-y-2" style={box}>
              <h2 className="text-sm font-semibold text-foreground">Set up a depot</h2>
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="Code, e.g. KBG-DEP" className="input-field text-xs" value={newDepot.code}
                       onChange={(e) => setNewDepot({ ...newDepot, code: e.target.value })} />
                <input placeholder="Name, e.g. Kiboga Depot" className="input-field text-xs" value={newDepot.name}
                       onChange={(e) => setNewDepot({ ...newDepot, name: e.target.value })} />
              </div>
              <input placeholder="Where it is (optional)" className="input-field w-full text-xs" value={newDepot.address}
                     onChange={(e) => setNewDepot({ ...newDepot, address: e.target.value })} />
              <FormProblem msg={problems.p1} />
              <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                      onClick={() => {
      clearProblem('p1');
                        if (!newDepot.code.trim() || !newDepot.name.trim()) { flagProblem('p1', 'A depot needs a code and a name'); return; }
                        void run(`${newDepot.name.trim()} set up - add its tanks next`, async () => {
                          await api.post<unknown>('/api/v1/organisation/depots', {
                            code: newDepot.code.trim(), name: newDepot.name.trim(), address: newDepot.address.trim() || null,
                          }, { idempotencyKey: `depot-${newDepot.code.trim().toUpperCase()}` });
                          setNewDepot({ code: '', name: '', address: '' });
                        });
                      }}>
                Set up depot
              </button>
            </div>

            {depots.length > 0 && (
              <div className="rounded-xl border p-4 space-y-2" style={box}>
                <h2 className="text-sm font-semibold text-foreground">Add a tank to a depot</h2>
                <div className="grid grid-cols-2 gap-2">
                  <select className="input-field text-xs" value={depTank.depotId} onChange={(e) => setDepTank({ ...depTank, depotId: e.target.value })}>
                    <option value="">Depot...</option>
                    {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <input placeholder="Tank code, e.g. BT1" className="input-field text-xs" value={depTank.code}
                         onChange={(e) => setDepTank({ ...depTank, code: e.target.value })} />
                  <select className="input-field text-xs" value={depTank.productId} onChange={(e) => setDepTank({ ...depTank, productId: e.target.value })}>
                    <option value="">Product...</option>
                    {products.map((x) => <option key={x.id} value={x.id}>{x.code} - {x.name}</option>)}
                  </select>
                  <input type="number" min={0} placeholder="Capacity (L)" className="input-field text-xs" value={depTank.capacity}
                         onChange={(e) => setDepTank({ ...depTank, capacity: e.target.value,
                           safeFill: depTank.safeFill || (Number(e.target.value) > 0 ? String(Math.round(Number(e.target.value) * 0.95)) : '') })} />
                  <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Safe fill (L)
                    <input type="number" min={0} className="input-field w-full text-xs mt-1" value={depTank.safeFill}
                           onChange={(e) => setDepTank({ ...depTank, safeFill: e.target.value })} />
                  </label>
                  <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Deepest dip (mm)
                    <input type="number" min={0} className="input-field w-full text-xs mt-1" value={depTank.depthMm}
                           onChange={(e) => setDepTank({ ...depTank, depthMm: e.target.value })} />
                  </label>
                  <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Dead stock (L)
                    <input type="number" min={0} className="input-field w-full text-xs mt-1" value={depTank.deadStock}
                           onChange={(e) => setDepTank({ ...depTank, deadStock: e.target.value })} />
                  </label>
                </div>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Safe fill starts at 95% of capacity, dead stock at 0, and the deepest dip at 3,000 mm - a bulk tank is often deeper. Correct all three from the tank&apos;s chart.
                </p>
                <FormProblem msg={problems.p2} />
                <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                        onClick={() => {
      clearProblem('p2');
                          const cap = Number(depTank.capacity), safe = Number(depTank.safeFill), dead = Number(depTank.deadStock);
                          if (!depTank.depotId || !depTank.code.trim() || !depTank.productId || !(cap > 0)) {
                            flagProblem('p2', 'Depot, tank code, product and capacity are all needed'); return;
                          }
                          if (!(safe > 0) || safe > cap || dead < 0 || dead >= safe) {
                            flagProblem('p2', 'Safe fill must be above dead stock and no more than capacity'); return;
                          }
                          void run('Depot tank added', async () => {
                            await api.post<unknown>(`/api/admin/tanks?site=${depTank.depotId}`, {
                              code: depTank.code.trim().toUpperCase(), productId: depTank.productId,
                              nominalLitres: cap, safeFill: safe, deadStock: dead, maxDipMm: Number(depTank.depthMm) || 3000,
                            }, { idempotencyKey: `deptank-${depTank.depotId}-${depTank.code.trim().toUpperCase()}` });
                            setDepTank({ depotId: depTank.depotId, code: '', productId: '', capacity: '', safeFill: '', deadStock: '0', depthMm: '3000' });
                          });
                        }}>
                  Add tank
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'calibration' && (
        <div className="rounded-xl border p-4 space-y-2" style={box}>
          <h2 className="text-sm font-semibold text-foreground">Load a calibration chart</h2>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            From the tank&apos;s own certificate: one line per reading, millimetres then litres.
            Every dip taken with a stick is converted through this chart.
          </p>
          <select className="input-field w-full text-xs" value={calTank} onChange={(e) => setCalTank(e.target.value)}>
            <option value="">Tank...</option>
            {tanks.map((t) => <option key={t.id} value={t.id}>{t.site} · {t.code} · {t.gradeCode} · {t.capacityLitres.toLocaleString()} L</option>)}
          </select>
          <textarea rows={8} className="input-field w-full text-xs font-mono" placeholder={'0 0\n100 412\n200 1180\n...'}
                    value={calText} onChange={(e) => setCalText(e.target.value)} />
          <p className="text-xs" style={{ color: points.length && !rising ? '#ef4444' : 'var(--muted-foreground)' }}>
            {points.length} reading(s) read.
            {points.length > 0 && !rising && ' They must rise: each depth deeper, and never fewer litres, than the one before.'}
          </p>
          <button disabled={busy || !calTank || points.length < 2 || !rising} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => void run('Calibration chart loaded', () =>
                    api.post<unknown>(`/api/ops/tanks/${calTank}/calibration`, points,
                      { idempotencyKey: `cal-${calTank}-${points.length}-${points[points.length - 1]?.litres}` }))}>
            Load chart
          </button>
        </div>
      )}
    </div>
  );
}
