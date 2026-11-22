'use client';
import { useCan } from '@/lib/useCan';
import { api, ApiError } from '@/lib/api';
import type { IncomeCategoryRow, IncomeRow } from '@/types/api';
import { useSites } from '@/lib/useSites';
import { businessToday } from '@/lib/dates';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

interface IncomeItem {
  id: string;
  date: string;
  site: string;
  service: string;
  category: string;
  quantity: number;
  unitPrice: number;
  total: number;
  paymentMethod: string;
  attendant: string;
  notes?: string;
}

const SERVICES = [
  { label: 'Carwash – Basic', category: 'Carwash', defaultPrice: 10000 },
  { label: 'Carwash – Full Wash', category: 'Carwash', defaultPrice: 20000 },
  { label: 'Carwash – Premium Detail', category: 'Carwash', defaultPrice: 45000 },
  { label: 'Tyre Inflation', category: 'Tyre Services', defaultPrice: 2000 },
  { label: 'Tyre Repair (Puncture)', category: 'Tyre Services', defaultPrice: 8000 },
  { label: 'Tyre Rotation', category: 'Tyre Services', defaultPrice: 15000 },
  { label: 'Oil Change Service', category: 'Mechanical', defaultPrice: 25000 },
  { label: 'Battery Jump Start', category: 'Mechanical', defaultPrice: 5000 },
  { label: 'Air Filter Check', category: 'Mechanical', defaultPrice: 5000 },
  { label: 'Parking Fee', category: 'Other', defaultPrice: 3000 },
  { label: 'Convenience Store', category: 'Other', defaultPrice: 0 },
];

const CATEGORIES = ['All', 'Carwash', 'Tyre Services', 'Mechanical', 'Other'];
const PAYMENT_METHODS = ['Cash', 'MTN Mobile Money', 'Airtel Money', 'M-Pesa', 'Visa/Card'];

/**
 * Non-fuel income, from GET /api/v1/income
 *
 * Kept out of every fuel figure on purpose: it carries no litres, and folding
 * it into fuel revenue would make a busy car wash look like a more profitable
 * forecourt per litre than it is.
 */
function toIncomeItem(r: IncomeRow): IncomeItem {
  return {
    id: r.id,
    date: r.businessDate,
    site: r.site,
    service: r.description,
    category: r.category,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    total: r.amount,
    // Were missing (hidden by a cast): the Payment and Attendant columns were
    // blank for every row. (W3)
    paymentMethod: ({ CASH: 'Cash', MOBILE_MONEY: 'Mobile money', CARD: 'Card', ACCOUNT: 'On account' } as Record<string, string>)[r.settlement] ?? r.settlement,
    attendant: r.recordedBy,
  } satisfies IncomeItem;
}

const EMPTY_ITEM: Omit<IncomeItem, 'id'> = {
  date: businessToday(), site: '', service: 'Carwash – Basic',
  category: 'Carwash', quantity: 1, unitPrice: 10000, total: 10000, paymentMethod: 'Cash', attendant: '', notes: '',
};

function fmt(n: number, dec = 0) { return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

export default function OtherIncomeContent() {
  const can = useCan();
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { isSiteManager, assignedSite } = useAuth();
  const [income, setIncome] = useState<IncomeItem[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [siteFilter, setSiteFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<IncomeItem, 'id'>>(EMPTY_ITEM);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<IncomeRow[]>('/api/v1/income')
      .then((rows) => {
        if (!cancelled) {
          setIncome(rows.map(toIncomeItem));
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
  const { showToast } = useToast();

  const scopedIncome = isSiteManager && assignedSite
    ? income.filter((i) => !i.site || i.site === assignedSite)   // the API scopes a station's rows; some carry no site (W1)
    : income;

  const filtered = scopedIncome.filter(i => {
    if (categoryFilter !== 'All' && i.category !== categoryFilter) return false;
    if (!isSiteManager && siteFilter !== 'all' && i.site !== siteFilter) return false;
    if (dateFrom && i.date < dateFrom) return false;
    if (dateTo && i.date > dateTo) return false;
    return true;
  });

  const totalRevenue = filtered.reduce((s, i) => s + i.total, 0);
  const byCategory = CATEGORIES.slice(1).map(cat => ({
    cat,
    total: income.filter(i => i.category === cat).reduce((s, i) => s + i.total, 0),
    count: income.filter(i => i.category === cat).length,
  }));

  const openAdd = () => {
  setEditId(null);
  setForm({ ...EMPTY_ITEM, site: (isSiteManager && assignedSite) ? assignedSite : EMPTY_ITEM.site });
  setShowModal(true);
};
  const openEdit = (item: IncomeItem) => { setEditId(item.id); const { id, ...rest } = item; setForm(rest); setShowModal(true); };

  /**
   * Record a line of non-fuel income.
   *
   * NEW ROWS ONLY. other_income is append-only by design: a correction is a
   * new row with a note, so the original stays visible -- which is what makes
   * it a ledger rather than a spreadsheet. This screen used to edit and delete
   * records in local state and report success; the database would have
   * refused both, and nothing on screen would have said so.
   */
  const handleSave = async () => {
      clearProblem('p0');
    if (editId) {
      flagProblem('p0', 'Income is never edited — record a correcting line with a note instead'); return;
    }
    try {
      // The category by name, falling back to OTHER. The server holds the list
      // a company controls; this screen's service picker only suggests one.
      const cats = await api.get<IncomeCategoryRow[]>('/api/v1/income/categories');
      const want = (form.category || form.service || '').toLowerCase();
      const cat =
        cats.find((c) => c.name.toLowerCase() === want || c.code.toLowerCase() === want) ??
        cats.find((c) => want.includes(c.name.toLowerCase().split(' ')[0] ?? '~')) ??
        cats.find((c) => c.code === 'OTHER');
      if (!cat) {
        flagProblem('p0', 'No income categories exist for this company yet'); return;
      }

      const pm = (form.paymentMethod || 'cash').toLowerCase();
      await api.post<{ id: string }>('/api/v1/income', {
        categoryId: cat.id,
        businessDate: form.date,
        description: form.service + (form.notes ? ` — ${form.notes}` : ''),
        quantity: form.quantity,
        unitPrice: form.unitPrice,
        settlement: /mobile|momo|mtn|airtel/.test(pm)
          ? 'MOBILE_MONEY'
          : /card|visa/.test(pm)
            ? 'CARD'
            : /account|credit/.test(pm)
              ? 'ACCOUNT'
              : 'CASH',
        reference: null,
      }, {
        submission: 'other-income',
      });

      // Re-read rather than inventing the row: the server computes the total
      // and assigns the id, and a guessed row would differ from what everyone
      // else sees.
      const rows = await api.get<IncomeRow[]>('/api/v1/income');
      setIncome(rows.map(toIncomeItem));
      setShowModal(false);
      showToast('Income recorded', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleDelete = (_id: string) => {
    // Append-only. A delete here would be refused by the database, so it is
    // refused here first, with the reason.
    showToast('Income is never deleted — record a correcting line instead', 'error');
  };

  const updateForm = (field: keyof typeof form, value: string | number) => {
    setForm(prev => {
      const updated = { ...prev, [field]: value };
      if (field === 'service') {
        const svc = SERVICES.find(s => s.label === value);
        if (svc) { updated.category = svc.category; updated.unitPrice = svc.defaultPrice; }
      }
      return updated;
    });
  };

  const categoryColors: Record<string, string> = { Carwash: '#3b82f6', 'Tyre Services': '#f59e0b', Mechanical: '#8b5cf6', Other: '#22c55e' };

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
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not load other income
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="rounded-2xl border w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-6 py-4 border-b flex items-center justify-between sticky top-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}>
              <h3 className="text-base font-bold text-foreground">{editId ? 'Edit Income Record' : 'Record Income'}</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-muted" aria-label="Close" title="Close">
                <Icon name="XMarkIcon" size={16} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Date</label>
                  <input type="date" value={form.date} onChange={e => updateForm('date', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Site</label>
                  {isSiteManager && assignedSite ? (
                    <div className="input-field py-2 px-3 text-sm w-full rounded-lg font-semibold" style={{ color: 'rgb(96,165,250)', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}>
                      {assignedSite}
                    </div>
                  ) : (
                    <select value={form.site} onChange={e => updateForm('site', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg">
                      {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Service</label>
                  <select value={form.service} onChange={e => updateForm('service', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg">
                    {SERVICES.map(s => <option key={s.label} value={s.label}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Quantity</label>
                  <input type="number" value={form.quantity || ''} onChange={e => updateForm('quantity', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" min="1" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Unit Price (UGX)</label>
                  <input type="number" value={form.unitPrice || ''} onChange={e => updateForm('unitPrice', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Payment Method</label>
                  <select value={form.paymentMethod} onChange={e => updateForm('paymentMethod', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg">
                    {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Attendant</label>
                  <input type="text" value={form.attendant} onChange={e => updateForm('attendant', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" placeholder="Name" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Notes (optional)</label>
                  <input type="text" value={form.notes || ''} onChange={e => updateForm('notes', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" placeholder="Optional notes" />
                </div>
              </div>
              <div className="p-3 rounded-lg" style={{ backgroundColor: 'rgba(0,212,160,0.08)', border: '1px solid rgba(0,212,160,0.15)' }}>
                <p className="text-sm font-bold" style={{ color: 'var(--primary)' }}>Total: UGX {fmt(form.quantity * form.unitPrice)}</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t flex gap-3 justify-end" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-xl text-sm font-medium border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={handleSave} className="px-4 py-2 rounded-xl text-sm font-bold" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                {editId ? 'Save Changes' : 'Record Income'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Other Income</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Carwash, tyre services, mechanical work and other non-fuel revenue</p>
        </div>
        {can('dry_sale.record') && (
          <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
            <Icon name="PlusIcon" size={16} />Record Income
          </button>
        )}
      </div>

      {/* Category Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {byCategory.map(c => (
          <div key={c.cat} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${categoryColors[c.cat]}20` }}>
                <Icon name={c.cat === 'Carwash' ? 'SparklesIcon' : c.cat === 'Tyre Services' ? 'WrenchScrewdriverIcon' : c.cat === 'Mechanical' ? 'WrenchIcon' : 'CurrencyDollarIcon'} size={16} style={{ color: categoryColors[c.cat] } as React.CSSProperties} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{c.cat}</span>
            </div>
            <p className="text-lg font-bold font-mono-nums text-foreground">UGX {fmt(c.total / 1000)}k</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{c.count} transactions</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-xl border p-4 flex flex-wrap items-center gap-3" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <Icon name="FunnelIcon" size={15} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
        <div className="flex gap-1 p-0.5 rounded-lg" style={{ backgroundColor: 'var(--muted)' }}>
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setCategoryFilter(c)} className="px-3 py-1 rounded-md text-xs font-medium transition-all" style={{ backgroundColor: categoryFilter === c ? 'var(--primary)' : 'transparent', color: categoryFilter === c ? 'var(--primary-foreground)' : 'var(--muted-foreground)' }}>{c}</button>
          ))}
        </div>
        {isSiteManager && assignedSite ? (
          <span className="px-3 py-1.5 rounded-lg text-sm font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
            📍 {assignedSite}
          </span>
        ) : (
          <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg">
            <option value="all">All Sites</option>
            {SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>From</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>To</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg" />
        </div>
        <div className="ml-auto font-bold text-sm" style={{ color: 'var(--primary)' }}>
          Total: UGX {fmt(totalRevenue)}
        </div>
      </div>

      {/* Income Table */}
      <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                {['Date', 'Site', 'Service', 'Category', 'Qty', 'Unit Price', 'Total', 'Payment', 'Recorded by', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, idx) => (
                <tr key={item.id} style={{ borderBottom: idx < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/40 transition-colors">
                  <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{item.date}</td>
                  <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{item.site}</td>
                  <td className="px-4 py-3 text-xs font-medium text-foreground">{item.service}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${categoryColors[item.category]}20`, color: categoryColors[item.category] }}>{item.category}</span>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{item.quantity}</td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{fmt(item.unitPrice)}</td>
                  <td className="px-4 py-3 text-xs font-mono-nums font-bold" style={{ color: '#22c55e' }}>UGX {fmt(item.total)}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>{item.paymentMethod}</td>
                  <td className="px-4 py-3 text-xs text-foreground">{item.attendant}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {can('dry_sale.record') && (<button onClick={() => openEdit(item)} className="p-1.5 rounded-lg hover:bg-muted" aria-label="Edit" title="Edit">
                        <Icon name="PencilSquareIcon" size={13} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                      </button>)}
                      {can('dry_sale.record') && (<button onClick={() => handleDelete(item.id)} className="p-1.5 rounded-lg hover:bg-muted" aria-label="Delete" title="Delete">
                        <Icon name="TrashIcon" size={13} style={{ color: '#ef4444' } as React.CSSProperties} />
                      </button>)}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>No income records found</td></tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td colSpan={6} className="px-4 py-3 text-xs font-bold text-foreground">TOTAL REVENUE</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: '#22c55e' }}>UGX {fmt(totalRevenue)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
