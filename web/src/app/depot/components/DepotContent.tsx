'use client';

import { useCan } from '@/lib/useCan';
import { businessToday } from '@/lib/dates';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { Checker, errorCount, fieldStyle, hasErrors } from '@/lib/checks';
import type { Issue } from '@/lib/checks';
import { IssueSummary } from '@/components/ui/Issues';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import type {
  BelowCostRow,
  BulkSaleRow,
  CustomerView,
  DashboardOverview,
  DepotDayRow,
  SiteOverviewRow,
  TankInventoryRow,
  TransferRow,
} from '@/types/api';

/**
 * The depot's working day.
 *
 * This replaced a template screen that read one statement and refused every
 * save -- a depot could be looked at but not run. A depot works differently
 * from a station, so it is laid out around the depot's own day:
 *
 *   OPEN THE DAY with a dip on every tank. Bulk trading is measured tank by
 *   tank, and a depot day with no opening dip cannot be reconciled.
 *
 *   LOADS OUT are bulk sales to trade customers, BILLED ON ONE FIGURE: the
 *   meter or the dip. Which one is part of the deal, and the database refuses
 *   a sale whose chosen basis has no figure behind it. The COST travels with
 *   each load, so a load sold below cost is visible the moment it is made --
 *   one such load can erase a month of retail margin.
 *
 *   TRANSFERS move fuel from the depot to a station at cost, so the station's
 *   margin is measured against what the fuel actually cost the company.
 *
 *   CLOSE THE DAY with closing dips. The close is PREVIEWED first: the server
 *   runs it, reports what it would do, and rolls back -- the same discipline
 *   as a station close.
 */
export default function DepotContent() {
  const can = useCan();
  const [partial, setPartial] = useState<string[]>([]);
  const { showToast } = useToast();
  const today = businessToday();
  const monthStart = today.slice(0, 8) + '01';

  const [depots, setDepots] = useState<SiteOverviewRow[]>([]);
  const [depotId, setDepotId] = useState('');
  const [day, setDay] = useState<DepotDayRow | null>(null);
  const [tanks, setTanks] = useState<TankInventoryRow[]>([]);
  const [allTanks, setAllTanks] = useState<TankInventoryRow[]>([]);
  const [customers, setCustomers] = useState<CustomerView[]>([]);
  const [loads, setLoads] = useState<BulkSaleRow[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [belowCost, setBelowCost] = useState<BelowCostRow[]>([]);
  const [history, setHistory] = useState<DepotDayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openDips, setOpenDips] = useState<Record<string, string>>({});
  const [closeDips, setCloseDips] = useState<Record<string, string>>({});
  const [closeNote, setCloseNote] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [sale, setSale] = useState({
    tankId: '', customerId: '', invoiceNo: '', truckReg: '', driverName: '', destination: '',
    basis: 'METER', litres: '', unitPrice: '', terms: 'CREDIT', seals: '',
  });
  const [xfer, setXfer] = useState({ reference: '', fromTankId: '', toTankId: '', litres: '', truckReg: '' });

  const depot = depots.find((d) => d.id === depotId);

  // Find the depots ONCE, and choose the first. This used to happen inside
  // load(): setting the default depot changed load's dependencies, which ran
  // the whole load a second time -- seven requests, twice, on every open.
  useEffect(() => {
    let cancelled = false;
    api.get<DashboardOverview>('/api/v1/dashboard/overview')
      .then((ov) => {
        if (cancelled) return;
        const ds = ov.sites.filter((x) => x.kind === 'DEPOT');
        setDepots(ds);
        setDepotId((cur) => cur || ds[0]?.id || '');
        if (ds.length === 0) setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError((e as ApiError).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!depotId) return;
    try {
      const name = depots.find((d) => d.id === depotId)?.name ?? '';
      const [current, tk, cs, ld, tr, bc, hs] = await Promise.all([
        api.get<DepotDayRow | undefined>(`/api/depot/day/current?site=${depotId}`),
        api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
        api.get<CustomerView[]>('/api/credit/customers').catch(() => { setPartial((x) => (x.includes('customers and their credit') ? x : [...x, 'customers and their credit'])); return [] as CustomerView[]; }),
        api.get<BulkSaleRow[]>(`/api/depot/bulk-sales?from=${today}&to=${today}`),
        api.get<TransferRow[]>('/api/depot/transfers?days=7'),
        api.get<BelowCostRow[]>(`/api/depot/below-cost?from=${monthStart}&to=${today}`),
        api.get<DepotDayRow[]>(`/api/depot/day/history?site=${depotId}&days=14`),
      ]);
      setDay(current ?? null);
      setAllTanks(tk);
      setTanks(tk.filter((t) => t.site === name));
      setCustomers(cs);
      setLoads(ld);
      setTransfers(tr);
      setBelowCost(bc);
      setHistory(hs);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [depotId, depots, today, monthStart]);

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

  // Every tank, 0 included. This kept only dips above zero, dropping a blank
  // tank silently and making an empty one impossible to record.
  const undipped = (m: Record<string, string>) =>
    tanks.filter((t) => !(m[t.id] !== undefined && m[t.id].trim() !== '' && Number.isFinite(Number(m[t.id]))));
  const missingMsg = (m: Record<string, string>) =>
    `Dip every tank - ${undipped(m).map((t) => t.code).join(', ')} ${undipped(m).length === 1 ? 'has' : 'have'} none. An empty tank is dipped as 0.`;
  const dipsFrom = (m: Record<string, string>) =>
    tanks
      .map((t) => ({
        tankId: t.id, productLitres: Number(m[t.id]),
        waterLitres: null, dipMm: null, waterDipMm: null, varianceReason: null,
      }));

  // Declared before the checks below, which call it while rendering.
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  // ---- what is missing or does not add up, form by form ----
  const [tried, setTried] = useState<Record<string, boolean>>({});
  const tryForm = (k: string) => setTried((t) => ({ ...t, [k]: true }));
  const dipIssues = (m: Record<string, string>, when: string): Issue[] => {
    const c = new Checker();
    for (const t of tanks) {
      const f = `dip:${t.id}`;
      const v = c.number(f, m[t.id], `${t.code}: the ${when} dip (0 if empty)`, { min: 0 });
      if (v === null) continue;
      if (v > t.capacityLitres) { c.error(f, `${t.code}: ${v.toLocaleString()} L is more than the tank holds (${t.capacityLitres.toLocaleString()} L)`); continue; }
      if (v > t.safeFill) c.warn(f, `${t.code}: above its safe fill of ${t.safeFill.toLocaleString()} L`);
      const diff = v - t.currentLitres;
      if (Math.abs(diff) > Math.max(100, t.capacityLitres * 0.005))
        c.warn(f, `${t.code}: ${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()} L against the book (${Math.round(t.currentLitres).toLocaleString()} L) - re-dip; at depot volumes this is a lot of fuel`);
    }
    return c.issues;
  };
  const depotIssues = useMemo(() => {
    const out: Record<string, Issue[]> = { open: dipIssues(openDips, 'opening'), close: dipIssues(closeDips, 'closing') };
    { // a load out
      const c = new Checker(); const tk = tanks.find((t) => t.id === sale.tankId); const cust = customers.find((x) => x.id === sale.customerId);
      c.required('tank', sale.tankId, 'The tank'); c.required('customer', sale.customerId, 'The customer');
      c.required('invoice', sale.invoiceNo, 'The invoice number'); c.required('truck', sale.truckReg, 'The truck');
      const l = c.number('litres', sale.litres, sale.basis === 'METER' ? 'The metered litres' : 'The dipped litres', { positive: true });
      const pr = c.number('price', sale.unitPrice, 'The price per litre', { positive: true });
      if (l !== null && tk && l > tk.currentLitres) c.error('litres', `${tk.code} holds ${Math.round(tk.currentLitres).toLocaleString()} L on the book - this load is more than that`);
      if (l !== null && pr !== null && cust && sale.terms === 'CREDIT' && l * pr > cust.headroom)
        c.warn('customer', `UGX ${fmt(l * pr)} is over ${cust.name}'s credit left (UGX ${fmt(Math.max(0, cust.headroom))}) - it will be flagged`);
      out.load = c.issues;
    }
    { // a transfer to a station
      const c = new Checker(); const from = tanks.find((t) => t.id === xfer.fromTankId); const to = allTanks.find((t) => t.id === xfer.toTankId);
      c.required('reference', xfer.reference, 'The reference');
      c.required('from', xfer.fromTankId, 'The depot tank'); c.required('to', xfer.toTankId, 'The station tank');
      const l = c.number('litres', xfer.litres, 'The litres', { positive: true });
      if (l !== null && from && l > from.currentLitres) c.error('litres', `${from.code} holds ${Math.round(from.currentLitres).toLocaleString()} L - not ${l.toLocaleString()}`);
      if (l !== null && to && to.currentLitres + l > to.capacityLitres)
        c.error('litres', `${to.site} ${to.code} has room for ${Math.max(0, Math.round(to.capacityLitres - to.currentLitres)).toLocaleString()} L - this would overfill it`);
      else if (l !== null && to && to.currentLitres + l > to.safeFill) c.warn('litres', `Takes ${to.site} ${to.code} above its safe fill`);
      out.xfer = c.issues;
    }
    return out;
  }, [tanks, allTanks, customers, openDips, closeDips, sale, xfer, dipIssues, fmt]);
  const gate = (k: string): boolean => {
    tryForm(k);
    if (hasErrors(depotIssues[k])) { showToast(`Fix the ${errorCount(depotIssues[k])} thing(s) marked in red`, 'error'); return false; }
    return true;
  };

  const stationTanks = useMemo(() => allTanks.filter((t) => t.site !== depot?.name), [allTanks, depot]);
  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
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
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load the depot</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }
  if (depots.length === 0) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold text-foreground">No depot in this company</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          Head office sets one up in Administration, under Depot.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Depot</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            {day ? `Day open since ${new Date(day.openedAt).toLocaleTimeString()}` : 'The depot day is closed.'}
          </p>
        </div>
        {depots.length > 1 && (
          <select className="input-field text-xs" value={depotId} onChange={(e) => setDepotId(e.target.value)}>
            {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>

      {/* ── THE DAY ── */}
      {/* Only someone the server lets open a day is offered the form. */}
      {!day && can('shift.open') && (
        <div className="rounded-xl border p-4 space-y-3" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Open the depot day</h2>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Dip every tank first. A day with no opening dip cannot be reconciled.
          </p>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
            {tanks.map((t) => (
              <label key={t.id} className="flex items-center justify-between gap-2 text-xs">
                <span>{t.code} · {t.gradeCode}</span>
                <input type="number" min={0} placeholder="Litres" className="input-field w-28 text-right"
                       style={fieldStyle(depotIssues.open, `dip:${t.id}`, !!tried.open)} value={openDips[t.id] ?? ''} onChange={(e) => setOpenDips((p) => ({ ...p, [t.id]: e.target.value }))} />
              </label>
            ))}
          </div>
          <IssueSummary issues={depotIssues.open} tried={!!tried.open} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => {
                    if (!gate('open')) return;
                    const dips = dipsFrom(openDips);
                    void run('Depot day opened', () =>
                      api.post<unknown>('/api/depot/day/open', { siteId: depotId, dips },
                        { idempotencyKey: `depot-open-${depotId}-${today}` }));
                  }}>
            Open the day
          </button>
        </div>
      )}

      {day && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            {[
              ['Loads out', `${day.loads}`],
              ['Litres out', `${fmt(day.litresOut)} L`],
              ['Revenue', `UGX ${fmt(day.revenue)}`],
              ['Margin', `UGX ${fmt(day.margin)}`],
              ['Below cost', `${day.loadsBelowCost}`],
              ['Transferred', `${fmt(day.transferLitres)} L`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border p-3" style={card}>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{k}</p>
                <p className="text-sm font-bold mt-1"
                   style={{ color: k === 'Below cost' && day.loadsBelowCost > 0 ? '#ef4444' : k === 'Margin' && day.margin < 0 ? '#ef4444' : 'var(--foreground)' }}>
                  {v}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
            {/* ── A LOAD OUT ── */}
            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Record a load</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                A bulk sale to a trade customer, billed on the meter or the dip - whichever the deal says.
              </p>
              <select className="input-field w-full text-xs" value={sale.tankId} onChange={(e) => setSale({ ...sale, tankId: e.target.value })}>
                <option value="">From tank...</option>
                {tanks.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.gradeCode} · {fmt(t.currentLitres)} L</option>)}
              </select>
              <select className="input-field w-full text-xs" value={sale.customerId} onChange={(e) => setSale({ ...sale, customerId: e.target.value })}>
                <option value="">Customer...</option>
                {/* Remaining credit shown BEFORE loading -- the only point where going
                    over the limit can still be prevented. It now includes what the
                    customer owes at the depot as well as the pump (migration 440). */}
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} - credit left {fmt(Math.max(0, c.headroom))}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="Invoice no." className="input-field text-xs" value={sale.invoiceNo} onChange={(e) => setSale({ ...sale, invoiceNo: e.target.value })} />
                <input placeholder="Truck reg" className="input-field text-xs" value={sale.truckReg} onChange={(e) => setSale({ ...sale, truckReg: e.target.value })} />
                <input placeholder="Driver" className="input-field text-xs" value={sale.driverName} onChange={(e) => setSale({ ...sale, driverName: e.target.value })} />
                <input placeholder="Destination" className="input-field text-xs" value={sale.destination} onChange={(e) => setSale({ ...sale, destination: e.target.value })} />
                <select className="input-field text-xs" value={sale.basis} onChange={(e) => setSale({ ...sale, basis: e.target.value })}>
                  <option value="METER">Billed on the meter</option>
                  <option value="DIP">Billed on the dip</option>
                </select>
                <input type="number" min={0} placeholder={sale.basis === 'METER' ? 'Metered litres' : 'Dipped litres'}
                       className="input-field text-xs" value={sale.litres} onChange={(e) => setSale({ ...sale, litres: e.target.value })} />
                <input type="number" min={0} placeholder="Price per litre" className="input-field text-xs" value={sale.unitPrice} onChange={(e) => setSale({ ...sale, unitPrice: e.target.value })} />
                <select className="input-field text-xs" value={sale.terms} onChange={(e) => setSale({ ...sale, terms: e.target.value })}>
                  <option value="CREDIT">On account</option>
                  <option value="CASH">Cash</option>
                  <option value="PREPAID">Prepaid</option>
                </select>
              </div>
              {(() => {
                const cust = customers.find((c) => c.id === sale.customerId);
                const amount = Number(sale.litres) * Number(sale.unitPrice);
                return cust && sale.terms === 'CREDIT' && amount > 0 && amount > cust.headroom ? (
                  <p className="text-xs font-semibold" style={{ color: '#ef4444' }}>
                    This load of UGX {fmt(amount)} is over {cust.name}&apos;s remaining credit of UGX {fmt(Math.max(0, cust.headroom))}.
                    It will be recorded and flagged - decide before the truck is loaded.
                  </p>
                ) : null;
              })()}
              <input placeholder="Seal numbers, comma separated" className="input-field w-full text-xs" value={sale.seals} onChange={(e) => setSale({ ...sale, seals: e.target.value })} />
              <IssueSummary issues={depotIssues.load} tried={!!tried.load} />
              <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                      onClick={() => {
                        const litres = Number(sale.litres); const price = Number(sale.unitPrice);
                        if (!gate('load')) return;
                        void run('Load recorded', () =>
                          api.post<unknown>('/api/depot/bulk-sales', {
                            tankId: sale.tankId, customerId: sale.customerId,
                            invoiceNo: sale.invoiceNo.trim(), truckReg: sale.truckReg.trim().toUpperCase(),
                            driverName: sale.driverName.trim() || null, destination: sale.destination.trim() || null,
                            // The figure for the chosen basis only. A sale billed on
                            // the dip with no dip behind it is refused.
                            meteredLitres: sale.basis === 'METER' ? litres : null,
                            dippedLitres: sale.basis === 'DIP' ? litres : null,
                            basis: sale.basis, unitPrice: price, paymentTerms: sale.terms,
                            sealNumbers: sale.seals.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
                          }, { idempotencyKey: `bulk-${sale.invoiceNo.trim()}` }));
                      }}>
                Record load
              </button>
            </div>

            {/* ── A TRANSFER ── */}
            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Transfer to a station</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Moved at cost, so the station&apos;s margin is measured against what the fuel really cost.
              </p>
              <input placeholder="Reference" className="input-field w-full text-xs" value={xfer.reference} onChange={(e) => setXfer({ ...xfer, reference: e.target.value })} />
              <select className="input-field w-full text-xs" value={xfer.fromTankId} onChange={(e) => setXfer({ ...xfer, fromTankId: e.target.value })}>
                <option value="">From depot tank...</option>
                {tanks.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.gradeCode}</option>)}
              </select>
              <select className="input-field w-full text-xs" value={xfer.toTankId} onChange={(e) => setXfer({ ...xfer, toTankId: e.target.value })}>
                <option value="">To station tank...</option>
                {stationTanks
                  .filter((t) => !xfer.fromTankId || t.gradeCode === tanks.find((d) => d.id === xfer.fromTankId)?.gradeCode)
                  .map((t) => <option key={t.id} value={t.id}>{t.site} · {t.code} · {t.gradeCode}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min={0} placeholder="Litres" className="input-field text-xs" value={xfer.litres} onChange={(e) => setXfer({ ...xfer, litres: e.target.value })} />
                <input placeholder="Truck reg" className="input-field text-xs" value={xfer.truckReg} onChange={(e) => setXfer({ ...xfer, truckReg: e.target.value })} />
              </div>
              <IssueSummary issues={depotIssues.xfer} tried={!!tried.xfer} />
              <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                      onClick={() => {
                        if (!gate('xfer')) return;
                        void run('Transfer recorded', () =>
                          api.post<unknown>('/api/depot/transfers', {
                            reference: xfer.reference.trim(), fromTankId: xfer.fromTankId, toTankId: xfer.toTankId,
                            litres: Number(xfer.litres), truckReg: xfer.truckReg.trim().toUpperCase() || null,
                          }, { idempotencyKey: `xfer-${xfer.reference.trim()}` }));
                      }}>
                Record transfer
              </button>
            </div>
          </div>

          {/* ── CLOSE THE DAY ── */}
          <div className="rounded-xl border p-4 space-y-3" style={card}>
            <h2 className="text-sm font-semibold text-foreground">Close the depot day</h2>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
              {tanks.map((t) => (
                <label key={t.id} className="flex items-center justify-between gap-2 text-xs">
                  <span>{t.code} · {t.gradeCode} closing</span>
                  <input type="number" min={0} placeholder="Litres" className="input-field w-28 text-right"
                         style={fieldStyle(depotIssues.close, `dip:${t.id}`, !!tried.close)} value={closeDips[t.id] ?? ''} onChange={(e) => { setCloseDips((p) => ({ ...p, [t.id]: e.target.value })); setPreview(null); }} />
                </label>
              ))}
            </div>
            <input placeholder="Note (optional)" className="input-field w-full text-xs" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            <IssueSummary issues={depotIssues.close} tried={!!tried.close} />
            <div className="grid grid-cols-2 gap-2">
              <button disabled={busy} className="py-2 rounded-lg text-xs font-semibold" style={btn}
                      onClick={async () => {
                        
                        if (!gate('close')) return;
                        setBusy(true);
                        try {
                          // Runs the real close and rolls it back.
                          const r = await api.post<unknown>(`/api/depot/day/${day.shiftId}/close?preview=true`, {
                            dips: dipsFrom(closeDips), reason: 'SCHEDULED', note: closeNote.trim() || null,
                          });
                          setPreview(JSON.stringify(r, null, 2));
                        } catch (e) {
                          showToast((e as ApiError).message, 'error');
                        } finally {
                          setBusy(false);
                        }
                      }}>
                Check the close
              </button>
              <button disabled={busy || preview === null} className="py-2 rounded-lg text-xs font-semibold"
                      style={{ background: preview === null ? 'var(--muted)' : '#22c55e', color: preview === null ? 'var(--muted-foreground)' : '#fff' }}
                      onClick={() => {
                        if (!gate('close')) return;
                        void run('Depot day closed', () =>
                        api.post<unknown>(`/api/depot/day/${day.shiftId}/close`, {
                          dips: dipsFrom(closeDips), reason: 'SCHEDULED', note: closeNote.trim() || null,
                        }, { idempotencyKey: `depot-close-${day.shiftId}` }));
                      }}>
                Close the day
              </button>
            </div>
            {preview && (
              <pre className="text-xs p-3 rounded-lg overflow-x-auto" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                {preview}
              </pre>
            )}
          </div>
        </>
      )}

      {/* ── WHAT HAPPENED ── */}
      <div className="rounded-xl border overflow-x-auto" style={card}>
        <h2 className="text-sm font-semibold text-foreground p-3">Loads today</h2>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--muted-foreground)' }}>
              {['Invoice', 'Customer', 'Truck', 'Grade', 'Litres', 'Basis', 'Price', 'Cost', 'Amount', 'Terms'].map((h) => (
                <th key={h} className="text-left p-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loads.map((l) => {
              const loss = l.unitCost !== null && l.unitPrice < l.unitCost;
              return (
                <tr key={l.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3">{l.invoiceNo}</td>
                  <td className="p-3">{l.customerName}</td>
                  <td className="p-3">{l.truckReg}</td>
                  <td className="p-3">{l.productCode}</td>
                  <td className="p-3">{fmt(l.litres)}</td>
                  <td className="p-3">{l.basis}</td>
                  <td className="p-3" style={{ color: loss ? '#ef4444' : 'var(--foreground)' }}>{fmt(l.unitPrice)}</td>
                  <td className="p-3">{l.unitCost === null ? '—' : fmt(l.unitCost)}</td>
                  <td className="p-3">{fmt(l.amount)}</td>
                  <td className="p-3">{l.paymentTerms}</td>
                </tr>
              );
            })}
            {loads.length === 0 && (
              <tr><td colSpan={10} className="p-6 text-center" style={{ color: 'var(--muted-foreground)' }}>No loads today.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {belowCost.length > 0 && (
        <div className="rounded-xl border p-4 space-y-1" style={{ ...card, borderColor: '#ef4444' }}>
          <h2 className="text-sm font-semibold" style={{ color: '#ef4444' }}>Sold below cost this month</h2>
          <p className="text-xs mb-1" style={{ color: 'var(--muted-foreground)' }}>
            One load below cost can erase a month of retail margin.
          </p>
          {belowCost.map((b) => (
            <p key={b.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              <span className="text-foreground">{b.invoiceNo}</span> · {b.customerName} · {fmt(b.litres)} L {b.productCode}
              {' '}at {fmt(b.unitPrice)} against cost {fmt(b.unitCost)} · <span style={{ color: '#ef4444' }}>UGX {fmt(b.margin)}</span>
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="rounded-xl border p-4 space-y-1" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Transfers, last 7 days</h2>
          {transfers.map((t) => (
            <p key={t.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              <span className="text-foreground">{t.reference}</span> · {fmt(t.litres)} L {t.productCode} · {t.fromTank} → {t.toSite} {t.toTank}
              {' '}· UGX {fmt(t.value)} at cost
            </p>
          ))}
          {transfers.length === 0 && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>None.</p>}
        </div>
        <div className="rounded-xl border p-4 space-y-1" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Recent depot days</h2>
          {history.map((h) => (
            <p key={h.shiftId} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              <span className="text-foreground">{h.businessDate}</span> · {h.loads} loads · {fmt(h.litresOut)} L
              {' '}· margin <span style={{ color: h.margin < 0 ? '#ef4444' : 'var(--foreground)' }}>UGX {fmt(h.margin)}</span>
              {h.state !== 'OPEN' ? '' : ' · open'}
            </p>
          ))}
          {history.length === 0 && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No depot days yet.</p>}
        </div>
      </div>
      <PartialLoadNotice missing={partial} />
    </div>
  );
}
