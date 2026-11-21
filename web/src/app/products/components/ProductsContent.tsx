'use client';
import { api, ApiError } from '@/lib/api';
import type { ProductRow } from '@/types/api';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker } from '@/lib/checks';
import React, { useState, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';

interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  stockQty: number;
  reorderLevel: number;
  supplier: string;
  status: 'active' | 'inactive';
  description: string;
}

const CATEGORIES = ['Fuel', 'Lubricants', 'Engine Oil', 'Brake Fluid', 'Coolant', 'Additives', 'Carwash Products', 'Spare Parts', 'Other'];
const UNITS = ['Litres', 'Kg', 'Pieces', 'Bottles', 'Drums', 'Cartons', 'Packs'];
const SUPPLIERS = ['Total Energies', 'Vivo Energy (Shell)', 'Stabex International', 'Hashi Energy', 'Petro Uganda', 'Ola Energy', 'Local Supplier'];

/**
 * Fuel products, from GET /api/v1/products
 *
 * STOCK IS LITRES IN THE GROUND, summed across every tank holding the grade --
 * a product is not a tank, and one grade in two tanks is one product with two
 * places to run out.
 *
 * Cost price is not on a product. It is on the delivery that brought the fuel
 * in, because two loads a month apart did not cost the same; one number here
 * would be choosing which of them to lie about.
 */
function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    name: r.name,
    sku: r.code,
    category: 'Fuel',
    unit: 'litre',
    costPrice: 0,
    sellingPrice: r.pumpPrice ?? 0,
    stockQty: Math.round(r.stockLitres),
    // These were missing (hidden by a cast): every product showed Inactive,
    // the Active count was 0 and the Active filter emptied the list. (W3)
    status: r.isActive ? 'active' : 'inactive',
    // A fuel grade has no reorder level of its own: running low is a tank's
    // business (Tank Inventory). 0 = flagged only when there is none left.
    reorderLevel: 0,
    supplier: '',
    description: r.tankCount === 1 ? 'In 1 tank' : `In ${r.tankCount} tanks`,
  } satisfies Product;
}

const EMPTY_FORM = {
  name: '', sku: '', category: 'Fuel', unit: 'Litres', costPrice: 0, sellingPrice: 0,
  stockQty: 0, reorderLevel: 0, supplier: '', status: 'active' as Product['status'], description: '',
};

function fmt(n: number) { return n.toLocaleString('en-UG'); }
function fmtUGX(n: number) { return 'UGX ' + fmt(n); }

export default function ProductsContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const [partial, setPartial] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  useEffect(() => {
    let cancelled = false;
    void api
      .get<ProductRow[]>('/api/v1/products')
      .then((rows) => {
        if (!cancelled) {
          setProducts(rows.map(toProduct));
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

  const filtered = products.filter(p => {
    if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.sku.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openAdd = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setShowModal(true);
  };
  const openEdit = (p: Product) => {
    setEditId(p.id);
    const { id, ...rest } = p;
    setForm(rest);
    setShowModal(true);
  };
  /**
   * Add a fuel product. The PRICE is not set here: a pump price changes
   * through a price change, which cuts the open shift so litres sold before
   * and after are valued at the right figure.
   */
  /**
   * Schedule a price change.
   *
   * SCHEDULED, not applied. Taking effect CUTS THE SHIFT: the open one closes
   * at the old price and the next opens at the new one, so litres sold before
   * and after are each valued correctly. That break happens at shift closure,
   * where the meter readings and cash to close with already exist -- a button
   * here that changed the price under a running shift would misprice every
   * litre already in the tank meter.
   */
  const [priceFor, setPriceFor] = useState<Product | null>(null);
  const [newPrice, setNewPrice] = useState('');
  const [priceFrom, setPriceFrom] = useState('');
  const [priceSource, setPriceSource] = useState('DEALER');
  const [pendingPrices, setPendingPrices] = useState<number>(0);

  useEffect(() => {
    void api
      .get<unknown[]>('/api/ops/prices/pending')
      .then((rows) => setPendingPrices(rows.length))
      .catch(() => setPartial((x) => (x.includes('scheduled price changes') ? x : [...x, 'scheduled price changes'])));
  }, []);

  // A mistyped price sells every litre wrong until someone notices.
  const priceIssues = useMemo(() => {
    const c = new Checker();
    const v = c.number('price', newPrice, 'The new price per litre', { positive: true, optional: true });
    if (v !== null && priceFor) {
      const cur = priceFor.sellingPrice;
      if (cur > 0) {
        const ratio = v / cur;
        if (Math.abs(ratio - 10) < 0.5 || Math.abs(ratio - 0.1) < 0.005)
          c.warn('price', `UGX ${v.toLocaleString()} is about ${ratio > 1 ? 'TEN TIMES' : 'A TENTH OF'} the current UGX ${cur.toLocaleString()} - a zero added or missed?`);
        else if (Math.abs(ratio - 1) > 0.15)
          c.warn('price', `${ratio > 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}% on the current UGX ${cur.toLocaleString()} - check before it goes on the pumps`);
      }
      if (priceFor.costPrice > 0 && v < priceFor.costPrice)
        c.warn('price', `Below the cost of UGX ${priceFor.costPrice.toLocaleString()} - every litre would sell at a loss`);
    }
    if (priceFrom && new Date(priceFrom) < new Date())
      c.warn('from', 'That time has passed - it takes effect as soon as the shift is cut for it');
    return c.issues;
  }, [newPrice, priceFrom, priceFor]);

  const schedulePrice = async () => {
      clearProblem('p0');
    if (!priceFor) return;
    const price = Number(newPrice);
    if (!(price > 0)) {
      flagProblem('p0', 'Enter the new price per litre'); return;
    }
    try {
      await api.post<{ priceChangeId: string }>('/api/ops/prices', {
        productId: priceFor.id,
        newPrice: price,
        effectiveFrom: priceFrom ? new Date(priceFrom).toISOString() : new Date().toISOString(),
        source: priceSource,
        directiveRef: null,
        documentUrl: null,
      }, { idempotencyKey: `price-${priceFor.id}-${price}-${priceFrom}` });
      setPriceFor(null);
      setNewPrice('');
      setPendingPrices((n) => n + 1);
      showToast('Price change scheduled - it takes effect when the shift is closed', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (editId) {
      try {
        // Renaming is free. Changing the UNIT of a product a tank already
        // holds would reinterpret its whole history, and the database refuses
        // that with PRODUCT_UNIT_FROZEN -- the message below is its own.
        await api.put<unknown>(`/api/admin/products/${editId}`, {
          code: (form.sku || form.name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8),
          name: form.name.trim(),
          uom: /kg|kilo/i.test(form.unit) ? 'KG' : 'L',
          isWetStock: form.category === 'Fuel' || /litre|^l$/i.test(form.unit),
        });
        const rows = await api.get<ProductRow[]>('/api/v1/products');
        setProducts(rows.map(toProduct));
        setShowModal(false);
        showToast('Product updated', 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    try {
      await api.post<unknown>('/api/admin/products', {
        code: (form.sku || form.name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8),
        name: form.name.trim(),
        uom: /kg|kilo/i.test(form.unit) ? 'KG' : 'L',
        isWetStock: form.category === 'Fuel' || /litre|^l$/i.test(form.unit),
      }, { idempotencyKey: `product-${(form.sku || form.name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8)}` });
      const rows = await api.get<ProductRow[]>('/api/v1/products');
      setProducts(rows.map(toProduct));
      setShowModal(false);
      showToast('Product created — set its price through a price change', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDelete = (_id: string) => {
    showToast('Products are never deleted - every litre in the ledger refers to one. Rename it instead.', 'error');
  };

  const inputCls = 'w-full rounded-xl px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-[var(--primary)]';
  const inputStyle = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' };

  const lowStock = products.filter(p => p.stockQty <= p.reorderLevel).length;
  const totalValue = products.reduce((s, p) => s + p.stockQty * p.costPrice, 0);

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
          Could not load products
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }


  const priceModal = priceFor && (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-sm rounded-2xl border p-5 space-y-3" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <div>
          <h2 className="text-base font-semibold text-foreground">Schedule a price change</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            {priceFor.name} - it takes effect by cutting the shift, so litres sold
            before and after are valued at the right price.
          </p>
        </div>
        <input type="number" min={0} className="input-field w-full" placeholder="New price per litre"
               value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
        <input type="datetime-local" className="input-field w-full"
               value={priceFrom} onChange={(e) => setPriceFrom(e.target.value)} />
        <select className="input-field w-full" value={priceSource} onChange={(e) => setPriceSource(e.target.value)}>
          <option value="DEALER">Dealer decision</option>
          <option value="OMC">Oil company directive</option>
          <option value="REGULATOR">Regulator</option>
        </select>
        <div className="flex gap-2 pt-1">
          <button onClick={() => setPriceFor(null)} className="flex-1 py-2 rounded-xl text-sm"
                  style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Cancel</button>
          <FormProblem msg={problems.p0} />
          <IssueSummary issues={priceIssues} tried={false} />
          <button onClick={schedulePrice} className="flex-1 py-2 rounded-xl text-sm font-semibold"
                  style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}>Schedule</button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {priceModal}
      {pendingPrices > 0 && (
        <p className="text-xs px-4 pt-2" style={{ color: '#F59E0B' }}>
          {pendingPrices} price change(s) scheduled, waiting for a shift to close.
        </p>
      )}
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Products</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Manage all products, fuel grades, and stock items</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)' }}>
          <Icon name="PlusIcon" size={16} />Add Product
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Products', value: products.length, icon: 'ArchiveBoxIcon', color: '#3b82f6' },
          { label: 'Active', value: products.filter(p => p.status === 'active').length, icon: 'CheckCircleIcon', color: '#22c55e' },
          { label: 'Low Stock', value: lowStock, icon: 'ExclamationTriangleIcon', color: '#f59e0b' },
          { label: 'Stock Value', value: `UGX ${(totalValue / 1000000).toFixed(1)}M`, icon: 'BanknotesIcon', color: '#8b5cf6' },
        ].map(card => (
          <div key={card.label} className="rounded-2xl p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${card.color}18` }}>
                <Icon name={card.icon} size={18} style={{ color: card.color }} />
              </div>
              <div>
                <p className="text-xl font-bold text-foreground">{card.value}</p>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{card.label}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted-foreground)' }} />
          <input className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} placeholder="Search by name or SKU..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
          <option value="all">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Product', 'SKU', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Stock', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const isLow = p.stockQty <= p.reorderLevel;
                return (
                  <tr key={p.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-foreground">{p.name}</p>
                      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{p.supplier}</p>
                    </td>
                    <td className="px-4 py-3"><span className="font-mono text-xs px-2 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>{p.sku}</span></td>
                    <td className="px-4 py-3" style={{ color: 'var(--muted-foreground)' }}>{p.category}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--muted-foreground)' }}>{p.unit}</td>
                    <td className="px-4 py-3 text-foreground">{fmtUGX(p.costPrice)}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: 'var(--primary)' }}>{fmtUGX(p.sellingPrice)}</td>
                    <td className="px-4 py-3">
                      <span className="font-semibold" style={{ color: isLow ? '#ef4444' : 'var(--foreground)' }}>{fmt(p.stockQty)} {p.unit}</span>
                      {isLow && <span className="ml-1 text-xs" style={{ color: '#f59e0b' }}>⚠ Low</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2.5 py-1 rounded-full text-xs font-semibold" style={p.status === 'active' ? { background: 'rgba(34,197,94,0.15)', color: '#22c55e' } : { background: 'rgba(148,163,184,0.15)', color: '#94a3b8' }}>
                        {p.status === 'active' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setPriceFor(p); setNewPrice(String(p.sellingPrice || '')); }}
                          title="Schedule a price change"
                          className="px-2 py-1 mr-1 rounded-lg text-xs font-semibold"
                          style={{ background: 'rgba(245,158,11,0.14)', color: '#F59E0B' }}
                        >
                          Price
                        </button>
                        <button onClick={() => openEdit(p)} className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <Icon name="PencilIcon" size={14} className="text-foreground" />
                        </button>
                        <button onClick={() => handleDelete(p.id)} className="p-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
                          <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' }} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <Icon name="ArchiveBoxIcon" size={36} className="mx-auto mb-2" style={{ color: 'var(--muted-foreground)' }} />
              <p className="text-foreground font-semibold">No products found</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editId ? 'Edit Product' : 'Add Product'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Product Name *</label>
                  <input className={inputCls} style={inputStyle} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Product name" />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>SKU</label>
                  <input className={inputCls} style={inputStyle} value={form.sku} onChange={e => setForm(p => ({ ...p, sku: e.target.value }))} placeholder="e.g. FUEL-AGO" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Category</label>
                  <select className={inputCls} style={inputStyle} value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Unit</label>
                  <select className={inputCls} style={inputStyle} value={form.unit} onChange={e => setForm(p => ({ ...p, unit: e.target.value }))}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Cost Price (UGX)</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.costPrice} onChange={e => setForm(p => ({ ...p, costPrice: Number(e.target.value) }))} min={0} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Selling Price (UGX)</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.sellingPrice} onChange={e => setForm(p => ({ ...p, sellingPrice: Number(e.target.value) }))} min={0} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Stock Qty</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.stockQty} onChange={e => setForm(p => ({ ...p, stockQty: Number(e.target.value) }))} min={0} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Reorder Level</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.reorderLevel} onChange={e => setForm(p => ({ ...p, reorderLevel: Number(e.target.value) }))} min={0} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Supplier</label>
                <select className={inputCls} style={inputStyle} value={form.supplier} onChange={e => setForm(p => ({ ...p, supplier: e.target.value }))}>
                  <option value="">Select supplier...</option>
                  {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Description</label>
                <textarea className={inputCls} style={inputStyle} rows={2} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Product description..." />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Status</label>
                <select className={inputCls} style={inputStyle} value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value as 'active' | 'inactive' }))}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>Cancel</button>
              <button onClick={handleSave} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-black" style={{ background: 'var(--primary)' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
      <PartialLoadNotice missing={partial} />
    </>
  );
}
