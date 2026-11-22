'use client';
import { useStatement, field, num } from '@/lib/useStatement';
import { api, ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { useSites } from '@/lib/useSites';
import { businessToday, localDate } from '@/lib/dates';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useCallback, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

interface Expense {
  /** Carried from the statement so it can be approved from here. */
  expenseId?: string;
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  paymentMethod: 'cash' | 'mobile_money' | 'bank';
  approvedBy: string;
  receipt: string;
  site: string;
}

const CATEGORIES = ['Fuel Purchase', 'Maintenance', 'Cleaning', 'Utilities', 'Staff Welfare', 'Stationery', 'Security', 'Transport', 'Other'];

// Served by the statements registry: GET /api/statements/expenses
//
// This screen's content is a statement the server already produces --
// same query, same columns, same totals, already validated against the
// schema. Wiring it here rather than adding a fifth endpoint that would
// drift from the statement showing the same figures.
/**
 * Expenses come from the statements registry: GET /api/statements/expenses
 *
 * Same query, columns and totals as the Expenses statement, so this screen and
 * that statement cannot show different numbers for the same month -- which is
 * what a second endpoint would eventually have produced.
 */
function toExpense(r: Record<string, unknown>): Expense {
  const paid = field(r, 'paid_from').toUpperCase();
  return {
    id: field(r, 'date') + '-' + field(r, 'description').slice(0, 24),
    // The real id, carried by the statement so this row can be approved.
    expenseId: field(r, 'expense_id') || undefined,
    date: field(r, 'date'),
    category: field(r, 'category'),
    description: field(r, 'description'),
    amount: num(r, 'amount'),
    paymentMethod:
      paid.includes('TILL') || paid.includes('CASH')
        ? 'cash'
        : paid.includes('MOMO') || paid.includes('MOBILE')
          ? 'mobile_money'
          : 'bank',
    // The server records approval as a status, not a name. An unapproved
    // expense has nobody to name, and inventing one would be a lie on an
    // audit trail.
    approvedBy: field(r, 'status'),
    receipt: field(r, 'reference'),
    site: field(r, 'site'),
  };
}

const emptyForm: Omit<Expense, 'id'> = {
  date: businessToday(),
  category: 'Maintenance',
  description: '',
  amount: 0,
  paymentMethod: 'cash',
  approvedBy: '',
  receipt: '',
  site: '',
};

function fmt(n: number) {
  return n.toLocaleString('en-UG');
}

const pmLabel: Record<string, string> = { cash: 'Cash', mobile_money: 'Mobile Money', bank: 'Bank Transfer' };
const pmColor: Record<string, string> = { cash: '#22c55e', mobile_money: '#f59e0b', bank: '#3b82f6' };

export default function ExpensesContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const { isSiteManager, assignedSite } = useAuth();
  const {
    rows: liveExpenses,
    loading: loadingExpenses,
    error: expensesError,
    reload: reloadExpenses,
  } = useStatement<Expense>('expenses', toExpense);

  // Local state so a newly recorded expense appears at once, seeded from the
  // server whenever the fetch returns.
  const [expenses, setExpenses] = useState<Expense[]>([]);
  useEffect(() => setExpenses(liveExpenses), [liveExpenses]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState<Omit<Expense, 'id'>>({
    ...emptyForm,
    site: (isSiteManager && assignedSite) ? assignedSite : emptyForm.site,
  });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [filterSite, setFilterSite] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterDate, setFilterDate] = useState('');
  const { showToast } = useToast();

  // Site managers only see their own site's expenses
  const scopedExpenses = isSiteManager && assignedSite
    ? expenses.filter((e) => !e.site || e.site === assignedSite)   // the API scopes a station's rows; some carry no site (W1)
    : expenses;

  const filtered = scopedExpenses.filter((e) => {
    if (!isSiteManager && filterSite !== 'all' && e.site !== filterSite) return false;
    if (filterCategory !== 'all' && e.category !== filterCategory) return false;
    if (filterDate && e.date !== filterDate) return false;
    return true;
  });

  const totalAmount = filtered.reduce((s, e) => s + e.amount, 0);

  const openAdd = () => {
    setEditing(null);
    setForm({
      ...emptyForm,
      site: (isSiteManager && assignedSite) ? assignedSite : emptyForm.site,
    });
    setShowModal(true);
  };

  const openEdit = (exp: Expense) => {
    setEditing(exp);
    const { id, ...rest } = exp;
    setForm(rest);
    setShowModal(true);
  };

  /**
   * Record an expense. New entries only: a recorded expense is corrected by a
   * correcting entry, so the original stays on the trail an auditor reads.
   */
  /**
   * Approve an expense.
   *
   * A recorded expense is a claim; an approved one is a cost. Until somebody
   * with the authority signs it, it should not be reducing anybody's profit --
   * which is why recording and approving are two acts, by two people.
   */
  const approve = async (id?: string) => {
      clearProblem('p0');
    if (!id) {
      flagProblem('p0', 'This expense predates approval tracking'); return;
    }
    try {
      await api.post<unknown>(`/api/accounts/expenses/${id}/approve`, {});
      reloadExpenses();
      showToast('Expense approved', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleSave = useCallback(async () => {
      clearProblem('p1');
    if (!form.description.trim() || form.amount <= 0) {
      flagProblem('p1', 'Please fill in description and a valid amount'); return;
    }
    if (editing) {
      flagProblem('p1', 'A recorded expense is not edited — record a correcting entry instead'); return;
    }
    // The server's categories are a fixed list; the screen's are free text.
    // Nearest match, else OTHER -- never an invented category the enum refuses.
    const CATS = ['WAGES', 'POWER', 'WATER', 'SECURITY', 'REPAIRS', 'MAINTENANCE',
      'TRANSPORT', 'LICENCES', 'RENT', 'CONSUMABLES', 'BANK_CHARGES', 'OTHER'];
    const want = form.category.toUpperCase().replace(/[^A-Z]+/g, '_');
    const category = CATS.find((c) => want.includes(c) || (want.length > 3 && c.startsWith(want))) ?? 'OTHER';
    try {
      await api.post<{ id: string }>('/api/accounts/expenses', {
        businessDate: form.date,
        category,
        description: form.description.trim(),
        amount: form.amount,
        // Till cash spent is cash that will never reach the bank, which is why
        // the server keeps the pocket it came out of.
        paidFrom: form.paymentMethod === 'cash' ? 'TILL_CASH'
          : form.paymentMethod === 'mobile_money' ? 'MOBILE_MONEY' : 'BANK',
        reference: form.receipt || null,
        supplierId: null,
        receiptUrl: null,
      }, {
        // Derived from the expense itself, so a retried submission is the SAME
        // submission and is recorded once. A fresh uuid per attempt would make
        // the header present and the protection absent.
        submission: 'expense',
      });
      reloadExpenses();
      setShowModal(false);
      showToast(`Expense recorded under ${category.toLowerCase().replace('_', ' ')}`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  }, [form, editing, showToast, reloadExpenses, clearProblem, flagProblem]);
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDelete = () => {
    showToast('An expense is part of the ledger - recorded once, never edited or deleted. A correction is a new entry, so the original stays on the trail.', 'error');
  };

  const handleExport = () => {
    const headers = ['Date', 'Site', 'Category', 'Description', 'Amount (UGX)', 'Payment Method', 'Approved By', 'Receipt'];
    const rows = filtered.map((e) => [e.date, e.site, e.category, e.description, e.amount, pmLabel[e.paymentMethod], e.approvedBy, e.receipt]);
    // Quoted cells: a location like "Kiboga town, Hoima Rd" shifted every
    // column after it when cells were joined with bare commas. (W7)
    downloadCsv(`expenses-${localDate()}.csv`, headers.map(String), rows);
    showToast('Expenses exported', 'success');
  };

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Expenses</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Track and manage all forecourt operational expenses
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>
            <Icon name="ArrowDownTrayIcon" size={15} />Export
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
            <Icon name="PlusIcon" size={15} />Add Expense
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Expenses', value: `UGX ${fmt(totalAmount)}`, icon: 'BanknotesIcon', color: '#ef4444' },
          { label: 'Today', value: `UGX ${fmt(filtered.filter(e => e.date === businessToday()).reduce((s,e)=>s+e.amount,0))}`, icon: 'CalendarDaysIcon', color: 'var(--primary)' },
          { label: 'Cash Paid', value: `UGX ${fmt(filtered.filter(e=>e.paymentMethod==='cash').reduce((s,e)=>s+e.amount,0))}`, icon: 'BanknotesIcon', color: '#22c55e' },
          { label: 'Mobile Money', value: `UGX ${fmt(filtered.filter(e=>e.paymentMethod==='mobile_money').reduce((s,e)=>s+e.amount,0))}`, icon: 'DevicePhoneMobileIcon', color: '#f59e0b' },
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

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Site filter — head office only */}
        {!isSiteManager ? (
          <select value={filterSite} onChange={e => setFilterSite(e.target.value)} className="input-field py-1.5 px-3 text-xs">
            <option value="all">All Sites</option>
            {SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : (
          <span className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
            📍 {assignedSite}
          </span>
        )}
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="input-field py-1.5 px-3 text-xs">
          <option value="all">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} className="input-field py-1.5 px-3 text-xs" />
        {(filterSite !== 'all' || filterCategory !== 'all' || filterDate) && (
          <button onClick={() => { setFilterSite('all'); setFilterCategory('all'); setFilterDate(''); }} className="text-xs px-3 py-1.5 rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}>
            Clear Filters
          </button>
        )}
        <span className="ml-auto text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{filtered.length} records</span>
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="overflow-x-auto">
          <FormProblem msg={problems.p0} />
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                {['Date', 'Site', 'Category', 'Description', 'Amount', 'Payment', 'Approved By', 'Receipt', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--muted-foreground)' }}>No expenses found</td></tr>
              ) : filtered.map((exp, i) => (
                <tr key={exp.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{exp.date}</td>
                  <td className="px-4 py-3 text-xs text-foreground">{exp.site}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'var(--muted)', color: 'var(--foreground)' }}>{exp.category}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground max-w-[180px] truncate" title={exp.description}>{exp.description}</td>
                  <td className="px-4 py-3 font-mono-nums text-xs font-semibold text-foreground">UGX {fmt(exp.amount)}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${pmColor[exp.paymentMethod]}20`, color: pmColor[exp.paymentMethod] }}>{pmLabel[exp.paymentMethod]}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground">{exp.approvedBy}</td>
                  <td className="px-4 py-3 text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{exp.receipt}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {!exp.approvedBy && (
                        <button
                          onClick={() => approve(exp.expenseId)}
                          title="Approve this expense"
                          className="px-2 py-1 mr-1 rounded-lg text-xs font-semibold"
                          style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}
                        >
                          Approve
                        </button>
                      )}
                      <button onClick={() => openEdit(exp)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Edit">
                        <Icon name="PencilSquareIcon" size={14} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                      </button>
                      <button onClick={() => setDeleteTarget(exp.id)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Delete">
                        <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' } as React.CSSProperties} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td colSpan={5} className="px-4 py-3 text-xs font-bold text-foreground">TOTAL ({filtered.length} expenses)</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: '#ef4444' }}>UGX {fmt(totalAmount)}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit Expense' : 'Record Expense'} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Date</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input-field w-full text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Site</label>
              {isSiteManager && assignedSite ? (
                <div className="input-field w-full text-sm font-semibold py-2 px-3 rounded-lg" style={{ color: 'rgb(96,165,250)', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}>
                  {assignedSite}
                </div>
              ) : (
                <select value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} className="input-field w-full text-sm">
                  {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="input-field w-full text-sm">
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Description</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-field w-full text-sm" placeholder="Describe the expense..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Amount (UGX)</label>
              <input type="number" value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: Number(e.target.value) }))} className="input-field w-full text-sm" placeholder="0" min="0" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Payment Method</label>
              <select value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value as Expense['paymentMethod'] }))} className="input-field w-full text-sm">
                <option value="cash">Cash</option>
                <option value="mobile_money">Mobile Money</option>
                <option value="bank">Bank Transfer</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Approved By</label>
              <input type="text" value={form.approvedBy} onChange={e => setForm(f => ({ ...f, approvedBy: e.target.value }))} className="input-field w-full text-sm" placeholder="Manager name" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Receipt No.</label>
              <input type="text" value={form.receipt} onChange={e => setForm(f => ({ ...f, receipt: e.target.value }))} className="input-field w-full text-sm" placeholder="RCP-XXX" />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
            <FormProblem msg={problems.p1} />
            <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {editing ? 'Update Expense' : 'Save Expense'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Expense" size="sm">
        <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>Are you sure you want to delete this expense? This action cannot be undone.</p>
        <div className="flex justify-end gap-3">
          <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
          <button onClick={handleDelete} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: '#ef4444', color: '#fff' }}>Delete</button>
        </div>
      </Modal>
    </div>
  );
}
