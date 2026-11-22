'use client';

/**
 * The books (migrations 610/620): reconciliations, receivables, trial
 * balance, profit and loss, balance sheet, journals and account ledgers.
 *
 * Every figure is the database's (fn_gl_* functions through /api/books):
 * this screen adds no arithmetic, so it can never disagree with an export or
 * a check. Postings happen as the operations happen; the only things done
 * here by hand are a manual journal, a reversal and closing a month.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isCompanyWide } from '@/lib/roles';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import BankReconciliationTab from './BankReconciliation';
import { useAuth } from '@/context/AuthContext';
import type {
  AccountRow, BalanceSheet, ControlRow, JournalRow, JournalLineRow, LedgerLine,
  ProfitAndLoss, ReceivableRow, TrialBalanceRow,
} from '@/types/api';

type Tab = 'recs' | 'bank' | 'ar' | 'tb' | 'pl' | 'bs' | 'journals' | 'ledger';
const TABS: [Tab, string][] = [
  ['recs', 'Reconciliations'], ['bank', 'Bank & mobile money'], ['ar', 'Receivables'], ['tb', 'Trial balance'], ['pl', 'Profit & loss'],
  ['bs', 'Balance sheet'], ['journals', 'Journals'], ['ledger', 'Account ledger'],
];

const n0 = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : v.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const n2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : v.toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

const muted = { color: 'var(--muted-foreground)' };
const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide';
const td = 'px-3 py-1.5 text-xs';

// Each caller writes its own api.get(...) with the literal path, so the call
// checker can match every request to a route; the key says when to reload.
function useLoad<T>(key: string | null, fetch: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const load = useCallback(async () => {
    if (!key) return;
    setBusy(true);
    try { setData(await fetchRef.current()); setError(''); }
    catch (e) { setError((e as ApiError).message); setData(null); }
    finally { setBusy(false); }
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, busy, reload: load };
}

function Dates({ from, to, setFrom, setTo, single }: {
  from?: string; to: string; setFrom?: (v: string) => void; setTo: (v: string) => void; single?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {!single && setFrom && (
        <label className="flex items-center gap-1">From
          <input type="date" className="input-field text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
      )}
      <label className="flex items-center gap-1">{single ? 'As of' : 'To'}
        <input type="date" className="input-field text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
    </div>
  );
}

function Problem({ error }: { error: string }) {
  return error ? <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p> : null;
}

// ---------------------------------------------------------------------------
function Reconciliations() {
  const [asOf, setAsOf] = useState(today());
  const { data, error, busy } = useLoad<ControlRow[]>(`/api/books/controls?asOf=${asOf}`, () => api.get<ControlRow[]>(`/api/books/controls?asOf=${asOf}`));
  const differ = (data ?? []).filter((c) => c.ok === false).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Dates to={asOf} setTo={setAsOf} single />
        {data && (
          <span className="text-xs font-semibold px-2 py-1 rounded-md"
                style={{ background: differ ? 'rgba(239,68,68,0.12)' : 'rgba(0,212,160,0.12)',
                         color: differ ? '#ef4444' : 'var(--primary)' }}>
            {differ ? `${differ} control${differ === 1 ? '' : 's'} differ — explain before closing the month` : 'Every control agrees'}
          </span>
        )}
      </div>
      <p className="text-xs" style={muted}>
        Each control account in the books against the record it stands for. A difference is a fact to explain — it is
        never rounded away.
      </p>
      <Closing differ={differ} />
      <Problem error={error} />
      <div className="overflow-x-auto rounded-xl border" style={card}>
        <table className="w-full">
          <thead><tr style={muted}>
            <th className={th}>Control</th><th className={th}>Against</th>
            <th className={th + ' text-right'}>Books</th><th className={th + ' text-right'}>Record</th>
            <th className={th + ' text-right'}>Difference</th><th className={th}>Status</th>
          </tr></thead>
          <tbody>
            {(data ?? []).map((c, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className={td + ' font-medium'}>{c.control}</td>
                <td className={td} style={muted}>{c.detail}</td>
                <td className={td + ' text-right tabular-nums'}>{c.unit === 'UGX' ? n2(c.ledger) : `${n2(c.ledger)} ${c.unit}`}</td>
                <td className={td + ' text-right tabular-nums'}>{c.record === null ? '—' : c.unit === 'UGX' ? n2(c.record) : `${n2(c.record)} ${c.unit}`}</td>
                <td className={td + ' text-right tabular-nums'} style={{ color: c.ok === false ? '#ef4444' : undefined }}>
                  {c.difference === null ? '—' : n2(c.difference)}
                </td>
                <td className={td}>
                  {c.ok === true && <span style={{ color: 'var(--primary)' }}>agrees</span>}
                  {c.ok === false && <span style={{ color: '#ef4444', fontWeight: 600 }}>differs</span>}
                  {c.ok === null && <span style={muted}>for information</span>}
                </td>
              </tr>
            ))}
            {busy && !data && <tr><td className={td} colSpan={6}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Closing a month (nothing more posts into it) and a year (income and expense
// to retained earnings). Neither reopens; the database refuses them while
// shifts are open or months unclosed.
function Closing({ differ }: { differ: number }) {
  const { showToast } = useToast();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [busy, setBusy] = useState(false);
  const closeMonth = async () => {
    if (differ && !window.confirm(`${differ} control(s) differ. Close ${month} anyway? It cannot be reopened.`)) return;
    setBusy(true);
    try {
      const [y, m] = month.split('-').map(Number);
      await api.post(`/api/books/periods/${y}/${m}/close`, {}, { submission: `close-month:${month}` });
      showToast(`${month} closed: anything later dated in it posts to the next open month`, 'success');
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };
  const closeYear = async () => {
    setBusy(true);
    try {
      await api.post(`/api/books/years/${year}/close`, {}, { submission: `close-year:${year}` });
      showToast(`${year} closed into retained earnings`, 'success');
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs rounded-lg border p-2" style={card}>
      <span style={muted}>Accountant or head office:</span>
      <input type="month" className="input-field text-xs" value={month} onChange={(e) => setMonth(e.target.value)} />
      <button disabled={busy} className="px-2 py-1 rounded-md font-semibold" style={{ background: 'var(--muted)' }} onClick={() => void closeMonth()}>Close month</button>
      <input type="number" className="input-field text-xs w-20" value={year} onChange={(e) => setYear(e.target.value)} />
      <button disabled={busy} className="px-2 py-1 rounded-md font-semibold" style={{ background: 'var(--muted)' }} onClick={() => void closeYear()}>Close year</button>
      <span style={muted}>A closed month or year does not reopen.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Receivables() {
  const [asOf, setAsOf] = useState(today());
  const { data, error } = useLoad<ReceivableRow[]>(`/api/books/receivables?asOf=${asOf}`, () => api.get<ReceivableRow[]>(`/api/books/receivables?asOf=${asOf}`));
  const rows = (data ?? []).filter((r) => r.billed !== 0 || r.subledger !== 0 || r.ledger !== 0);
  const t = (k: keyof ReceivableRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return (
    <div className="space-y-3">
      <Dates to={asOf} setTo={setAsOf} single />
      <p className="text-xs" style={muted}>
        Each customer&apos;s own account (credit sales and depot credit, less payments) against the receivables control
        account in the books, and what they owe by age — payments taken against the oldest sales first. Sales on a
        shift still open are shown apart: they reach the books when the shift closes.
      </p>
      <Problem error={error} />
      <div className="overflow-x-auto rounded-xl border" style={card}>
        <table className="w-full">
          <thead><tr style={muted}>
            <th className={th}>Customer</th><th className={th + ' text-right'}>Owes (account)</th>
            <th className={th + ' text-right'}>Books</th><th className={th + ' text-right'}>Difference</th>
            <th className={th + ' text-right'} title="Credit sales on shifts still open: on the account, in the books once the shift closes">Open shifts</th>
            <th className={th + ' text-right'}>0–30 days</th><th className={th + ' text-right'}>31–60</th>
            <th className={th + ' text-right'}>61–90</th><th className={th + ' text-right'}>Over 90</th>
            <th className={th + ' text-right'}>Limit</th><th className={th}>Last paid</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customerId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className={td}><span className="font-medium">{r.name}</span> <span style={muted}>{r.code}</span></td>
                <td className={td + ' text-right tabular-nums'}>{n0(r.subledger)}</td>
                <td className={td + ' text-right tabular-nums'}>{n0(r.ledger)}</td>
                <td className={td + ' text-right tabular-nums'} style={{ color: r.difference !== 0 ? '#ef4444' : 'var(--primary)' }}>
                  {r.difference === 0 ? 'agrees' : n2(r.difference)}
                </td>
                <td className={td + ' text-right tabular-nums'} style={muted}>{r.inOpenShifts ? n0(r.inOpenShifts) : ''}</td>
                <td className={td + ' text-right tabular-nums'}>{n0(r.current0To30)}</td>
                <td className={td + ' text-right tabular-nums'} style={{ color: r.days31To60 ? '#F59E0B' : undefined }}>{n0(r.days31To60)}</td>
                <td className={td + ' text-right tabular-nums'} style={{ color: r.days61To90 ? '#F97316' : undefined }}>{n0(r.days61To90)}</td>
                <td className={td + ' text-right tabular-nums'} style={{ color: r.over90 ? '#ef4444' : undefined }}>{n0(r.over90)}</td>
                <td className={td + ' text-right tabular-nums'}
                    style={{ color: r.subledger > r.creditLimit ? '#ef4444' : undefined }}>{n0(r.creditLimit)}</td>
                <td className={td} style={muted}>{r.lastPayment?.slice(0, 10) ?? 'never'}</td>
              </tr>
            ))}
            <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
              <td className={td}>Total</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('subledger'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('ledger'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n2(t('difference'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('inOpenShifts'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('current0To30'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('days31To60'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('days61To90'))}</td>
              <td className={td + ' text-right tabular-nums'}>{n0(t('over90'))}</td>
              <td className={td} colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TrialBalance({ onAccount }: { onAccount: (code: string) => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error } = useLoad<TrialBalanceRow[]>(`/api/books/trial-balance?from=${from}&to=${to}`, () => api.get<TrialBalanceRow[]>(`/api/books/trial-balance?from=${from}&to=${to}`));
  const rows = data ?? [];
  const dr = rows.reduce((s, r) => s + (r.closing > 0 ? r.closing : 0), 0);
  const cr = rows.reduce((s, r) => s + (r.closing < 0 ? -r.closing : 0), 0);
  return (
    <div className="space-y-3">
      <Dates from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <Problem error={error} />
      <div className="overflow-x-auto rounded-xl border" style={card}>
        <table className="w-full">
          <thead><tr style={muted}>
            <th className={th}>Account</th><th className={th + ' text-right'}>Opening</th>
            <th className={th + ' text-right'}>Debits</th><th className={th + ' text-right'}>Credits</th>
            <th className={th + ' text-right'}>Closing Dr</th><th className={th + ' text-right'}>Closing Cr</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-t cursor-pointer hover:opacity-80" style={{ borderColor: 'var(--border)' }}
                  onClick={() => onAccount(r.code)} title="Open the account's ledger">
                <td className={td}><span style={muted}>{r.code}</span> {r.name}</td>
                <td className={td + ' text-right tabular-nums'}>{n2(r.opening)}</td>
                <td className={td + ' text-right tabular-nums'}>{n2(r.debits)}</td>
                <td className={td + ' text-right tabular-nums'}>{n2(r.credits)}</td>
                <td className={td + ' text-right tabular-nums'}>{r.closing > 0 ? n2(r.closing) : ''}</td>
                <td className={td + ' text-right tabular-nums'}>{r.closing < 0 ? n2(-r.closing) : ''}</td>
              </tr>
            ))}
            <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
              <td className={td} colSpan={4}>
                Total {Math.abs(dr - cr) < 0.005
                  ? <span style={{ color: 'var(--primary)' }}>— debits equal credits</span>
                  : <span style={{ color: '#ef4444' }}>— OUT BY {n2(dr - cr)}</span>}
              </td>
              <td className={td + ' text-right tabular-nums'}>{n2(dr)}</td>
              <td className={td + ' text-right tabular-nums'}>{n2(cr)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Statement({ title, lines, total, totalLabel }: {
  title: string; lines: { code: string; name: string; amount: number }[]; total?: number; totalLabel?: string;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide" style={muted}>{title}</h3>
      {lines.map((l) => (
        <div key={l.code} className="flex justify-between text-xs py-0.5">
          <span><span style={muted}>{l.code}</span> {l.name}</span><span className="tabular-nums">{n0(l.amount)}</span>
        </div>
      ))}
      {total !== undefined && (
        <div className="flex justify-between text-xs py-1 border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
          <span>{totalLabel}</span><span className="tabular-nums">{n0(total)}</span>
        </div>
      )}
    </div>
  );
}

function ProfitLoss() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error } = useLoad<ProfitAndLoss>(`/api/books/profit-and-loss?from=${from}&to=${to}`, () => api.get<ProfitAndLoss>(`/api/books/profit-and-loss?from=${from}&to=${to}`));
  return (
    <div className="space-y-3">
      <Dates from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <Problem error={error} />
      {data && (
        <div className="rounded-xl border p-4 space-y-4 max-w-2xl" style={card}>
          <Statement title="Income" lines={data.income} total={data.totalIncome} totalLabel="Total income" />
          <Statement title="Cost of sales and stock" lines={data.costOfSales} total={data.grossProfit} totalLabel="Gross profit" />
          <Statement title="Expenses" lines={data.expenses} total={data.totalExpenses} totalLabel="Total expenses" />
          <div className="flex justify-between text-sm font-bold pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            <span>{data.netProfit >= 0 ? 'Net profit' : 'Net loss'}</span>
            <span className="tabular-nums" style={{ color: data.netProfit >= 0 ? 'var(--primary)' : '#ef4444' }}>{n0(data.netProfit)}</span>
          </div>
          <p className="text-[11px]" style={muted}>
            Discounts and agreed-price allowances sit with income (a credit premium above the pump reduces them). Fuel
            stock gains and losses, and transit, sit with cost of sales.
          </p>
        </div>
      )}
    </div>
  );
}

function Balance() {
  const [asOf, setAsOf] = useState(today());
  const { data, error } = useLoad<BalanceSheet>(`/api/books/balance-sheet?asOf=${asOf}`, () => api.get<BalanceSheet>(`/api/books/balance-sheet?asOf=${asOf}`));
  return (
    <div className="space-y-3">
      <Dates to={asOf} setTo={setAsOf} single />
      <Problem error={error} />
      {data && (
        <div className="rounded-xl border p-4 space-y-4 max-w-2xl" style={card}>
          <Statement title="Assets" lines={data.assets} total={data.totalAssets} totalLabel="Total assets" />
          <Statement title="Liabilities" lines={data.liabilities} total={data.totalLiabilities} totalLabel="Total liabilities" />
          <Statement title="Equity"
                     lines={[...data.equity, { code: '', name: 'Earnings to date (not yet closed)', amount: data.earningsToDate }]}
                     total={data.totalEquity} totalLabel="Total equity" />
          <p className="text-xs font-semibold" style={{ color: Math.abs(data.difference) < 0.005 ? 'var(--primary)' : '#ef4444' }}>
            {Math.abs(data.difference) < 0.005
              ? 'Assets equal liabilities plus equity.'
              : `Assets differ from liabilities plus equity by ${n2(data.difference)}.`}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Journals({ accounts }: { accounts: AccountRow[] }) {
  const { showToast } = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [source, setSource] = useState('');
  const { data, error, reload } = useLoad<JournalRow[]>(`${from}:${to}:${source}`,
    () => api.get<JournalRow[]>(`/api/books/journals?from=${from}&to=${to}${source ? `&source=${source}` : ''}`));
  const [open, setOpen] = useState<JournalRow | null>(null);
  const [lines, setLines] = useState<JournalLineRow[] | null>(null);
  const [reason, setReason] = useState('');
  const [newJ, setNewJ] = useState(false);

  const show = async (j: JournalRow) => {
    setOpen(j); setLines(null); setReason('');
    try { setLines(await api.get<JournalLineRow[]>(`/api/books/journals/${j.id}`)); }
    catch (e) { showToast((e as ApiError).message, 'error'); }
  };
  const reverse = async () => {
    if (!open || !reason.trim()) { showToast('Say why the journal is reversed', 'error'); return; }
    try {
      await api.post(`/api/books/journals/${open.id}/reverse`, { reason: reason.trim() }, { submission: `reverse:${open.id}` });
      showToast('Reversed: a new journal undoes it, line for line', 'success');
      setOpen(null); await reload();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Dates from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <select className="input-field text-xs" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Every source</option>
          {['shift', 'fuel_movement', 'dry_movement', 'banking', 'credit_payment', 'expense', 'supplier_invoice',
            'supplier_payment', 'shortage_recovery', 'other_income', 'bulk_sale', 'manual'].map((x) => (
            <option key={x} value={x}>{x.replace('_', ' ')}</option>))}
        </select>
        <button className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }} onClick={() => setNewJ(true)}>
          New manual journal
        </button>
      </div>
      <Problem error={error} />
      <div className="overflow-x-auto rounded-xl border" style={card}>
        <table className="w-full">
          <thead><tr style={muted}>
            <th className={th}>Date</th><th className={th}>Source</th><th className={th}>What</th>
            <th className={th + ' text-right'}>Amount</th><th className={th} />
          </tr></thead>
          <tbody>
            {(data ?? []).map((j) => (
              <tr key={j.id} className="border-t cursor-pointer hover:opacity-80" style={{ borderColor: 'var(--border)' }}
                  onClick={() => void show(j)}>
                <td className={td}>{j.postingDate.slice(0, 10)}</td>
                <td className={td} style={muted}>{j.source.replace('_', ' ')}</td>
                <td className={td}>{j.memo}{j.postedBy ? <span style={muted}> — {j.postedBy}</span> : null}</td>
                <td className={td + ' text-right tabular-nums'}>{n2(j.total)}</td>
                <td className={td} style={{ color: j.reversed || j.reversesId ? '#F59E0B' : undefined }}>
                  {j.reversed ? 'reversed' : j.reversesId ? 'reversal' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data?.length ?? 0) >= 500 && <p className="text-[11px]" style={muted}>The latest 500 — narrow the dates or the source.</p>}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="w-full max-w-3xl rounded-xl border p-5 space-y-3 max-h-[90vh] overflow-y-auto" style={card}>
            <div className="flex justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{open.memo}</h2>
                <p className="text-xs" style={muted}>{open.source} · counts in {open.postingDate.slice(0, 10)} · happened {open.eventAt.slice(0, 16).replace('T', ' ')}</p>
              </div>
              <button className="text-xs underline" style={muted} onClick={() => setOpen(null)}>Close</button>
            </div>
            <table className="w-full">
              <thead><tr style={muted}>
                <th className={th}>Account</th><th className={th}>For</th><th className={th + ' text-right'}>Qty</th>
                <th className={th + ' text-right'}>Debit</th><th className={th + ' text-right'}>Credit</th>
              </tr></thead>
              <tbody>
                {(lines ?? []).map((l, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className={td}><span style={muted}>{l.code}</span> {l.account}{l.memo ? <div style={muted}>{l.memo}</div> : null}</td>
                    <td className={td}>{l.party ?? ''}</td>
                    <td className={td + ' text-right tabular-nums'}>{l.qty === null ? '' : n2(l.qty)}</td>
                    <td className={td + ' text-right tabular-nums'}>{n2(l.debit)}</td>
                    <td className={td + ' text-right tabular-nums'}>{n2(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!open.reversed && !open.reversesId && (
              <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <input className="input-field flex-1 text-xs" placeholder="Why reverse it? A journal is never edited."
                       value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                        style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }} onClick={() => void reverse()}>Reverse</button>
              </div>
            )}
          </div>
        </div>
      )}
      {newJ && <ManualJournalForm accounts={accounts} onClose={() => setNewJ(false)} onDone={() => { setNewJ(false); void reload(); }} />}
    </div>
  );
}

function ManualJournalForm({ accounts, onClose, onDone }: { accounts: AccountRow[]; onClose: () => void; onDone: () => void }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([{ code: '', debit: '', credit: '', memo: '' }, { code: '', debit: '', credit: '', memo: '' }]);
  const [busy, setBusy] = useState(false);
  const dr = rows.reduce((s, r) => s + (Number(r.debit) || 0), 0);
  const cr = rows.reduce((s, r) => s + (Number(r.credit) || 0), 0);
  // Control accounts need a customer, supplier, tank... -- set those through
  // the screen that owns them, not here.
  const plain = useMemo(() => accounts.filter((a) => !a.control || a.control === 'SITE'), [accounts]);
  const problems = useMemo(() => {
    const p: string[] = [];
    if (memo.trim().length < 5) p.push('Say what the journal is for');
    if (rows.filter((r) => r.code && (Number(r.debit) || Number(r.credit))).length < 2) p.push('At least two lines with an account and an amount');
    if (rows.some((r) => Number(r.debit) && Number(r.credit))) p.push('A line is a debit or a credit, not both');
    if (Math.abs(dr - cr) >= 0.005) p.push(`Debits and credits differ by ${n2(dr - cr)}`);
    return p;
  }, [memo, rows, dr, cr]);

  const save = async () => {
    if (problems.length) return;
    setBusy(true);
    try {
      await api.post('/api/books/journals', {
        siteId: null, date, memo: memo.trim(),
        lines: rows.filter((r) => r.code && (Number(r.debit) || Number(r.credit))).map((r) => ({
          code: r.code, amount: (Number(r.debit) || 0) - (Number(r.credit) || 0), memo: r.memo || null,
          customerId: null, supplierId: null, staffId: null, tankId: null, qty: null,
        })),
      }, { submission: `manual-journal:${date}:${memo}` });
      showToast('Journal posted', 'success');
      onDone();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-3xl rounded-xl border p-5 space-y-3 max-h-[90vh] overflow-y-auto" style={card}>
        <div className="flex justify-between"><h2 className="text-sm font-semibold">Manual journal</h2>
          <button className="text-xs underline" style={muted} onClick={onClose}>Cancel</button></div>
        <p className="text-xs" style={muted}>
          For what no screen records: opening balances, accruals, corrections. Posted by an accountant, manager or head
          office, balanced, and never edited — a mistake is reversed.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input type="date" className="input-field text-xs" value={date} onChange={(e) => setDate(e.target.value)} />
          <input className="input-field text-xs sm:col-span-2" placeholder="What it is for" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <select className="input-field text-xs col-span-5" value={r.code}
                    onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, code: e.target.value } : x))}>
              <option value="">Account...</option>
              {plain.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
            <input type="number" className="input-field text-xs col-span-2" placeholder="Debit" value={r.debit}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, debit: e.target.value } : x))} />
            <input type="number" className="input-field text-xs col-span-2" placeholder="Credit" value={r.credit}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, credit: e.target.value } : x))} />
            <input className="input-field text-xs col-span-3" placeholder="Note" value={r.memo}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, memo: e.target.value } : x))} />
          </div>
        ))}
        <div className="flex justify-between items-center text-xs">
          <button className="underline" style={muted} onClick={() => setRows([...rows, { code: '', debit: '', credit: '', memo: '' }])}>Add a line</button>
          <span className="tabular-nums">Debits {n2(dr)} · Credits {n2(cr)}</span>
        </div>
        {problems.length > 0 && <ul className="text-xs list-disc pl-5" style={{ color: '#F59E0B' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <button disabled={busy || problems.length > 0} onClick={() => void save()}
                className="w-full py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>{busy ? 'Posting…' : 'Post the journal'}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Ledger({ accounts, code, setCode }: { accounts: AccountRow[]; code: string; setCode: (c: string) => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const { data, error } = useLoad<LedgerLine[]>(code ? `${code}:${from}:${to}` : null,
    () => api.get<LedgerLine[]>(`/api/books/ledger/${code}?from=${from}&to=${to}`));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="input-field text-xs" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">Account...</option>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </select>
        <Dates from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </div>
      <Problem error={error} />
      {data && (
        <div className="overflow-x-auto rounded-xl border" style={card}>
          <table className="w-full">
            <thead><tr style={muted}>
              <th className={th}>Date</th><th className={th}>What</th><th className={th}>For</th>
              <th className={th + ' text-right'}>Qty</th><th className={th + ' text-right'}>Debit</th>
              <th className={th + ' text-right'}>Credit</th><th className={th + ' text-right'}>Balance</th>
            </tr></thead>
            <tbody>
              {data.map((l, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className={td}>{l.postingDate?.slice(0, 10) ?? ''}</td>
                  <td className={td}>{l.memo}</td>
                  <td className={td} style={muted}>{l.party ?? ''}</td>
                  <td className={td + ' text-right tabular-nums'}>{l.qty === null ? '' : n2(l.qty)}</td>
                  <td className={td + ' text-right tabular-nums'}>{n2(l.debit)}</td>
                  <td className={td + ' text-right tabular-nums'}>{n2(l.credit)}</td>
                  <td className={td + ' text-right tabular-nums font-medium'}>{n2(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function BooksContent() {
  // The company-wide controls are head office's (the API refuses a station);
  // a station's books open on its trial balance instead of on a refusal. (D4)
  const { user } = useAuth();
  const companyWide = !user || isCompanyWide(user.role);
  const tabs = companyWide ? TABS : TABS.filter(([k]) => k !== 'recs');
  const [tab, setTab] = useState<Tab>(companyWide ? 'recs' : 'tb');
  const [code, setCode] = useState('');
  const { data: accounts } = useLoad<AccountRow[]>('/api/books/accounts', () => api.get<AccountRow[]>('/api/books/accounts'));
  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Books</h1>
        <p className="text-xs" style={muted}>
          The general ledger, posted from every shift, delivery, payment and expense as it happens — and reconciled
          against the records it summarises.
        </p>
      </div>
      <div className="flex flex-wrap gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="px-3 py-2 text-xs font-medium -mb-px border-b-2"
                  style={{ borderColor: tab === k ? 'var(--primary)' : 'transparent',
                           color: tab === k ? 'var(--foreground)' : 'var(--muted-foreground)' }}>{label}</button>
        ))}
      </div>
      {tab === 'recs' && <Reconciliations />}
      {tab === 'bank' && <BankReconciliationTab chart={accounts ?? []} />}
      {tab === 'ar' && <Receivables />}
      {tab === 'tb' && <TrialBalance onAccount={(c) => { setCode(c); setTab('ledger'); }} />}
      {tab === 'pl' && <ProfitLoss />}
      {tab === 'bs' && <Balance />}
      {tab === 'journals' && <Journals accounts={accounts ?? []} />}
      {tab === 'ledger' && <Ledger accounts={accounts ?? []} code={code} setCode={setCode} />}
    </div>
  );
}
