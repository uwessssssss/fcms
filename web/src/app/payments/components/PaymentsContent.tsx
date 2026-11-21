'use client';
import { useStatement, field, num } from '@/lib/useStatement';
import { api, ApiError } from '@/lib/api';
import { useSites } from '@/lib/useSites';
import type { CashPositionView } from '@/types/api';
import { businessToday } from '@/lib/dates';
import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker } from '@/lib/checks';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { shiftLabelName } from '@/lib/shiftLabel';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

/**
 * A colour per channel, by name.
 *
 * This was MM_PROVIDERS: a fixed catalogue of eight providers across four
 * countries, matched against each record by an id like `mtn_ug`. The records
 * come from the statement, which carries the channel's NAME -- so no id ever
 * matched, every provider total was zero, and the filter that hides empty
 * providers removed the whole breakdown. Payments existed; the screen showed
 * none. Providers are now whatever channels the records actually carry.
 */
function providerColour(name: string): string {
  if (/mtn/i.test(name)) return '#f59e0b';
  if (/airtel/i.test(name)) return '#ef4444';
  if (/visa|card|master/i.test(name)) return '#60a5fa';
  return '#6b7280';
}

const VISA_BANKS = ['Stanbic Bank', 'Equity Bank', 'KCB Bank', 'Absa Bank', 'DFCU Bank', 'Centenary Bank', 'Other Visa/Mastercard'];

interface PaymentRecord {
  id: string;
  date: string;
  shift: string;   // Day, Mid or Night -- the station's own shift names (570)
  site: string;
  type: 'mobile_money' | 'visa';
  provider: string;
  transactionRef: string;
  customerPhone?: string;
  litres: number;
  amount: number;
  grade: string;
  attendant: string;
  status: 'confirmed' | 'pending' | 'failed';
}

const GRADES = ['Petrol', 'Diesel', 'Super Petrol', 'Premium Diesel'];

// Served by the statements registry: GET /api/statements/credit-payments
//
// This screen's content is a statement the server already produces --
// same query, same columns, same totals, already validated against the
// schema. Wiring it here rather than adding a fifth endpoint that would
// drift from the statement showing the same figures.
/**
 * Electronic tenders, from GET /api/statements/mobile-money
 *
 * The same statement an accountant prints to sit beside an MTN printout, so
 * this screen and that paper cannot disagree about a day's takings.
 */
function toPaymentRecord(r: Record<string, unknown>): PaymentRecord {
  const channel = field(r, 'channel');
  return {
    id: field(r, 'date') + field(r, 'reference') + field(r, 'amount'),
    date: field(r, 'date'),
    shift: shiftLabelName(field(r, 'shift')),
    site: field(r, 'site'),
    // The server records the CHANNEL -- MTN, Airtel, Visa, a fuel voucher --
    // and this screen has two buckets. Anything that is not a card is treated
    // as mobile money, which is true of every channel a station here takes.
    type: /visa|master|card/i.test(channel) ? 'visa' : 'mobile_money',
    provider: channel,
    transactionRef: field(r, 'reference'),
    // Litres are not on a tender row: the money arrived, and which litres it
    // paid for is a different question the sale answers.
    litres: 0,
    amount: num(r, 'amount'),
    grade: '',
    attendant: field(r, 'attendant'),
    // A tender that reached the statement was accepted. Pending and failed
    // belong to a payment gateway this station does not have.
    status: 'confirmed',
  } satisfies PaymentRecord;
}

const emptyForm: Omit<PaymentRecord, 'id'> = {
  date: businessToday(),
  shift: 'Day', site: '', type: 'mobile_money',
  provider: 'mtn_ug', transactionRef: '', customerPhone: '',
  litres: 0, amount: 0, grade: 'Petrol', attendant: '', status: 'confirmed',
};

function fmt(n: number) { return n.toLocaleString('en-UG'); }

const statusConfig = {
  confirmed: { label: 'Confirmed', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  pending: { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  failed: { label: 'Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
} as const;

export default function PaymentsContent() {
  const [partial, setPartial] = useState<string[]>([]);
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const { rows: liveRows, loading, error: loadError } =
    useStatement<PaymentRecord>('mobile-money', toPaymentRecord);

  const { isSiteManager, assignedSite } = useAuth();
  const [records, setRecords] = useState<PaymentRecord[]>([]);
  // Seeded from the server. Without this the hook fetched, the rows sat in
  // `liveRows`, and the table rendered this array -- which nothing ever filled.
  // The screen was blank while reporting no error at all.
  useEffect(() => setRecords(liveRows), [liveRows]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<PaymentRecord | null>(null);
  const [form, setForm] = useState<Omit<PaymentRecord, 'id'>>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'mobile_money' | 'visa'>('all');
  const [filterSite, setFilterSite] = useState('all');
  const [filterDate, setFilterDate] = useState('');
  const [activeTab, setActiveTab] = useState<'transactions' | 'summary'>('transactions');
  const { showToast } = useToast();

  // Site managers only see their own site's records
  const scopedRecords = isSiteManager && assignedSite
    ? records.filter((r) => !r.site || r.site === assignedSite)   // the API scopes a station's rows; some carry no site (W1)
    : records;

  const filtered = scopedRecords.filter((r) => {
    if (filterType !== 'all' && r.type !== filterType) return false;
    if (!isSiteManager && filterSite !== 'all' && r.site !== filterSite) return false;
    if (filterDate && r.date !== filterDate) return false;
    return true;
  });

  const mmTotal = filtered.filter(r => r.type === 'mobile_money').reduce((s, r) => s + r.amount, 0);
  const visaTotal = filtered.filter(r => r.type === 'visa').reduce((s, r) => s + r.amount, 0);
  const totalLitres = filtered.reduce((s, r) => s + r.litres, 0);

  // Provider summary
  const providerSummary = Array.from(
    filtered.reduce(
      (m, r) => m.set(r.provider, [...(m.get(r.provider) ?? []), r]),
      new Map<string, PaymentRecord[]>(),
    ),
  ).map(([name, rs]) => ({
    id: name,
    name,
    country: '',
    flag: '',
    color: providerColour(name),
    total: rs.reduce((t, r) => t + r.amount, 0),
    count: rs.length,
  }));

  const openAdd = () => { setEditing(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (r: PaymentRecord) => { setEditing(r); const { id, ...rest } = r; setForm(rest); setShowModal(true); };

  /**
   * Mobile money and card are not recorded here, and that is deliberate.
   *
   * Each electronic tender is declared at shift close, per attendant, against
   * their cash-up. That is what makes a missing MTN transfer somebody's
   * shortage rather than nobody's. A tender typed in on this screen would
   * belong to no cash-up and reconcile against nothing. This screen reads the
   * same statement an accountant prints beside the MTN and Airtel printouts.
   */
  /**
   * Bank the takings.
   *
   * Cash in a drawer is not banked money. Until a slip number exists against
   * it, a shortfall between what was declared and what reached the bank has
   * nobody's name on it -- which is why the slip is required rather than
   * optional.
   */
  // Cash in the station: collected at close but not yet banked. Every
  // shilling of it is a risk until the slip is in, so it is shown by day.
  const [cashPos, setCashPos] = useState<CashPositionView[]>([]);
  useEffect(() => {
    void api.get<CashPositionView[]>('/api/ops/cash-position?days=14').then(setCashPos).catch(() => setPartial((x) => (x.includes('the cash the station holds') ? x : [...x, 'the cash the station holds'])));
  }, []);
  const [banking, setBanking] = useState(false);
  const [bank, setBank] = useState({ amount: '', bankName: '', slipNo: '', accountRef: '' });

  // Banking more than the station holds means the figure is wrong, or the cash
  // came from somewhere the books do not know about.
  const onHandNow = cashPos.length ? [...cashPos].sort((a, b) => a.businessDate.localeCompare(b.businessDate)).slice(-1)[0].runningOnHand : null;
  const bankIssues = useMemo(() => {
    const c = new Checker();
    const amt = c.number('amount', bank.amount, 'The amount banked', { positive: true });
    c.required('bank', bank.bankName, 'The bank');
    c.required('slip', bank.slipNo, 'The slip number');
    if (amt !== null && onHandNow !== null && amt > onHandNow)
      c.warn('amount', `UGX ${amt.toLocaleString()} is more than the UGX ${Math.round(onHandNow).toLocaleString()} the station holds on the books - check the amount, or record where the extra cash came from`);
    return c.issues;
  }, [bank, onHandNow]);

  const bankCash = async () => {
      clearProblem('p0');
    const amount = Number(bank.amount);
    if (!(amount > 0) || !bank.bankName.trim() || !bank.slipNo.trim()) {
      flagProblem('p0', 'Amount, bank and slip number are all needed - a deposit without a slip cannot be traced'); return;
    }
    try {
      await api.post<unknown>('/api/ops/banking', {
        amount,
        bankName: bank.bankName.trim(),
        accountRef: bank.accountRef.trim() || null,
        slipNo: bank.slipNo.trim(),
        slipUrl: null,
        businessDate: businessToday(),
      }, { submission: 'banking' });
      setBanking(false);
      setBank({ amount: '', bankName: '', slipNo: '', accountRef: '' });
      showToast(`${amount.toLocaleString()} banked on slip ${bank.slipNo.trim()}`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleSave = useCallback(() => {
    showToast('Tenders are declared per attendant at shift close — that is what ties a missing transfer to a person', 'error');
    setShowModal(false);
  }, [showToast]);
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDelete = () => {
    showToast("A tender belongs to an attendant's cash-up and is never deleted.", 'error');
  };

  const getProviderName = (id: string) => id;
  const getProviderColor = (id: string) => providerColour(id);

  return (
    <>
      {cashPos.length > 0 && cashPos[0].runningOnHand > 0 && (
        <div className="px-4 pt-4">
          <div className="rounded-xl border p-4" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
            {/* The LATEST running balance -- rows arrive newest first. This summed
                the positive days only, which counted cash already banked on a
                later day as still sitting in the station. */}
            <p className="text-sm font-semibold text-foreground">
              Cash in the station: UGX {cashPos[0].runningOnHand.toLocaleString()} not yet banked
            </p>
            <div className="mt-2 space-y-1">
              {cashPos.map((c) => (
                <p key={c.businessDate} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {c.businessDate} · collected {c.cashCollected.toLocaleString()} · banked {c.cashBanked.toLocaleString()}
                  {' '}· <span style={{ color: c.runningOnHand > 0 ? '#F59E0B' : 'var(--foreground)' }}>{c.runningOnHand.toLocaleString()} held at day end</span>
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="px-4 pt-4">
        <div className="rounded-xl border p-4 space-y-2" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Bank the takings</h2>
            <button onClick={() => setBanking((b) => !b)} className="text-xs font-semibold"
                    style={{ color: 'var(--primary)' }}>
              {banking ? 'Close' : 'Record a deposit'}
            </button>
          </div>
          {banking && (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
              <input type="number" min={0} className="input-field text-xs" placeholder="Amount"
                     value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} />
              <input className="input-field text-xs" placeholder="Bank"
                     value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} />
              <input className="input-field text-xs" placeholder="Slip number"
                     value={bank.slipNo} onChange={(e) => setBank({ ...bank, slipNo: e.target.value })} />
              <input className="input-field text-xs" placeholder="Account ref (optional)"
                     value={bank.accountRef} onChange={(e) => setBank({ ...bank, accountRef: e.target.value })} />
              <IssueSummary issues={bankIssues} tried={!!problems.p0} />
              <FormProblem msg={problems.p0} />
              <button onClick={bankCash} className="py-2 rounded-lg text-xs font-semibold"
                      style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}>Bank it</button>
            </div>
          )}
        </div>
      </div>
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Mobile Money & Visa Payments</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            MTN, Airtel, M-Pesa, Tigo, HaloPesa, Visa/Mastercard transactions
          </p>
        </div>
        {/* This opened an eight-field form whose Save then refused: tenders are
            declared per attendant at shift close. Say so, and go there. (D2) */}
        <Link href="/shift-closure" className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          Declared at shift close <span aria-hidden="true">→</span>
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Mobile Money Total', value: `UGX ${fmt(mmTotal)}`, icon: 'DevicePhoneMobileIcon', color: '#f59e0b' },
          { label: 'Visa/Card Total', value: `UGX ${fmt(visaTotal)}`, icon: 'CreditCardIcon', color: '#3b82f6' },
          { label: 'Total Litres', value: `${fmt(totalLitres)} L`, icon: 'BeakerIcon', color: 'var(--primary)' },
          { label: 'Transactions', value: String(filtered.length), icon: 'ClipboardDocumentListIcon', color: '#22c55e' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${c.color}20` }}>
                <Icon name={c.icon as Parameters<typeof Icon>[0]['name']} size={16} style={{ color: c.color } as React.CSSProperties} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{c.label}</span>
            </div>
            <p className="text-base font-bold font-mono-nums text-foreground">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ backgroundColor: 'var(--muted)', border: '1px solid var(--border)' }}>
        {[{ key: 'transactions', label: 'Transactions', icon: 'TableCellsIcon' }, { key: 'summary', label: 'Provider Summary', icon: 'ChartBarIcon' }].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key as typeof activeTab)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all"
            style={{ backgroundColor: activeTab === tab.key ? 'var(--card)' : 'transparent', color: activeTab === tab.key ? 'var(--primary)' : 'var(--muted-foreground)', boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
            <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />{tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex gap-1 p-1 rounded-lg" style={{ backgroundColor: 'var(--muted)' }}>
          {[{ v: 'all', l: 'All' }, { v: 'mobile_money', l: 'Mobile Money' }, { v: 'visa', l: 'Visa/Card' }].map(opt => (
            <button key={opt.v} onClick={() => setFilterType(opt.v as typeof filterType)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-all"
              style={{ backgroundColor: filterType === opt.v ? 'var(--card)' : 'transparent', color: filterType === opt.v ? 'var(--primary)' : 'var(--muted-foreground)' }}>
              {opt.l}
            </button>
          ))}
        </div>
        {/* Site filter — head office only */}
        {isSiteManager && assignedSite ? (
          <span className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
            📍 {assignedSite}
          </span>
        ) : (
          <select value={filterSite} onChange={e => setFilterSite(e.target.value)} className="input-field py-1.5 px-3 text-xs">
            <option value="all">All Sites</option>
            {SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} className="input-field py-1.5 px-3 text-xs" />
      </div>

      {/* Transactions Table */}
      {activeTab === 'transactions' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  {['Status', 'Date', 'Shift', 'Site', 'Type', 'Provider', 'Ref', 'Phone', 'Grade', 'Litres', 'Amount', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const sc = statusConfig[r.status] ?? { ...Object.values(statusConfig)[0], label: String(r.status) };   // unknown value: neutral, not a crash
                  const provColor = r.type === 'mobile_money' ? getProviderColor(r.provider) : '#3b82f6';
                  return (
                    <tr key={r.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: sc.bg, color: sc.color }}>{sc.label}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{r.date}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.shift}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.site}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: r.type === 'mobile_money' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)', color: r.type === 'mobile_money' ? '#f59e0b' : '#3b82f6' }}>
                          {r.type === 'mobile_money' ? 'Mobile Money' : 'Visa/Card'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium" style={{ color: provColor }}>
                          {r.type === 'mobile_money' ? getProviderName(r.provider) : r.provider}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono-nums text-xs" style={{ color: 'var(--muted-foreground)' }}>{r.transactionRef}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs" style={{ color: 'var(--muted-foreground)' }}>{r.customerPhone ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.grade}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{r.litres} L</td>
                      <td className="px-4 py-3 font-mono-nums text-xs font-semibold text-foreground">UGX {fmt(r.amount)}</td>
                      <td className="px-4 py-3">
                        {/* Edit and Delete only ever refused: a tender is part of an
                            attendant's cash-up and is corrected there. (D2) */}
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>at close</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Provider Summary */}
      {activeTab === 'summary' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Mobile Money Providers */}
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="DevicePhoneMobileIcon" size={16} style={{ color: '#f59e0b' } as React.CSSProperties} />
                <h3 className="text-sm font-semibold text-foreground">Mobile Money by Provider</h3>
              </div>
              <div className="p-4 space-y-3">
                {providerSummary.map(p => {
                  const total = filtered.filter(r => r.provider === p.id).reduce((s, r) => s + r.amount, 0);
                  const count = filtered.filter(r => r.provider === p.id).length;
                  if (count === 0) return null;
                  const maxTotal = Math.max(...providerSummary.map(pp => filtered.filter(r => r.provider === pp.id).reduce((s, r) => s + r.amount, 0)));
                  return (
                    <div key={p.id} className="flex items-center gap-3">
                      <span className="text-base">{p.flag}</span>
                      <div className="flex-1">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs font-medium text-foreground">{p.name}</span>
                          <span className="text-xs font-mono-nums font-semibold text-foreground">UGX {fmt(total)}</span>
                        </div>
                        <div className="w-full h-2 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${maxTotal > 0 ? (total / maxTotal) * 100 : 0}%`, backgroundColor: p.color }} />
                        </div>
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{count} transactions</span>
                      </div>
                    </div>
                  );
                })}
                {providerSummary.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No mobile money transactions</p>}
              </div>
            </div>

            {/* Visa Summary */}
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="CreditCardIcon" size={16} style={{ color: '#3b82f6' } as React.CSSProperties} />
                <h3 className="text-sm font-semibold text-foreground">Visa/Card by Bank</h3>
              </div>
              <div className="p-4 space-y-3">
                {VISA_BANKS.map(bank => {
                  const total = filtered.filter(r => r.type === 'visa' && r.provider === bank).reduce((s, r) => s + r.amount, 0);
                  const count = filtered.filter(r => r.type === 'visa' && r.provider === bank).length;
                  if (count === 0) return null;
                  const maxTotal = Math.max(...VISA_BANKS.map(b => filtered.filter(r => r.type === 'visa' && r.provider === b).reduce((s, r) => s + r.amount, 0)));
                  return (
                    <div key={bank} className="flex items-center gap-3">
                      <div className="w-6 h-6 rounded flex items-center justify-center" style={{ backgroundColor: 'rgba(59,130,246,0.1)' }}>
                        <Icon name="CreditCardIcon" size={12} style={{ color: '#3b82f6' } as React.CSSProperties} />
                      </div>
                      <div className="flex-1">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs font-medium text-foreground">{bank}</span>
                          <span className="text-xs font-mono-nums font-semibold text-foreground">UGX {fmt(total)}</span>
                        </div>
                        <div className="w-full h-2 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                          <div className="h-full rounded-full" style={{ width: `${maxTotal > 0 ? (total / maxTotal) * 100 : 0}%`, backgroundColor: '#3b82f6' }} />
                        </div>
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{count} transactions</span>
                      </div>
                    </div>
                  );
                })}
                {filtered.filter(r => r.type === 'visa').length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No Visa transactions</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit Transaction' : 'Record Payment'} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input-field w-full text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Shift</label>
              <select value={form.shift} onChange={e => setForm(f => ({ ...f, shift: e.target.value as PaymentRecord['shift'] }))} className="input-field w-full text-sm">
                {['Day', 'Mid', 'Night'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Payment Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as PaymentRecord['type'], provider: e.target.value === 'mobile_money' ? 'mtn_ug' : 'Stanbic Bank' }))} className="input-field w-full text-sm">
                <option value="mobile_money">Mobile Money</option>
                <option value="visa">Visa/Card</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Provider</label>
              <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} className="input-field w-full text-sm">
                {form.type === 'mobile_money'
                  ? providerSummary.map(p => <option key={p.id} value={p.id}>{p.flag} {p.name}</option>)
                  : VISA_BANKS.map(b => <option key={b} value={b}>{b}</option>)
                }
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Transaction Ref *</label>
              <input type="text" value={form.transactionRef} onChange={e => setForm(f => ({ ...f, transactionRef: e.target.value }))} className="input-field w-full text-sm" placeholder="MTN-XXXXXXXXXX" />
            </div>
            {form.type === 'mobile_money' && (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Customer Phone</label>
                <input type="tel" value={form.customerPhone ?? ''} onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))} className="input-field w-full text-sm" placeholder="+256 7XX XXX XXX" />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Grade</label>
              <select value={form.grade} onChange={e => setForm(f => ({ ...f, grade: e.target.value }))} className="input-field w-full text-sm">
                {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Litres</label>
              <input type="number" value={form.litres || ''} onChange={e => setForm(f => ({ ...f, litres: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Amount (UGX)</label>
              <input type="number" value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Site</label>
              {isSiteManager && assignedSite ? (
                <div className="input-field w-full text-sm py-2 px-3 rounded-lg font-semibold" style={{ color: 'rgb(96,165,250)', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}>
                  {assignedSite}
                </div>
              ) : (
                <select value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} className="input-field w-full text-sm">
                  {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as PaymentRecord['status'] }))} className="input-field w-full text-sm">
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
            <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {editing ? 'Update' : 'Save Transaction'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Transaction" size="sm">
        <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>Delete this payment transaction? This cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
          <button onClick={handleDelete} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: '#ef4444', color: '#fff' }}>Delete</button>
        </div>
      </Modal>
    </div>
      <PartialLoadNotice missing={partial} />
    </>
  );
}
