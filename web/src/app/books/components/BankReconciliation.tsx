'use client';

/**
 * Bank and mobile money against their statements (migration 630).
 *
 * Import a statement (CSV from the bank or the network), let the system match
 * what it can, match the rest by hand, and post what only the statement knew
 * (charges, interest, a standing order) to the books from here. The account
 * reconciles when nothing is left open but deposits still in transit.
 * Withdrawals from a MoMo wallet to the bank are recorded here too.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import type { AccountRow, BankReconciliation, BankRecItem, MoneyAccountRow } from '@/types/api';

const n2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : v.toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const muted = { color: 'var(--muted-foreground)' };
const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
const td = 'px-3 py-1.5 text-xs';
const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide';

// ---- CSV, as banks and networks export it --------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
const money = (s: string) => {
  const t = s.replace(/[,\s]|UGX/gi, '');
  if (t === '' || t === '-') return 0;
  const neg = /^\(.*\)$/.test(t);
  const v = Number(t.replace(/[()]/g, ''));
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
};
// 31/10/2026, 31-10-2026, 2026-10-31, optionally with a time.
const parseWhen = (s: string): { date: string | null; at: string | null } => {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  let y, mo, d, hh, mi, ss;
  if (m) [, y, mo, d, hh, mi, ss] = m;
  else {
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return { date: null, at: null };
    [, d, mo, y, hh, mi, ss] = m;
  }
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const at = hh ? `${date}T${String(hh).padStart(2, '0')}:${mi}:${ss ?? '00'}+03:00` : null;
  return { date, at };
};

type Cols = { date: number; description: number; reference: number; amount: number; debit: number; credit: number; balance: number };

function ImportStatement({ account, onDone, onClose }: { account: MoneyAccountRow; onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<string[][]>([]);
  const [name, setName] = useState('');
  const [cols, setCols] = useState<Cols>({ date: 0, description: 1, reference: -1, amount: 2, debit: -1, credit: -1, balance: -1 });
  const [busy, setBusy] = useState(false);
  const header = rows[0] ?? [];

  const guess = (h: string[]) => {
    const f = (...k: string[]) => h.findIndex((x) => k.some((w) => x.toLowerCase().includes(w)));
    const debit = f('debit', 'withdraw', 'paid out');
    const credit = f('credit', 'deposit', 'paid in');
    setCols({
      date: Math.max(0, f('date', 'time')), description: f('description', 'narration', 'details', 'particulars'),
      reference: f('reference', 'ref', 'transaction id', 'receipt'),
      amount: debit >= 0 && credit >= 0 ? -1 : f('amount', 'value'), debit, credit, balance: f('balance'),
    });
  };
  const file = async (f: File) => {
    const r = parseCsv(await f.text());
    setRows(r); setName(f.name); guess(r[0] ?? []);
  };
  const lines = useMemo(() => rows.slice(1).map((r) => {
    const w = parseWhen(r[cols.date] ?? '');
    const amount = cols.amount >= 0 ? money(r[cols.amount] ?? '')
      : money(r[cols.credit] ?? '') - Math.abs(money(r[cols.debit] ?? ''));
    return {
      date: w.date, at: w.at, description: cols.description >= 0 ? (r[cols.description] ?? '') : '',
      reference: cols.reference >= 0 ? (r[cols.reference] ?? '') : '', amount,
      balance: cols.balance >= 0 ? money(r[cols.balance] ?? '') : null,
    };
  }), [rows, cols]);
  const bad = lines.filter((l) => !l.date || !Number.isFinite(l.amount)).length;
  const good = lines.filter((l) => l.date && Number.isFinite(l.amount) && l.amount !== 0);

  const save = async () => {
    if (!good.length) return;
    setBusy(true);
    try {
      const dates = good.map((l) => l.date!).sort();
      const res = await api.post<{ imported: number; skipped: number }>(`/api/money/accounts/${account.id}/statements`, {
        periodFrom: dates[0], periodTo: dates[dates.length - 1], openingBalance: null, closingBalance: null,
        sourceName: name, lines: good.map((l) => ({ date: l.date, at: l.at ? new Date(l.at).toISOString() : null, description: l.description,
          reference: l.reference, amount: l.amount, balance: l.balance })),
      }, { submission: `statement:${account.id}:${name}:${good.length}` });
      showToast(`${res.imported} line(s) imported${res.skipped ? `, ${res.skipped} already there` : ''}`, 'success');
      onDone();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };

  const pick = (k: keyof Cols, label: string) => (
    <label className="flex flex-col text-[11px] gap-0.5" style={muted}>{label}
      <select className="input-field text-xs" value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: Number(e.target.value) })}>
        <option value={-1}>—</option>
        {header.map((h, i) => <option key={i} value={i}>{h || `column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-3xl rounded-xl border p-5 space-y-3 max-h-[90vh] overflow-y-auto" style={card}>
        <div className="flex justify-between"><h2 className="text-sm font-semibold">Import a statement — {account.name}</h2>
          <button className="text-xs underline" style={muted} onClick={onClose}>Cancel</button></div>
        <p className="text-xs" style={muted}>
          The CSV the bank or network gives you. Say which column is which; money in is positive. A line already imported
          is skipped, so an overlapping statement is safe. Mobile-money statements with a time on each line match shift
          by shift.
        </p>
        <input type="file" accept=".csv,text/csv" className="text-xs" onChange={(e) => e.target.files?.[0] && void file(e.target.files[0])} />
        {rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {pick('date', 'Date (and time)')}{pick('description', 'Description')}{pick('reference', 'Reference')}
              {pick('amount', 'Amount (signed)')}{pick('credit', 'Money in')}{pick('debit', 'Money out')}{pick('balance', 'Balance')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr style={muted}><th className={th}>Date</th><th className={th}>Description</th><th className={th}>Ref</th><th className={th + ' text-right'}>Amount</th></tr></thead>
                <tbody>
                  {lines.slice(0, 8).map((l, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: 'var(--border)', color: !l.date || !Number.isFinite(l.amount) ? '#ef4444' : undefined }}>
                      <td className={td}>{l.at ? l.at.slice(0, 16).replace('T', ' ') : l.date ?? 'not a date'}</td>
                      <td className={td}>{l.description}</td><td className={td}>{l.reference}</td>
                      <td className={td + ' text-right tabular-nums'}>{Number.isFinite(l.amount) ? n2(l.amount) : 'not a number'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs" style={{ color: bad ? '#F59E0B' : 'var(--muted-foreground)' }}>
              {good.length} line(s) to import{bad ? `; ${bad} line(s) without a readable date or amount will be left out — check the columns` : ''}.
            </p>
            <button disabled={busy || !good.length} onClick={() => void save()} className="w-full py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>{busy ? 'Importing…' : `Import ${good.length} line(s)`}</button>
          </>
        )}
      </div>
    </div>
  );
}

function Transfer({ accounts, onDone, onClose }: { accounts: MoneyAccountRow[]; onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  const [f, setF] = useState({ from: '', to: '', amount: '', fee: '0', reference: '' });
  const [busy, setBusy] = useState(false);
  const problems = [
    !f.from || !f.to ? 'Choose both accounts' : '',
    f.from && f.from === f.to ? 'Money moves between two different accounts' : '',
    !(Number(f.amount) > 0) ? 'The amount that arrived, more than zero' : '',
    Number(f.fee) < 0 ? 'A fee is zero or more' : '',
  ].filter(Boolean);
  const save = async () => {
    if (problems.length) return;
    setBusy(true);
    try {
      await api.post('/api/money/transfers', { fromAccountId: f.from, toAccountId: f.to, amount: Number(f.amount),
        fee: Number(f.fee) || 0, reference: f.reference || null }, { submission: `transfer:${f.from}:${f.amount}:${f.reference}` });
      showToast('Transfer recorded and posted', 'success'); onDone();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-lg rounded-xl border p-5 space-y-3" style={card}>
        <div className="flex justify-between"><h2 className="text-sm font-semibold">Move money between accounts</h2>
          <button className="text-xs underline" style={muted} onClick={onClose}>Cancel</button></div>
        <p className="text-xs" style={muted}>A MoMo withdrawal to the bank, or bank to bank. The fee comes out of the sending account.</p>
        <div className="grid grid-cols-2 gap-2">
          <select className="input-field text-xs" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>
            <option value="">From…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select className="input-field text-xs" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
            <option value="">To…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <input type="number" className="input-field text-xs" placeholder="Amount that arrived" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <input type="number" className="input-field text-xs" placeholder="Fee" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          <input className="input-field text-xs col-span-2" placeholder="Reference on the statements" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </div>
        {problems.length > 0 && <ul className="text-xs list-disc pl-5" style={{ color: '#F59E0B' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <button disabled={busy || problems.length > 0} onClick={() => void save()} className="w-full py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>{busy ? 'Saving…' : 'Record the transfer'}</button>
      </div>
    </div>
  );
}

function NewAccount({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  const [f, setF] = useState({ kind: 'BANK', name: '', institution: '', accountRef: '', isDefault: false });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.name.trim() || !f.institution.trim()) { showToast('Name the account and the bank', 'error'); return; }
    setBusy(true);
    try {
      await api.post('/api/money/accounts', { kind: f.kind, name: f.name, institution: f.institution,
        accountRef: f.accountRef || null, channelId: null, siteId: null, isDefault: f.isDefault }, { submission: `money-account:${f.name}` });
      showToast('Account added', 'success'); onDone();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-lg rounded-xl border p-5 space-y-3" style={card}>
        <div className="flex justify-between"><h2 className="text-sm font-semibold">Add a bank account</h2>
          <button className="text-xs underline" style={muted} onClick={onClose}>Cancel</button></div>
        <div className="grid grid-cols-2 gap-2">
          <input className="input-field text-xs col-span-2" placeholder="Name, e.g. Stanbic Kiboga collections" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="input-field text-xs" placeholder="Bank, e.g. Stanbic Bank" value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} />
          <input className="input-field text-xs" placeholder="Account number as on slips" value={f.accountRef} onChange={(e) => setF({ ...f, accountRef: e.target.value })} />
          <label className="text-xs col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />
            The main account: bank payments that name no account belong here
          </label>
        </div>
        <p className="text-[11px]" style={muted}>A MoMo wallet is added with its payment channel by an administrator, so its tenders match it.</p>
        <button disabled={busy} onClick={() => void save()} className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>{busy ? 'Saving…' : 'Add the account'}</button>
      </div>
    </div>
  );
}

export default function BankReconciliationTab({ chart }: { chart: AccountRow[] }) {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<MoneyAccountRow[]>([]);
  const [id, setId] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [rec, setRec] = useState<BankReconciliation | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [post, setPost] = useState<{ item: BankRecItem; code: string; memo: string } | null>(null);
  const [modal, setModal] = useState<'' | 'import' | 'transfer' | 'account'>('');
  const account = accounts.find((a) => a.id === id) ?? null;
  const loading = useRef(false);

  const loadAccounts = useCallback(async () => {
    try {
      const a = await api.get<MoneyAccountRow[]>('/api/money/accounts');
      setAccounts(a);
      setId((cur) => cur || a[0]?.id || '');
    } catch (e) { setError((e as ApiError).message); }
  }, []);
  const loadRec = useCallback(async () => {
    if (!id || loading.current) return;
    loading.current = true;
    try { setRec(await api.get<BankReconciliation>(`/api/money/accounts/${id}/reconciliation?asOf=${asOf}`)); setError(''); setPicked(new Set()); }
    catch (e) { setError((e as ApiError).message); }
    finally { loading.current = false; }
  }, [id, asOf]);
  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void loadRec(); }, [loadRec]);

  const items = rec?.items ?? [];
  const sel = items.filter((i) => picked.has(i.side + i.id));
  const selBook = sel.filter((i) => i.side === 'BOOK').reduce((s, i) => s + i.amount, 0);
  const selStmt = sel.filter((i) => i.side === 'STATEMENT').reduce((s, i) => s + i.amount, 0);
  const canMatch = sel.some((i) => i.side === 'BOOK') && sel.some((i) => i.side === 'STATEMENT') && Math.abs(selBook - selStmt) < 0.005;
  const postable = chart.filter((a) => !a.control && !['1010', '1020'].includes(a.code));
  const stale = (i: BankRecItem) => i.side === 'BOOK' && rec?.summary.statementDate
    && (new Date(rec.summary.statementDate).getTime() - new Date(i.onDate).getTime()) / 86400_000 > 5;

  const auto = async () => {
    try {
      const r = await api.post<{ matched: number }>(`/api/money/accounts/${id}/auto-match`, {}, { submission: `auto-match:${id}:${Date.now()}` });
      showToast(`${r.matched} match(es) made`, 'success'); await loadRec();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
  };
  const match = async () => {
    try {
      await api.post(`/api/money/accounts/${id}/match`, {
        statementLineIds: sel.filter((i) => i.side === 'STATEMENT').map((i) => i.id),
        bookLineIds: sel.filter((i) => i.side === 'BOOK').map((i) => Number(i.id)), note: null,
      }, { submission: `match:${[...picked].join(',')}` });
      showToast('Matched', 'success'); await loadRec();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
  };
  const doPost = async () => {
    if (!post || !post.code) return;
    try {
      await api.post(`/api/money/statement-lines/${post.item.id}/post`, { code: post.code, memo: post.memo || null },
        { submission: `post-line:${post.item.id}` });
      showToast('Posted to the books and matched', 'success'); setPost(null); await loadRec();
    } catch (e) { showToast((e as ApiError).message, 'error'); }
  };
  const toggle = (i: BankRecItem) => setPicked((p) => {
    const n = new Set(p); const k = i.side + i.id;
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const s = rec?.summary;
  const reconciled = s && s.unmatchedStatement === 0 && s.staleBook === 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="input-field text-xs" value={id} onChange={(e) => setId(e.target.value)}>
          {accounts.length === 0 && <option value="">No accounts yet</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isDefault ? ' (main)' : ''}</option>)}
        </select>
        <label className="text-xs flex items-center gap-1">As of
          <input type="date" className="input-field text-xs" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <div className="ml-auto flex flex-wrap gap-2">
          {account && <button className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }} onClick={() => setModal('import')}>Import statement</button>}
          {account && <button className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'var(--muted)' }} onClick={() => void auto()}>Match automatically</button>}
          <button className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'var(--muted)' }} onClick={() => setModal('transfer')}>Move money</button>
          <button className="px-3 py-1.5 rounded-lg text-xs" style={muted} onClick={() => setModal('account')}>Add account</button>
        </div>
      </div>
      {error && <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>}

      {s && account && (
        <div className="rounded-xl border p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs" style={card}>
          <div><div style={muted}>Statement{s.statementDate ? ` to ${s.statementDate.slice(0, 10)}` : ''}</div><div className="text-sm font-semibold tabular-nums">{n2(s.statementBalance)}</div></div>
          <div><div style={muted}>+ In the books, not yet on it</div><div className="tabular-nums">{n2(s.inTransit)}</div></div>
          <div><div style={muted}>− Paid out, not yet on it</div><div className="tabular-nums">{n2(s.notPresented)}</div></div>
          <div><div style={muted}>− On it, not in the books</div><div className="tabular-nums" style={{ color: s.statementOnly ? '#ef4444' : undefined }}>{n2(s.statementOnly)}</div></div>
          <div><div style={muted}>= The books</div><div className="text-sm font-semibold tabular-nums">{n2(s.bookBalance)}</div></div>
          <div className="col-span-2 sm:col-span-3 self-center font-semibold" style={{ color: reconciled ? 'var(--primary)' : '#ef4444' }}>
            {reconciled
              ? `Reconciled.${s.unmatchedBook ? ` ${s.unmatchedBook} item(s) in transit, within 5 days.` : ''}`
              : `${s.unmatchedStatement} statement line(s) not in the books, ${s.staleBook} book item(s) more than 5 days old and not on the statement. Explain each.`}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs">
            <span style={muted}>Selected: books {n2(selBook)} · statement {n2(selStmt)}</span>
            <button disabled={!canMatch} onClick={() => void match()} className="px-3 py-1 rounded-lg font-semibold disabled:opacity-40"
                    style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>Match selected</button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {(['BOOK', 'STATEMENT'] as const).map((side) => (
              <div key={side} className="rounded-xl border overflow-x-auto" style={card}>
                <div className="px-3 py-2 text-xs font-semibold">{side === 'BOOK' ? 'In the books, not on the statement' : 'On the statement, not in the books'}</div>
                <div className="overflow-x-auto">
                  <table className="w-full"><tbody>
                    {items.filter((i) => i.side === side).map((i) => (
                      <tr key={i.side + i.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                        <td className={td}><input type="checkbox" checked={picked.has(i.side + i.id)} onChange={() => toggle(i)} /></td>
                        <td className={td} style={{ color: stale(i) ? '#ef4444' : undefined }}>{i.onDate.slice(0, 10)}</td>
                        <td className={td}>{i.description}<div style={muted}>{i.reference}</div></td>
                        <td className={td + ' text-right tabular-nums'}>{n2(i.amount)}</td>
                        <td className={td}>{side === 'STATEMENT' && <button className="underline" style={muted} onClick={() => setPost({ item: i, code: '6100', memo: i.description ?? '' })}>post</button>}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {account && !items.length && rec && <p className="text-xs" style={muted}>Nothing open.{account.lastStatement ? '' : ' Import a statement to begin.'}</p>}

      {post && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="w-full max-w-lg rounded-xl border p-5 space-y-3" style={card}>
            <h2 className="text-sm font-semibold">Post to the books: {post.item.description} ({n2(post.item.amount)})</h2>
            <p className="text-xs" style={muted}>
              For what only the statement knows — a charge, interest, a standing order. A customer payment, banking or a transfer
              is recorded on its own screen and then matched.
            </p>
            <select className="input-field text-xs w-full" value={post.code} onChange={(e) => setPost({ ...post, code: e.target.value })}>
              {postable.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
            <input className="input-field text-xs w-full" value={post.memo} onChange={(e) => setPost({ ...post, memo: e.target.value })} />
            <div className="flex gap-2">
              <button onClick={() => void doPost()} className="flex-1 py-2 rounded-lg text-xs font-semibold" style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>Post and match</button>
              <button onClick={() => setPost(null)} className="flex-1 py-2 rounded-lg text-xs" style={muted}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {modal === 'import' && account && <ImportStatement account={account} onClose={() => setModal('')} onDone={() => { setModal(''); void loadAccounts(); void loadRec(); }} />}
      {modal === 'transfer' && <Transfer accounts={accounts} onClose={() => setModal('')} onDone={() => { setModal(''); void loadAccounts(); void loadRec(); }} />}
      {modal === 'account' && <NewAccount onClose={() => setModal('')} onDone={() => { setModal(''); void loadAccounts(); }} />}
    </div>
  );
}
