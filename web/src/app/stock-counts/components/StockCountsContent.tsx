'use client';

import { businessToday } from '@/lib/dates';
import { FormProblem } from '@/components/ui/Issues';
import React, { useCallback, useEffect, useState } from 'react';

import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import type { DryCountLineView, DryItemView, StaffRow, StockCountLine, TankInventoryRow } from '@/types/api';

/**
 * The audited stock take.
 *
 * A daily dip reconciles a tank against its own shift. A STOCK COUNT is the
 * formal one: several tanks counted together, often witnessed, and -- once
 * posted -- the figure the ledger adjusts to. It is what makes a loss report
 * something that stands up in front of an auditor or a director.
 *
 * TWO PEOPLE, BY DESIGN. Supervisors and managers conduct the count; only an
 * accountant posts it to the ledger. The person who counted is not the person
 * who makes the count official. A manager pressing "Post" is refused, and the
 * screen says so before they try.
 *
 * The count in progress is remembered in this browser tab, so a refresh does
 * not lose it. Nothing about it lives only here -- every line is on the
 * server the moment it is saved.
 */
const WET_KEY = 'fcms-wet-count';
const DRY_KEY = 'fcms-dry-count';

function remember(key: string, id: string | null) {
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch {
    // a private window without storage: the count still exists on the server
  }
}
function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}


// The count against the book, said while it is typed. A difference is the
// point of counting, so it is a warning -- with a nudge to give the reason.
function CountNote({ raw, book, reason, unit, tol }: { raw?: string; book: number; reason?: string; unit: string; tol: number }) {
  if (raw === undefined || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return <p className="text-[11px] mt-0.5" style={{ color: '#ef4444' }}>✕ Not a count</p>;
  const d = v - book;
  if (Math.abs(d) <= tol) return null;
  return (
    <p className="text-[11px] mt-0.5" style={{ color: '#F59E0B' }}>
      ⚠ {d > 0 ? '+' : ''}{Math.round(d * 100) / 100} {unit} against the book{(reason ?? '').trim() ? '' : ' - say why in the reason box'}
    </p>
  );
}

export default function StockCountsContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const { showToast } = useToast();
  const [tab, setTab] = useState<'wet' | 'dry' | 'adjust'>('wet');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tanks, setTanks] = useState<TankInventoryRow[]>([]);
  const [items, setItems] = useState<DryItemView[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);

  // ---- wet ----
  const [wetId, setWetId] = useState<string | null>(null);
  const [wetKind, setWetKind] = useState('MONTHLY');
  const [wetTanks, setWetTanks] = useState<Record<string, boolean>>({});
  const [witness, setWitness] = useState('');
  const [wetLines, setWetLines] = useState<StockCountLine[]>([]);
  const [wetInput, setWetInput] = useState<Record<string, { litres: string; reason: string }>>({});

  // ---- dry ----
  const [dryId, setDryId] = useState<string | null>(null);
  const [scope, setScope] = useState('FULL');
  const [category, setCategory] = useState('');
  const [dryLines, setDryLines] = useState<DryCountLineView[]>([]);
  const [dryInput, setDryInput] = useState<Record<string, { qty: string; reason: string }>>({});

  // ---- adjust ----
  const [adj, setAdj] = useState({ itemId: '', qty: '', kind: 'DAMAGE_OUT', note: '' });

  const loadWetLines = useCallback(async (id: string) => {
    setWetLines(await api.get<StockCountLine[]>(`/api/ops/stock-counts/${id}/lines`));
  }, []);
  const loadDryLines = useCallback(async (id: string) => {
    setDryLines(await api.get<DryCountLineView[]>(`/api/dry-counts/${id}/lines`));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tk, it, st] = await Promise.all([
          api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
          api.get<DryItemView[]>('/api/dry-stock/items'),
          api.get<StaffRow[]>('/api/admin/staff').catch(() => [] as StaffRow[]),
        ]);
        if (cancelled) return;
        setTanks(tk);
        setItems(it);
        setStaff(st);
        const w = recall(WET_KEY);
        const d = recall(DRY_KEY);
        if (w) { setWetId(w); await loadWetLines(w).catch(() => remember(WET_KEY, null)); }
        if (d) { setDryId(d); await loadDryLines(d).catch(() => remember(DRY_KEY, null)); }
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError((e as ApiError).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadWetLines, loadDryLines]);

  const run = async (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      showToast(done, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  const btn = { background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' };
  const varColour = (v: number) => (Math.abs(v) < 0.5 ? 'var(--foreground)' : v < 0 ? '#ef4444' : '#F59E0B');

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
        <h1 className="text-xl font-semibold text-foreground">Stock counts</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          Counted by a supervisor or manager. Posted to the ledger by an accountant - two people, on purpose.
        </p>
      </div>

      <div className="flex gap-2">
        {([['wet', 'Fuel tanks'], ['dry', 'Shop and lubricants'], ['adjust', 'Adjustments']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ background: tab === k ? 'var(--primary)' : 'var(--muted)', color: tab === k ? 'var(--primary-foreground)' : 'var(--foreground)' }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── WET ── */}
      {tab === 'wet' && !wetId && (
        <div className="rounded-xl border p-4 space-y-3" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Start a tank count</h2>
          <select className="input-field text-xs" value={wetKind} onChange={(e) => setWetKind(e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="SURPRISE">Surprise</option>
            <option value="HANDOVER">Handover</option>
            <option value="ANNUAL">Annual</option>
          </select>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            {tanks.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={wetTanks[t.id] === true}
                       onChange={(e) => setWetTanks((p) => ({ ...p, [t.id]: e.target.checked }))} />
                <span>{t.site} · {t.code} · {t.gradeCode}</span>
              </label>
            ))}
          </div>
          <select className="input-field text-xs" value={witness} onChange={(e) => setWitness(e.target.value)}>
            <option value="">Witnessed by (optional)...</option>
            {staff.filter((s) => s.role.toUpperCase() !== 'ATTENDANT' && s.isActive).map((s) => (
              <option key={s.id} value={s.id}>{s.fullName} ({s.employeeNo})</option>
            ))}
          </select>
          <FormProblem msg={problems.p0} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => {
      clearProblem('p0');
                    const ids = Object.entries(wetTanks).filter(([, v]) => v).map(([k]) => k);
                    if (ids.length === 0) { flagProblem('p0', 'Choose the tanks being counted'); return; }
                    void run('Count started', async () => {
                      const r = await api.post<{ countId: string }>('/api/ops/stock-counts', {
                        kind: wetKind, tankIds: ids, witnessedBy: witness || null,
                      }, {
                        // Same kind, same tanks, same day: the same count. A
                        // retry must not open a second one beside it.
                        idempotencyKey: `wetcount-${wetKind}-${[...ids].sort().join('.')}-${businessToday()}`,
                      });
                      setWetId(r.countId);
                      remember(WET_KEY, r.countId);
                      await loadWetLines(r.countId);
                    });
                  }}>
            Start count
          </button>
        </div>
      )}

      {tab === 'wet' && wetId && (
        <div className="rounded-xl border overflow-x-auto" style={card}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--muted-foreground)' }}>
                {['Tank', 'Book', 'Counted', 'Variance', 'Reason', ''].map((h) => <th key={h} className="text-left p-3">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {wetLines.map((l) => (
                <tr key={l.tankId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3">{l.tankCode} · {l.productCode}</td>
                  <td className="p-3">{fmt(l.bookLitres)}</td>
                  <td className="p-3">
                    <input type="number" min={0} className="input-field w-28 text-right"
                           placeholder={l.countedLitres ? fmt(l.countedLitres) : 'Litres'}
                           value={wetInput[l.tankId]?.litres ?? ''}
                           onChange={(e) => setWetInput((p) => ({ ...p, [l.tankId]: { reason: p[l.tankId]?.reason ?? '', litres: e.target.value } }))} />
                    <CountNote raw={wetInput[l.tankId]?.litres} book={l.bookLitres} reason={wetInput[l.tankId]?.reason} unit="L" tol={Math.max(50, l.bookLitres * 0.005)} />
                  </td>
                  <td className="p-3 font-semibold" style={{ color: varColour(l.varianceLitres) }}>
                    {l.countedLitres ? fmt(l.varianceLitres) : '—'}
                  </td>
                  <td className="p-3">
                    <input className="input-field text-xs" placeholder="If it differs, why"
                           value={wetInput[l.tankId]?.reason ?? ''}
                           onChange={(e) => setWetInput((p) => ({ ...p, [l.tankId]: { litres: p[l.tankId]?.litres ?? '', reason: e.target.value } }))} />
                  </td>
                  <td className="p-3">
                    <FormProblem msg={problems[`p1:${l.tankId}`]} />
                    <button disabled={busy} className="px-2 py-1 rounded-lg font-semibold" style={btn}
                            onClick={() => {
      clearProblem(`p1:${l.tankId}`);
                              const v = Number(wetInput[l.tankId]?.litres);
                              if (!(v >= 0) || wetInput[l.tankId]?.litres === '') { flagProblem(`p1:${l.tankId}`, 'Enter the litres counted'); return; }
                              void run('Tank counted', async () => {
                                await api.post<unknown>(`/api/ops/stock-counts/${wetId}/tanks`, {
                                  tankId: l.tankId, productLitres: v,
                                  varianceReason: wetInput[l.tankId]?.reason.trim() || null,
                                }, { idempotencyKey: `wetline-${wetId}-${l.tankId}-${v}` });
                                await loadWetLines(wetId);
                              });
                            }}>
                      Save
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 p-3">
            <button disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-semibold"
                    style={{ background: '#22c55e', color: '#fff' }}
                    onClick={() => void run('Count posted to the ledger', async () => {
                      await api.post<unknown>(`/api/ops/stock-counts/${wetId}/post`, {});
                      setWetId(null); remember(WET_KEY, null); setWetLines([]); setWetInput({});
                    })}>
              Post to the ledger (accountant)
            </button>
            <button className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}
                    onClick={() => { setWetId(null); remember(WET_KEY, null); setWetLines([]); }}>
              Set aside
            </button>
          </div>
        </div>
      )}

      {/* ── DRY ── */}
      {tab === 'dry' && !dryId && (
        <div className="rounded-xl border p-4 space-y-3" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Start a shop count</h2>
          <div className="flex gap-2">
            <select className="input-field text-xs" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="FULL">Everything</option>
              <option value="CATEGORY">One category</option>
              <option value="SPOT">Spot check</option>
            </select>
            {scope === 'CATEGORY' && (
              <select className="input-field text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Category...</option>
                {['LUBRICANT', 'SHOP', 'TYRE', 'ACCESSORY', 'LPG'].map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
              </select>
            )}
          </div>
          <FormProblem msg={problems.p2} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => {
      clearProblem('p2');
                    if (scope === 'CATEGORY' && !category) { flagProblem('p2', 'Choose the category'); return; }
                    void run('Count started', async () => {
                      const r = await api.post<{ countId: string }>('/api/dry-counts', {
                        scope, category: scope === 'CATEGORY' ? category : null,
                      }, {
                        idempotencyKey: `drycount-${scope}-${category}-${businessToday()}`,
                      });
                      setDryId(r.countId);
                      remember(DRY_KEY, r.countId);
                      await loadDryLines(r.countId);
                    });
                  }}>
            Start count
          </button>
        </div>
      )}

      {tab === 'dry' && dryId && (
        <div className="rounded-xl border overflow-x-auto" style={card}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--muted-foreground)' }}>
                {['Item', 'Book', 'Counted', 'Variance', 'Reason', ''].map((h) => <th key={h} className="text-left p-3">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {dryLines.map((l) => (
                <tr key={l.itemId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3">{l.name} <span style={{ color: 'var(--muted-foreground)' }}>{l.sku}</span></td>
                  <td className="p-3">{fmt(l.bookQty)}</td>
                  <td className="p-3">
                    <input type="number" min={0} className="input-field w-24 text-right"
                           value={dryInput[l.itemId]?.qty ?? ''}
                           onChange={(e) => setDryInput((p) => ({ ...p, [l.itemId]: { reason: p[l.itemId]?.reason ?? '', qty: e.target.value } }))} />
                    <CountNote raw={dryInput[l.itemId]?.qty} book={l.bookQty} reason={dryInput[l.itemId]?.reason} unit="units" tol={0} />
                  </td>
                  <td className="p-3 font-semibold" style={{ color: varColour(l.varianceQty) }}>{fmt(l.varianceQty)}</td>
                  <td className="p-3">
                    <input className="input-field text-xs" placeholder="If it differs, why"
                           value={dryInput[l.itemId]?.reason ?? ''}
                           onChange={(e) => setDryInput((p) => ({ ...p, [l.itemId]: { qty: p[l.itemId]?.qty ?? '', reason: e.target.value } }))} />
                  </td>
                  <td className="p-3">
                    <FormProblem msg={problems[`p3:${l.itemId}`]} />
                    <button disabled={busy} className="px-2 py-1 rounded-lg font-semibold" style={btn}
                            onClick={() => {
      clearProblem(`p3:${l.itemId}`);
                              const q = Number(dryInput[l.itemId]?.qty);
                              if (!(q >= 0) || dryInput[l.itemId]?.qty === '') { flagProblem(`p3:${l.itemId}`, 'Enter the quantity counted'); return; }
                              void run('Item counted', async () => {
                                await api.post<unknown>(`/api/dry-counts/${dryId}/items`, {
                                  itemId: l.itemId, countedQty: q,
                                  varianceReason: dryInput[l.itemId]?.reason.trim() || null,
                                }, { idempotencyKey: `dryline-${dryId}-${l.itemId}-${q}` });
                                await loadDryLines(dryId);
                              });
                            }}>
                      Save
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 p-3">
            <button disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-semibold"
                    style={{ background: '#22c55e', color: '#fff' }}
                    onClick={() => void run('Count posted to the ledger', async () => {
                      await api.post<unknown>(`/api/dry-counts/${dryId}/post`, {});
                      setDryId(null); remember(DRY_KEY, null); setDryLines([]); setDryInput({});
                    })}>
              Post to the ledger (accountant)
            </button>
            <button className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}
                    onClick={() => { setDryId(null); remember(DRY_KEY, null); setDryLines([]); }}>
              Set aside
            </button>
          </div>
        </div>
      )}

      {/* ── ADJUSTMENTS ── */}
      {tab === 'adjust' && (
        <div className="rounded-xl border p-4 space-y-2 max-w-lg" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Adjust shop stock</h2>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Damage, expiry, own use, a customer return. Every one needs a note - an adjustment
            with no reason is how stock disappears on paper.
          </p>
          <select className="input-field w-full text-xs" value={adj.itemId} onChange={(e) => setAdj({ ...adj, itemId: e.target.value })}>
            <option value="">Item...</option>
            {items.map((i) => <option key={i.itemId} value={i.itemId}>{i.name} ({i.onHand} on hand)</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select className="input-field text-xs" value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}>
              <option value="DAMAGE_OUT">Damaged</option>
              <option value="EXPIRY_OUT">Expired</option>
              <option value="OWN_USE_OUT">Own use</option>
              <option value="CUSTOMER_RETURN_IN">Customer return</option>
              <option value="TRANSFER_IN">Transfer in</option>
              <option value="TRANSFER_OUT">Transfer out</option>
            </select>
            <input type="number" min={0} placeholder="Quantity" className="input-field text-xs"
                   value={adj.qty} onChange={(e) => setAdj({ ...adj, qty: e.target.value })} />
          </div>
          <input placeholder="Why" className="input-field w-full text-xs" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
          <FormProblem msg={problems.p4} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => {
      clearProblem('p4');
                    if (!adj.itemId || !(Number(adj.qty) > 0) || adj.note.trim().length < 5) {
                      flagProblem('p4', 'Item, quantity and a real reason are all needed'); return;
                    }
                    void run('Adjustment recorded', async () => {
                      await api.post<unknown>('/api/dry-stock/adjust', {
                        itemId: adj.itemId, qty: Number(adj.qty), kind: adj.kind, note: adj.note.trim(),
                      }, { submission: 'stock-adjustment' });
                      setItems(await api.get<DryItemView[]>('/api/dry-stock/items'));
                      setAdj({ itemId: '', qty: '', kind: 'DAMAGE_OUT', note: '' });
                    });
                  }}>
            Record adjustment
          </button>
        </div>
      )}
    </div>
  );
}
