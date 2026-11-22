'use client';

import { useCan } from '@/lib/useCan';
import { businessToday } from '@/lib/dates';
import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker } from '@/lib/checks';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import type { DeliveryView, ProfitStatement, SupplierBalanceRow } from '@/types/api';

/**
 * What the company owes its suppliers, and what it made.
 *
 * AN INVOICE IS TIED TO THE DELIVERIES IT BILLS. That link is the point: the
 * invoice charges for what the NOTE says was loaded, while the dips say what
 * actually arrived. With the deliveries beside it, the shortfall is on the
 * screen at the moment the invoice is entered -- which is when a claim
 * against the transporter has to be raised, not three weeks later.
 *
 * PAYMENTS go against the supplier's account. The balance is billed minus
 * paid, and an overdue supplier is flagged, because a supplier who stops
 * loading is a station that stops selling.
 *
 * THE PROFIT STATEMENT is the period's bottom line: fuel and shop margins,
 * then everything that erodes them -- expenses, stock loss, shortages not
 * recovered, discounts, fuel used in-house. It is computed by the server from
 * the ledger, not assembled here.
 */
export default function SuppliersContent() {
  const can = useCan();
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const { showToast } = useToast();
  const today = businessToday();
  const monthStart = today.slice(0, 8) + '01';

  const [suppliers, setSuppliers] = useState<SupplierBalanceRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [pl, setPl] = useState<ProfitStatement | null>(null);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newSup, setNewSup] = useState({ code: '', name: '', contact: '' });
  const [inv, setInv] = useState({ supplierId: '', invoiceNo: '', invoiceDate: today, dueDate: '', amount: '', notes: '' });
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const [pay, setPay] = useState({ supplierId: '', amount: '', method: 'BANK', reference: '', paidOn: today });

  const load = useCallback(async () => {
    try {
      const [s, d, p] = await Promise.all([
        api.get<SupplierBalanceRow[]>('/api/accounts/suppliers'),
        api.get<DeliveryView[]>('/api/deliveries?days=60'),
        api.get<ProfitStatement>(`/api/accounts/statement?from=${from}&to=${to}`),
      ]);
      setSuppliers(s);
      setDeliveries(d);
      setPl(p);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

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

  // The deliveries this supplier sent, newest first -- the ones an invoice
  // from them could be billing.
  const supplierName = suppliers.find((x) => x.supplierId === inv.supplierId)?.name ?? '';
  const candidates = useMemo(
    () => deliveries.filter((d) => !supplierName || !d.supplierName || d.supplierName === supplierName),
    [deliveries, supplierName],
  );
  const chosen = candidates.filter((d) => linked[d.id]);
  const shortfall = chosen.reduce((t, d) => t + Math.min(0, d.transitVariance ?? 0), 0);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  const btn = { background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' };

  // Above the early return: a hook after it runs on some renders and not others.
  // Paying a supplier more than is owed: a typo, or a prepayment worth meaning.
  const payIssues = useMemo(() => {
    const c = new Checker(); const sup = suppliers.find((x) => x.supplierId === pay.supplierId);
    c.required('supplier', pay.supplierId, 'The supplier');
    const amt = c.number('amount', pay.amount, 'The amount paid', { positive: true });
    if (amt !== null && sup && amt > Math.max(0, sup.balance))
      c.warn('amount', sup.balance > 0
        ? `UGX ${fmt(amt)} is more than the UGX ${fmt(sup.balance)} owed to ${sup.name} - the extra becomes a prepayment`
        : `Nothing is owed to ${sup.name} - this whole payment is a prepayment`);
    return c.issues;
  }, [pay, suppliers, fmt]);

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

  const owed = suppliers.reduce((t, x) => t + Math.max(0, x.balance), 0);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Suppliers</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          UGX {fmt(owed)} owed across {suppliers.length} supplier(s)
          {suppliers.some((s) => s.overdue) ? ' - some overdue' : ''}.
        </p>
      </div>

      {/* ── BALANCES ── */}
      <div className="rounded-xl border overflow-x-auto" style={card}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--muted-foreground)' }}>
              {['Supplier', 'Billed', 'Paid', 'Owed', 'Oldest invoice', 'Due'].map((h) => <th key={h} className="text-left p-3">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.supplierId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="p-3 text-foreground font-semibold">{s.name} <span className="font-normal" style={{ color: 'var(--muted-foreground)' }}>{s.code}</span></td>
                <td className="p-3">{fmt(s.billed)}</td>
                <td className="p-3">{fmt(s.paid)}</td>
                <td className="p-3 font-semibold" style={{ color: s.overdue ? '#ef4444' : 'var(--foreground)' }}>{fmt(s.balance)}</td>
                <td className="p-3">{s.oldestInvoice ?? '—'}</td>
                <td className="p-3" style={{ color: s.overdue ? '#ef4444' : 'var(--foreground)' }}>
                  {s.earliestDue ?? '—'}{s.overdue ? ' - overdue' : ''}
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center" style={{ color: 'var(--muted-foreground)' }}>No suppliers yet. Add one below.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        {/* ── AN INVOICE ── (only for those the server lets record one) */}
        {can('banking.record') && (
        <div className="rounded-xl border p-4 space-y-2" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Record an invoice</h2>
          <select className="input-field w-full text-xs" value={inv.supplierId}
                  onChange={(e) => { setInv({ ...inv, supplierId: e.target.value }); setLinked({}); }}>
            <option value="">Supplier...</option>
            {suppliers.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Invoice no." className="input-field text-xs" value={inv.invoiceNo} onChange={(e) => setInv({ ...inv, invoiceNo: e.target.value })} />
            <input type="number" min={0} placeholder="Amount" className="input-field text-xs" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} />
            <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Invoice date
              <input type="date" className="input-field w-full text-xs mt-1" value={inv.invoiceDate} onChange={(e) => setInv({ ...inv, invoiceDate: e.target.value })} />
            </label>
            <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Due
              <input type="date" className="input-field w-full text-xs mt-1" value={inv.dueDate} onChange={(e) => setInv({ ...inv, dueDate: e.target.value })} />
            </label>
          </div>
          <p className="text-xs pt-1" style={{ color: 'var(--muted-foreground)' }}>
            Which deliveries does it bill? The dips beside each one show what actually arrived.
          </p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {candidates.map((d) => (
              <label key={d.id} className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={linked[d.id] === true} onChange={(e) => setLinked((p) => ({ ...p, [d.id]: e.target.checked }))} />
                <span>
                  {d.deliveryNoteNo} · {d.truckReg ?? '—'} · note {fmt(d.loadedLitres)} L
                  {d.receivedLitres !== null && (
                    <>
                      {' '}· arrived {fmt(d.receivedLitres)} L
                      {d.transitVariance !== null && d.transitVariance < -0.5 && (
                        <span style={{ color: '#ef4444' }}> · short {fmt(-d.transitVariance)} L</span>
                      )}
                    </>
                  )}
                </span>
              </label>
            ))}
            {candidates.length === 0 && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No recent deliveries from this supplier.</p>}
          </div>
          {shortfall < -0.5 && (
            <p className="text-xs font-semibold" style={{ color: '#ef4444' }}>
              These loads arrived {fmt(-shortfall)} L short of their notes. The invoice charges for the notes -
              raise the claim now, while the dips are fresh.
            </p>
          )}
          <input placeholder="Notes" className="input-field w-full text-xs" value={inv.notes} onChange={(e) => setInv({ ...inv, notes: e.target.value })} />
          <FormProblem msg={problems.p0} />
          <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                  onClick={() => {
      clearProblem('p0');
                    if (!inv.supplierId || !inv.invoiceNo.trim() || !(Number(inv.amount) > 0)) {
                      flagProblem('p0', 'Supplier, invoice number and amount are needed'); return;
                    }
                    void run('Invoice recorded', () =>
                      api.post<unknown>('/api/accounts/invoices', {
                        supplierId: inv.supplierId, invoiceNo: inv.invoiceNo.trim(),
                        invoiceDate: inv.invoiceDate, dueDate: inv.dueDate || null,
                        amount: Number(inv.amount), notes: inv.notes.trim() || null,
                        deliveryIds: chosen.map((d) => d.id),
                      }, { idempotencyKey: `inv-${inv.supplierId}-${inv.invoiceNo.trim()}` }));
                  }}>
            Record invoice
          </button>
        </div>
        )}

        {/* ── A PAYMENT ── */}
        <div className="space-y-4">
          {can('banking.record') && (
          <div className="rounded-xl border p-4 space-y-2" style={card}>
            <h2 className="text-sm font-semibold text-foreground">Pay a supplier</h2>
            <select className="input-field w-full text-xs" value={pay.supplierId} onChange={(e) => setPay({ ...pay, supplierId: e.target.value })}>
              <option value="">Supplier...</option>
              {suppliers.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.name} - owed {fmt(s.balance)}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min={0} placeholder="Amount" className="input-field text-xs" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              <select className="input-field text-xs" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                <option value="BANK">Bank transfer</option>
                <option value="CASH">Cash</option>
                <option value="MOBILE_MONEY">Mobile money</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CONTRA">Contra</option>
              </select>
              <input placeholder="Reference" className="input-field text-xs" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
              <input type="date" className="input-field text-xs" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            </div>
            <FormProblem msg={problems.p1} />
            <IssueSummary issues={payIssues} tried={false} />
            <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                    onClick={() => {
      clearProblem('p1');
                      if (!pay.supplierId || !(Number(pay.amount) > 0)) { flagProblem('p1', 'Supplier and amount are needed'); return; }
                      void run('Payment recorded', () =>
                        api.post<unknown>('/api/accounts/supplier-payments', {
                          supplierId: pay.supplierId, invoiceId: null, amount: Number(pay.amount),
                          method: pay.method, reference: pay.reference.trim() || null, paidOn: pay.paidOn,
                        }, { submission: 'supplier-payment' }));
                    }}>
              Record payment
            </button>
          </div>
          )}

          {can('equipment.manage') && (
          <div className="rounded-xl border p-4 space-y-2" style={card}>
            {/* SEPARATED ON PURPOSE. Adding a supplier needs head office or admin
                authority; the accountant who PAYS suppliers cannot CREATE them.
                Whoever can both add a payee and pay it can invent a supplier and
                pay themselves -- the classic fraud this separation exists to stop. */}
            <h2 className="text-sm font-semibold text-foreground">Add a supplier (head office)</h2>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Kept apart from paying them: whoever can add a payee should not also pay it.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Code" className="input-field text-xs" value={newSup.code} onChange={(e) => setNewSup({ ...newSup, code: e.target.value })} />
              <input placeholder="Name" className="input-field text-xs" value={newSup.name} onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} />
            </div>
            <input placeholder="Contact (optional)" className="input-field w-full text-xs" value={newSup.contact} onChange={(e) => setNewSup({ ...newSup, contact: e.target.value })} />
            <FormProblem msg={problems.p2} />
            <button disabled={busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={btn}
                    onClick={() => {
      clearProblem('p2');
                      if (!newSup.code.trim() || !newSup.name.trim()) { flagProblem('p2', 'Code and name are needed'); return; }
                      void run(`${newSup.name.trim()} added`, async () => {
                        await api.post<unknown>('/api/admin/suppliers', {
                          code: newSup.code.trim().toUpperCase(), name: newSup.name.trim(), contact: newSup.contact.trim() || null,
                        }, { idempotencyKey: `sup-${newSup.code.trim().toUpperCase()}` });
                        setNewSup({ code: '', name: '', contact: '' });
                      });
                    }}>
              Add supplier
            </button>
          </div>
          )}
        </div>
      </div>

      {/* ── THE BOTTOM LINE ── */}
      {pl && (
        <div className="rounded-xl border p-4 space-y-3" style={card}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Profit statement</h2>
            <div className="flex gap-2">
              <input type="date" className="input-field text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
              <input type="date" className="input-field text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {pl.uncostedFuelLitres > 0 && (
            <p role="alert" className="text-xs rounded-lg border p-2" style={{ borderColor: '#F59E0B', color: '#F59E0B' }}>
              ⚠ {fmt(pl.uncostedFuelLitres)} L sold this period have no recorded cost, so they are NOT in fuel cost below -
              the margin is overstated by their value. Record the tank&apos;s opening balance or delivery cost.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {([
                  ['Fuel revenue', pl.fuelRevenue, false], ['Fuel cost', -pl.fuelCost, false], ['Fuel margin', pl.fuelMargin, true],
                  ['Shop revenue', pl.shopRevenue, false], ['Shop cost', -pl.shopCost, false], ['Shop margin', pl.shopMargin, true],
                  ['Gross margin', pl.grossMargin, true],
                  ['Expenses', -pl.expenses, false], ['Stock loss', -pl.stockLossValue, false],
                  ['Shortages not recovered', -(pl.shortagesRaised - pl.shortagesRecovered), false],
                  ['Discounts given', -pl.discountsGiven, false], ['Fuel used in-house', -pl.ownUseCost, false],
                  ['Lost in transit (paid for, never received)', -pl.transitLossValue, false],
                  ['Net position', pl.netPosition, true],
                ] as [string, number, boolean][]).map(([k, v, strong]) => (
                  <tr key={k} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className={`p-2 ${strong ? 'font-semibold text-foreground' : ''}`} style={strong ? undefined : { color: 'var(--muted-foreground)' }}>{k}</td>
                    <td className={`p-2 text-right ${strong ? 'font-bold' : ''}`} style={{ color: v < 0 && strong ? '#ef4444' : 'var(--foreground)' }}>
                      UGX {fmt(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pl.expenseBreakdown.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Expenses by category: {pl.expenseBreakdown.map((c) => `${c.category.toLowerCase().replace('_', ' ')} ${fmt(c.amount)}`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
