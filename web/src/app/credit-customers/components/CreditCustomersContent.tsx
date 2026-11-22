'use client';
import { ApiError, api } from '@/lib/api';
import type { AgeingRow, CustomerLedgerRow, CustomerView, StatementLineRow } from '@/types/api';
import { useSites } from '@/lib/useSites';
import { businessToday, monthStartOf } from '@/lib/dates';
import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker } from '@/lib/checks';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';
import { shiftLabelName } from '@/lib/shiftLabel';
import CustomerPricesModal from '@/components/CustomerPricesModal';

interface CreditCustomer {
  id: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  creditLimit: number;
  balance: number;
  lastTransaction: string;
  status: 'active' | 'suspended' | 'overdue';
  site: string;
}

interface CreditTransaction {
  id: string;
  customerId: string;
  date: string;
  description: string;
  litres: number;
  amount: number;
  type: 'purchase' | 'payment';
  shift: string;
}


/**
 * Customers come from /api/credit/customers.
 *
 * The server has no company or email field -- this station identifies an
 * account by its CODE, which is what appears on a voucher and what an
 * attendant writes down. Mapping code into the company slot keeps the screen
 * showing the thing people actually use, rather than an empty column.
 */
function toCreditCustomer(r: CustomerView): CreditCustomer {
  return {
    id: r.id,
    name: r.name,
    company: r.code,
    phone: r.contactPhone ?? '',
    email: '',
    creditLimit: r.creditLimit,
    balance: r.balance,
    lastTransaction: r.oldestInvoice ? r.oldestInvoice.slice(0, 10) : '—',
    status: !r.isActive
      ? 'suspended'
      // Past their limit is not the same as past their terms, and this screen
      // has one status column. Over the limit is the one that stops a sale, so
      // it is the one shown.
      : r.headroom < 0
        ? 'overdue'
        : 'active',
    site: r.siteName,
  };
}

/**
 * A customer's account, from /api/credit/customers/:id/ledger
 *
 * Sales and payments in one sequence, because that is how a customer argues
 * about a balance: "I paid you on the 14th" only means something next to what
 * was drawn on the 12th.
 */
function toTransaction(r: CustomerLedgerRow): CreditTransaction {
  return {
    id: r.id,
    customerId: r.customerId,
    date: r.at.slice(0, 10),
    description: r.description,
    litres: r.litres,
    amount: Math.abs(r.amount),
    type: r.kind as CreditTransaction['type'],
    shift: shiftLabelName(r.shift),
  };
}

const emptyCustomer: Omit<CreditCustomer, 'id'> = {
  name: '', company: '', phone: '', email: '',
  creditLimit: 0, balance: 0, lastTransaction: businessToday(),
  status: 'active', site: '',
};

const emptyTx: Omit<CreditTransaction, 'id' | 'customerId'> = {
  date: businessToday(),
  description: '', litres: 0, amount: 0, type: 'purchase', shift: 'Day',
};

// Whole shillings, or two places -- never one ("164,993,729.1").
function fmt(n: number) { return n.toLocaleString('en-UG', Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const statusConfig = {
  active: { label: 'Active', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  suspended: { label: 'Suspended', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  overdue: { label: 'Overdue', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
} as const;

export default function CreditCustomersContent() {
  const [partial, setPartial] = useState<string[]>([]);
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const { isSiteManager, assignedSite } = useAuth();
  const [customers, setCustomers] = useState<CreditCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<CustomerView[]>('/api/credit/customers')
      .then((rows) => {
        if (!cancelled) {
          setCustomers(rows.map(toCreditCustomer));
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

  const [openCustomerId, setOpenCustomerId] = useState<string | null>(null);

  useEffect(() => {
    if (!openCustomerId) return;
    let cancelled = false;
    void api
      .get<CustomerLedgerRow[]>(`/api/credit/customers/${openCustomerId}/ledger`)
      .then((rows) => {
        if (!cancelled) setTransactions(rows.map(toTransaction));
      })
      .catch(() => {
        // The list still works without the history; leave it empty rather
        // than blanking the customer they just opened.
      });
    return () => {
      cancelled = true;
    };
  }, [openCustomerId]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showTxModal, setShowTxModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CreditCustomer | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CreditCustomer | null>(null);
  const [customerForm, setCustomerForm] = useState<Omit<CreditCustomer, 'id'>>(emptyCustomer);
  const [txForm, setTxForm] = useState<Omit<CreditTransaction, 'id' | 'customerId'>>(emptyTx);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [filterSite, setFilterSite] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [activeTab, setActiveTab] = useState<'customers' | 'transactions'>('customers');
  const { showToast } = useToast();

  // Site managers only see their own site's customers
  const scopedCustomers = isSiteManager && assignedSite
    ? customers.filter((c) => !c.site || c.site === assignedSite)   // rows carry no site; the API scopes them (W1)
    : customers;

  const filteredCustomers = scopedCustomers.filter((c) => {
    if (!isSiteManager && filterSite !== 'all' && c.site !== filterSite) return false;
    if (filterStatus !== 'all' && c.status !== filterStatus) return false;
    return true;
  });

  const customerTxs = selectedCustomer
    ? transactions.filter((t) => t.customerId === selectedCustomer.id)
    : transactions;

  const totalBalance = filteredCustomers.reduce((s, c) => s + c.balance, 0);
  const totalLimit = filteredCustomers.reduce((s, c) => s + c.creditLimit, 0);

  const openAddCustomer = () => {
    setEditingCustomer(null);
    setCustomerForm(emptyCustomer);
    setShowCustomerModal(true);
  };

  const openEditCustomer = (c: CreditCustomer) => {
    setEditingCustomer(c);
    const { id, ...rest } = c;
    setCustomerForm(rest);
    setShowCustomerModal(true);
  };

  /**
   * Create or update a credit account. The code is what goes on a voucher and
   * what an attendant writes down, so it is required and kept short.
   */
  // Take a payment against an account. It lands on the customer's ledger and
  // frees their headroom, which is what lets them fill up again. Recorded as
  // cash in a drawer instead, the account still reads unpaid and the truck is
  // turned away at the pump.
  // AGEING: who owes what, and for how long -- measured against each
  // customer's OWN terms, because 45 days is fine on 60-day terms and late
  // on 30. The statement is the document a trade customer is sent.
  const [ageing, setAgeing] = useState<AgeingRow[]>([]);
  const [stmtFor, setStmtFor] = useState<CreditCustomer | null>(null);
  const [stmt, setStmt] = useState<StatementLineRow[]>([]);
  const [stmtFrom, setStmtFrom] = useState(monthStartOf(businessToday()));
  const [stmtTo, setStmtTo] = useState(businessToday());

  useEffect(() => {
    void api.get<AgeingRow[]>('/api/credit/ageing').then(setAgeing).catch(() => setPartial((x) => (x.includes('who owes what, by age') ? x : [...x, 'who owes what, by age'])));
  }, []);

  useEffect(() => {
    if (!stmtFor) return;
    void api
      .get<StatementLineRow[]>(`/api/credit/customers/${stmtFor.id}/full-statement?from=${stmtFrom}&to=${stmtTo}`)
      .then(setStmt)
      .catch((e) => showToast((e as ApiError).message, 'error'));
  }, [stmtFor, stmtFrom, stmtTo, showToast]);

  const [payFor, setPayFor] = useState<CreditCustomer | null>(null);
  const [pricesFor, setPricesFor] = useState<CreditCustomer | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [payRef, setPayRef] = useState('');

  // More than the customer owes is now held as paid ahead (450) -- but it should be meant.
  const payIssues = useMemo(() => {
    const c = new Checker();
    const amt = c.number('amount', payAmount, 'The amount received', { positive: true, optional: true });
    if (amt !== null && payFor && amt > Math.max(0, payFor.balance))
      c.warn('amount', payFor.balance > 0
        ? `UGX ${amt.toLocaleString()} is more than the UGX ${payFor.balance.toLocaleString()} ${payFor.name} owes - the extra will be held as paid ahead`
        : `${payFor.name} owes nothing - all of this will be held as paid ahead`);
    return c.issues;
  }, [payAmount, payFor]);

  const takePayment = async () => {
      clearProblem('p0');
    if (!payFor) return;
    const amount = Number(payAmount);
    if (!(amount > 0)) {
      flagProblem('p0', 'Enter the amount received'); return;
    }
    try {
      await api.post<unknown>('/api/credit/payments', {
        customerId: payFor.id,
        amount,
        method: payMethod,
        reference: payRef.trim() || null,
        evidenceUrl: null,
      }, { submission: `credit-payment:${payFor.id}` });
      const rows = await api.get<CustomerView[]>('/api/credit/customers');
      setCustomers(rows.map(toCreditCustomer));
      setPayFor(null);
      setPayAmount('');
      setPayRef('');
      showToast(`${amount.toLocaleString()} received from ${payFor.name}`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleSaveCustomer = useCallback(async () => {
      clearProblem('p1');
    if (!customerForm.name.trim()) { flagProblem('p1', 'Customer name is required'); return; }
    const code = (customerForm.company || customerForm.name)
      .toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
    const body = {
      code,
      name: customerForm.name.trim(),
      contactPhone: customerForm.phone || null,
      creditLimit: customerForm.creditLimit,
      // Terms are per customer on the server; this form has no field for them
      // yet, so a new account gets thirty days and says so.
      paymentTermsDays: 30,
    };
    try {
      if (editingCustomer) {
        await api.put<unknown>(`/api/credit/customers/${editingCustomer.id}`, body);
      } else {
        await api.post<unknown>('/api/credit/customers', body, { idempotencyKey: `customer-${code}` });
      }
      const rows = await api.get<CustomerView[]>('/api/credit/customers');
      setCustomers(rows.map(toCreditCustomer));
      setShowCustomerModal(false);
      showToast(editingCustomer ? 'Customer updated' : `Customer ${code} added on 30-day terms`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  }, [customerForm, editingCustomer, showToast, clearProblem, flagProblem]);
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDeleteCustomer = () => {
    showToast('A credit customer with history is never deleted - statements and ageing refer to them. Set their limit to zero to stop further credit.', 'error');
  };

  const openAddTx = (customer: CreditCustomer) => {
    setSelectedCustomer(customer);
    setTxForm(emptyTx);
    setShowTxModal(true);
  };
  // A PAYMENT goes to the customer's ledger. A PURCHASE is refused here: a
  // credit sale is recorded against the shift it was sold in, where the
  // litres come from the meter. This used to write both into the screen,
  // move the balance, announce success -- and lose it all on reload.
  const handleSaveTx = async () => {
      clearProblem('p2');
    if (!selectedCustomer || txForm.amount <= 0) { flagProblem('p2', 'Enter a valid amount'); return; }
    if (txForm.type === 'purchase') {
      flagProblem('p2', 'A credit sale is recorded against the shift it was sold in, where the litres come from the meter - not typed in here.'); return;
    }
    try {
      await api.post<unknown>('/api/credit/payments', {
        customerId: selectedCustomer.id,
        amount: txForm.amount,
        method: 'CASH',
        reference: txForm.description?.trim() || null,
        evidenceUrl: null,
      }, { submission: `credit-payment:${selectedCustomer.id}` });
      const rows = await api.get<CustomerView[]>('/api/credit/customers');
      setCustomers(rows.map(toCreditCustomer));
      setShowTxModal(false);
      showToast('Payment recorded', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>Loading&hellip;</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    // An empty list reads as "there are none", which is a different and much
    // worse answer than "could not ask the server".
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not load credit customers
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Credit Customers</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Manage credit accounts, balances and transactions
          </p>
        </div>
        <button onClick={openAddCustomer} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
          <Icon name="UserPlusIcon" size={15} />Add Customer
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Customers', value: String(filteredCustomers.length), icon: 'UsersIcon', color: 'var(--primary)' },
          { label: 'Total Outstanding', value: `UGX ${fmt(totalBalance)}`, icon: 'BanknotesIcon', color: '#ef4444' },
          { label: 'Total Credit Limit', value: `UGX ${fmt(totalLimit)}`, icon: 'CreditCardIcon', color: '#3b82f6' },
          { label: 'Overdue Accounts', value: String(filteredCustomers.filter(c => c.status === 'overdue').length), icon: 'ExclamationTriangleIcon', color: '#f59e0b' },
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
        {[{ key: 'customers', label: 'Customers', icon: 'UsersIcon' }, { key: 'transactions', label: 'Transactions', icon: 'ClipboardDocumentListIcon' }].map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key as typeof activeTab)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all"
            style={{ backgroundColor: activeTab === tab.key ? 'var(--card)' : 'transparent', color: activeTab === tab.key ? 'var(--primary)' : 'var(--muted-foreground)', boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
            <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />{tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
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
        {activeTab === 'customers' && (
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input-field py-1.5 px-3 text-xs">
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="overdue">Overdue</option>
            <option value="suspended">Suspended</option>
          </select>
        )}
      </div>

      {/* Customers Table */}
      {activeTab === 'customers' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  {['Status', 'Customer', 'Company', 'Phone', 'Site', 'Credit Limit', 'Balance', 'Last Txn', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((c, i) => {
                  const sc = statusConfig[c.status] ?? { ...Object.values(statusConfig)[0], label: String(c.status) };   // unknown value: neutral, not a crash
                  const utilisation = c.creditLimit > 0 ? (c.balance / c.creditLimit) * 100 : 0;
                  return (
                    <tr key={c.id} style={{ borderBottom: i < filteredCustomers.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: sc.bg, color: sc.color }}>{sc.label}</span>
                      </td>
                      <td className="px-4 py-3 text-xs font-medium text-foreground">{c.name}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{c.company}</td>
                      <td className="px-4 py-3 text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{c.phone}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{c.site}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-foreground">UGX {fmt(c.creditLimit)}</td>
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-mono-nums text-xs font-semibold" style={{ color: utilisation > 90 ? '#ef4444' : utilisation > 70 ? '#f59e0b' : '#22c55e' }}>{c.balance < 0 ? `UGX ${fmt(-c.balance)} paid ahead` : `UGX ${fmt(c.balance)}`}</span>
                          <div className="w-20 h-1.5 rounded-full mt-1" style={{ backgroundColor: 'var(--muted)' }}>
                            <div className="h-full rounded-full" style={{ width: `${Math.min(utilisation, 100)}%`, backgroundColor: utilisation > 90 ? '#ef4444' : utilisation > 70 ? '#f59e0b' : '#22c55e' }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>{c.lastTransaction}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openAddTx(c)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Add Transaction">
                            <Icon name="PlusCircleIcon" size={14} style={{ color: '#22c55e' } as React.CSSProperties} />
                          </button>
                          <button
                            onClick={() => setStmtFor(c)}
                            title="Statement to send the customer"
                            className="px-2 py-1 mr-1 rounded-lg text-xs font-semibold"
                            style={{ background: 'var(--muted)', color: 'var(--foreground)' }}
                          >
                            Statement
                          </button>
                          <button
                            onClick={() => setPricesFor(c)}
                            title="Agreed prices for this customer"
                            className="px-2 py-1 mr-1 rounded-lg text-xs font-semibold"
                            style={{ background: 'var(--muted)', color: 'var(--foreground)' }}
                          >
                            Prices
                          </button>
                          <button
                            onClick={() => setPayFor(c)}
                            title="Record a payment"
                            className="px-2 py-1 mr-1 rounded-lg text-xs font-semibold"
                            style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                          >
                            Payment
                          </button>
                          <button onClick={() => openEditCustomer(c)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Edit">
                            <Icon name="PencilSquareIcon" size={14} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                          </button>
                          <button onClick={() => setDeleteTarget(c.id)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Delete">
                            <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' } as React.CSSProperties} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transactions Table */}
      {activeTab === 'transactions' && (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  {['Date', 'Customer', 'Type', 'Description', 'Litres', 'Amount', 'Shift'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customerTxs.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-6 text-xs text-center" style={{ color: 'var(--muted-foreground)' }}>No transactions in this period.</td></tr>
                )}
                {customerTxs.map((t, i) => {
                  const cust = customers.find(c => c.id === t.customerId);
                  return (
                    <tr key={t.id} style={{ borderBottom: i < customerTxs.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-xs text-foreground">{t.date}</td>
                      <td className="px-4 py-3 text-xs font-medium text-foreground">{cust?.name ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: t.type === 'purchase' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', color: t.type === 'purchase' ? '#ef4444' : '#22c55e' }}>
                          {t.type === 'purchase' ? 'Purchase' : 'Payment'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{t.description}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{t.litres > 0 ? `${t.litres} L` : '—'}</td>
                      <td className="px-4 py-3 font-mono-nums text-xs font-semibold" style={{ color: t.type === 'purchase' ? '#ef4444' : '#22c55e' }}>
                        {t.type === 'purchase' ? '-' : '+'}UGX {fmt(t.amount)}
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>{t.shift}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Customer Modal */}
      {ageing.length > 0 && (
        <div className="mx-4 mt-4 rounded-xl border overflow-x-auto" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold text-foreground p-3">Who owes what, and how long</h2>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--muted-foreground)' }}>
                {['Customer', 'Owed', '0-30', '31-60', '61-90', '90+', 'Past their terms', 'Paid ahead', 'Room left'].map((h) => (
                  <th key={h} className="text-left p-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* A customer in credit is shown too -- they vanished from this table. */}
              {ageing.filter((a) => a.balance > 0 || a.unappliedCredit > 0).map((a) => (
                <tr key={a.customerId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3 text-foreground">{a.name} <span style={{ color: 'var(--muted-foreground)' }}>{a.paymentTermsDays}d terms</span></td>
                  <td className="p-3 font-semibold">{a.balance.toLocaleString()}</td>
                  <td className="p-3">{a.current30.toLocaleString()}</td>
                  <td className="p-3">{a.days31To60.toLocaleString()}</td>
                  <td className="p-3" style={{ color: a.days61To90 > 0 ? '#F59E0B' : undefined }}>{a.days61To90.toLocaleString()}</td>
                  <td className="p-3" style={{ color: a.over90 > 0 ? '#ef4444' : undefined }}>{a.over90.toLocaleString()}</td>
                  <td className="p-3 font-semibold" style={{ color: a.pastTerms > 0 ? '#ef4444' : undefined }}>{a.pastTerms.toLocaleString()}</td>
                  <td className="p-3" style={{ color: a.unappliedCredit > 0 ? '#22c55e' : undefined }}>{a.unappliedCredit > 0 ? a.unappliedCredit.toLocaleString() : ''}</td>
                  <td className="p-3">{Math.max(0, a.headroom).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pricesFor && (
        <CustomerPricesModal customerId={pricesFor.id} customerName={pricesFor.name} onClose={() => setPricesFor(null)} />
      )}

      {stmtFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border p-5 space-y-3"
               style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-foreground">Statement - {stmtFor.name}</h2>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Every sale and payment in the period, with the running balance.
                </p>
              </div>
              <div className="flex gap-2">
                <input type="date" className="input-field text-xs" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)} />
                <input type="date" className="input-field text-xs" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)} />
              </div>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--muted-foreground)' }}>
                  {['Date', 'What', 'Reference', 'Vehicle', 'Litres', 'Charged', 'Paid', 'Balance'].map((h) => (
                    <th key={h} className="text-left p-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stmt.map((l, i) => (
                  <tr key={`${l.at}-${i}`} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="p-2">{new Date(l.at).toLocaleDateString()}</td>
                    <td className="p-2">{l.kind.toLowerCase().replace(/_/g, ' ')}</td>
                    <td className="p-2">{l.reference}</td>
                    <td className="p-2">{l.vehicle ?? ''}</td>
                    <td className="p-2">{l.litres === null ? '' : l.litres.toLocaleString()}</td>
                    <td className="p-2">{l.debit ? l.debit.toLocaleString() : ''}</td>
                    <td className="p-2">{l.credit ? l.credit.toLocaleString() : ''}</td>
                    <td className="p-2 font-semibold">{l.runningBalance.toLocaleString()}</td>
                  </tr>
                ))}
                {stmt.length === 0 && (
                  <tr><td colSpan={8} className="p-4 text-center" style={{ color: 'var(--muted-foreground)' }}>Nothing in this period.</td></tr>
                )}
              </tbody>
            </table>
            <div className="flex gap-2 justify-end">
              <button onClick={() => window.print()} className="px-3 py-2 rounded-xl text-sm font-semibold"
                      style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}>Print</button>
              <button onClick={() => { setStmtFor(null); setStmt([]); }} className="px-3 py-2 rounded-xl text-sm"
                      style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {payFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="w-full max-w-sm rounded-2xl border p-5 space-y-3" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold text-foreground">Record a payment</h2>
              <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                {payFor.name} - it lands on their ledger and frees their headroom.
              </p>
            </div>
            <input type="number" min={0} className="input-field w-full" placeholder="Amount received"
                   value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            <select className="input-field w-full" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank transfer</option>
              <option value="MOBILE_MONEY">Mobile money</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CONTRA">Contra</option>
            </select>
            <input className="input-field w-full" placeholder="Reference (slip or transaction no.)"
                   value={payRef} onChange={(e) => setPayRef(e.target.value)} />
            <IssueSummary issues={payIssues} tried={false} />
            <div className="flex gap-2 pt-1">
              <button onClick={() => setPayFor(null)} className="flex-1 py-2 rounded-xl text-sm"
                      style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={takePayment} className="flex-1 py-2 rounded-xl text-sm font-semibold"
                      style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}>Record</button>
            </div>
          </div>
        </div>
      )}

      <Modal isOpen={showCustomerModal} onClose={() => setShowCustomerModal(false)} title={editingCustomer ? 'Edit Customer' : 'Add Credit Customer'} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Full Name *</label>
              <input type="text" value={customerForm.name} onChange={e => setCustomerForm(f => ({ ...f, name: e.target.value }))} className="input-field w-full text-sm" placeholder="Customer name" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Company</label>
              <input type="text" value={customerForm.company} onChange={e => setCustomerForm(f => ({ ...f, company: e.target.value }))} className="input-field w-full text-sm" placeholder="Company name" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Phone</label>
              <input type="tel" value={customerForm.phone} onChange={e => setCustomerForm(f => ({ ...f, phone: e.target.value }))} className="input-field w-full text-sm" placeholder="+256 7XX XXX XXX" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Email</label>
              <input type="email" value={customerForm.email} onChange={e => setCustomerForm(f => ({ ...f, email: e.target.value }))} className="input-field w-full text-sm" placeholder="email@example.com" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Credit Limit (UGX)</label>
              <input type="number" value={customerForm.creditLimit || ''} onChange={e => setCustomerForm(f => ({ ...f, creditLimit: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Site</label>
              {isSiteManager && assignedSite ? (
                <div className="input-field w-full text-sm py-2 px-3 rounded-lg font-semibold" style={{ color: 'rgb(96,165,250)', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}>
                  {assignedSite}
                </div>
              ) : (
                <select value={customerForm.site} onChange={e => setCustomerForm(f => ({ ...f, site: e.target.value }))} className="input-field w-full text-sm">
                  {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Status</label>
            <select value={customerForm.status} onChange={e => setCustomerForm(f => ({ ...f, status: e.target.value as CreditCustomer['status'] }))} className="input-field w-full text-sm">
              <option value="active">Active</option>
              <option value="overdue">Overdue</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowCustomerModal(false)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
            <FormProblem msg={problems.p1} />
            <button onClick={handleSaveCustomer} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {editingCustomer ? 'Update' : 'Add Customer'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Transaction Modal */}
      <Modal isOpen={showTxModal} onClose={() => setShowTxModal(false)} title={`Record Transaction — ${selectedCustomer?.name}`} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Type</label>
              <select value={txForm.type} onChange={e => setTxForm(f => ({ ...f, type: e.target.value as CreditTransaction['type'] }))} className="input-field w-full text-sm">
                <option value="purchase">Purchase (Fuel)</option>
                <option value="payment">Payment (Credit)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Date</label>
              <input type="date" value={txForm.date} onChange={e => setTxForm(f => ({ ...f, date: e.target.value }))} className="input-field w-full text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Description</label>
            <input type="text" value={txForm.description} onChange={e => setTxForm(f => ({ ...f, description: e.target.value }))} className="input-field w-full text-sm" placeholder="e.g. Diesel fill — 2 trucks" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {txForm.type === 'purchase' && (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Litres</label>
                <input type="number" value={txForm.litres || ''} onChange={e => setTxForm(f => ({ ...f, litres: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Amount (UGX)</label>
              <input type="number" value={txForm.amount || ''} onChange={e => setTxForm(f => ({ ...f, amount: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowTxModal(false)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
            <FormProblem msg={problems.p2} />
            <button onClick={handleSaveTx} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>Save Transaction</button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Remove Customer" size="sm">
        <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>Remove this credit customer? All their transaction history will remain.</p>
        <div className="flex justify-end gap-3">
          <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
          <button onClick={handleDeleteCustomer} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: '#ef4444', color: '#fff' }}>Remove</button>
        </div>
      </Modal>
      <PartialLoadNotice missing={partial} />
    </div>
  );
}
