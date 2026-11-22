'use client';

/**
 * Agreed prices for one credit customer (migration 600).
 *
 * A transporter may pay a premium for credit; a bulk buyer may pay below the
 * pump. The customer is billed the agreed price on every credit sale while it
 * is in force. The attendant still answers for the pump value, and the close
 * settles the difference on its own line, so their cash-up balances either way.
 *
 * Set by a manager or head office. Never edited: agreeing a new price ends
 * the old one at the same moment, and an ended agreement stays on the list.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Checker, fieldStyle, hasErrors } from '@/lib/checks';
import { FieldIssues, IssueSummary } from '@/components/ui/Issues';
import { useToast } from '@/components/ui/Toast';
import type { CustomerPriceRow, ProductRow } from '@/types/api';

const fmt = (n: number) => n.toLocaleString('en-UG', { maximumFractionDigits: 2 });
const when = (iso: string) => new Date(iso).toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' });

export default function CustomerPricesModal({ customerId, customerName, onClose }:
  { customerId: string; customerName: string; onClose: () => void }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<CustomerPriceRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [form, setForm] = useState({ productId: '', kind: 'margin' as 'margin' | 'fixed', value: '', reason: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api.get<CustomerPriceRow[]>(`/api/credit/customers/${customerId}/prices`),
        api.get<ProductRow[]>('/api/v1/products'),
      ]);
      setRows(r);
      setProducts(p.filter((x) => x.isActive));
      setError('');
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [customerId]);
  useEffect(() => { void load(); }, [load]);

  const pump = products.find((p) => p.id === form.productId)?.pumpPrice ?? null;

  const issues = useMemo(() => {
    const c = new Checker();
    c.required('productId', form.productId, 'The product');
    const n = form.kind === 'fixed'
      ? c.number('value', form.value, 'The agreed price', { positive: true })
      : c.number('value', form.value, 'The margin');
    if (form.kind === 'margin' && n === 0) c.error('value', 'A margin of 0 is the pump price — no agreement needed');
    c.required('reason', form.reason, 'What the agreement is');
    if (n !== null && pump) {
      const price = form.kind === 'fixed' ? n : pump + n;
      const gap = Math.abs(price - pump) / pump;
      if (gap > 0.1)
        c.warn('value', `${(gap * 100).toFixed(0)}% from the pump price of ${fmt(pump)} — check it before saving`);
    }
    return c.issues;
  }, [form, pump]);

  const agree = async () => {
    setTried(true);
    if (hasErrors(issues)) return;
    setBusy(true);
    try {
      await api.post<unknown>(`/api/credit/customers/${customerId}/prices`,
        { productId: form.productId,
          price: form.kind === 'fixed' ? Number(form.value) : null,
          margin: form.kind === 'margin' ? Number(form.value) : null,
          reason: form.reason.trim() },
        { submission: `customer-price:${customerId}:${form.productId}` });
      showToast('Agreed price in force from now', 'success');
      setForm({ productId: '', kind: form.kind, value: '', reason: '' });
      setTried(false);
      await load();
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const end = async (id: string) => {
    setBusy(true);
    try {
      await api.post<unknown>(`/api/credit/prices/${id}/end`, {}, { submission: `customer-price-end:${id}` });
      showToast('Agreement ended: the pump price applies from now', 'success');
      await load();
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const muted = { color: 'var(--muted-foreground)' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-xl rounded-xl border p-5 space-y-4 max-h-[90vh] overflow-y-auto"
           style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Agreed prices — {customerName}</h2>
            <p className="text-xs" style={muted}>
              Billed on every credit sale while in force. The attendant still answers for the pump value.
            </p>
          </div>
          <button onClick={onClose} className="text-xs underline" style={muted}>Close</button>
        </div>

        {error && <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <select className="input-field w-full text-xs" value={form.productId}
                    style={fieldStyle(issues, 'productId', tried)}
                    onChange={(e) => setForm({ ...form, productId: e.target.value })}>
              <option value="">Product...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.code}{p.pumpPrice ? ` — pump ${fmt(p.pumpPrice)}` : ''}</option>
              ))}
            </select>
            <FieldIssues issues={issues} field="productId" tried={tried} />
          </div>
          <div className="flex gap-2">
            <select className="input-field text-xs" value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value as 'margin' | 'fixed' })}
                    title="A margin follows the pump price when it changes; a fixed price does not">
              <option value="margin">Pump ±</option>
              <option value="fixed">Fixed</option>
            </select>
            <div className="flex-1">
              <input type="number" placeholder={form.kind === 'fixed' ? 'UGX per litre' : 'e.g. 80 or -150'}
                     className="input-field w-full text-xs" style={fieldStyle(issues, 'value', tried)} value={form.value}
                     onChange={(e) => setForm({ ...form, value: e.target.value })} />
              <FieldIssues issues={issues} field="value" tried={tried} />
            </div>
          </div>
          {pump && form.value !== '' && !Number.isNaN(Number(form.value)) && (
            <p className="sm:col-span-2 text-[11px]" style={muted}>
              At today&apos;s pump price of {fmt(pump)}: the customer pays{' '}
              <b>{fmt(form.kind === 'fixed' ? Number(form.value) : pump + Number(form.value))}</b> a litre
              {form.kind === 'margin' ? ', and it moves with the pump.' : ', whatever the pump does.'}
            </p>
          )}
          <div className="sm:col-span-2">
            <input placeholder="What it is: contract no., volume deal, credit premium..." className="input-field w-full text-xs"
                   style={fieldStyle(issues, 'reason', tried)} value={form.reason}
                   onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <FieldIssues issues={issues} field="reason" tried={tried} />
          </div>
        </div>
        <IssueSummary issues={issues} tried={tried} />
        <button disabled={busy} onClick={() => void agree()} className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>
          {busy ? 'Saving…' : 'Agree this price from now'}
        </button>
        <p className="text-[11px]" style={muted}>
          An agreement starts now and is never backdated: sales already billed stay as billed. A new price for the
          same product ends the one in force.
        </p>

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={muted}>
                  <th className="text-left py-1">Product</th><th className="text-right">UGX / L</th>
                  <th className="text-left pl-3">From</th><th className="text-left">Until</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: r.inForce ? 1 : 0.55 }}>
                    <td className="py-1" title={`${r.reason} — agreed by ${r.authorisedBy}`}>{r.product}</td>
                    <td className="text-right">
                      {r.price !== null ? fmt(r.price) : `pump ${r.margin! > 0 ? '+' : '−'} ${fmt(Math.abs(r.margin!))}`}
                    </td>
                    <td className="pl-3">{when(r.validFrom)}</td>
                    <td>{r.validTo ? when(r.validTo) : 'open'}</td>
                    <td className="text-right">
                      {r.inForce && !r.validTo
                        ? <button disabled={busy} className="underline" style={muted} onClick={() => void end(r.id)}>end</button>
                        : <span style={muted}>{r.inForce ? 'ending' : 'ended'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
