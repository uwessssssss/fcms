'use client';
import { api, ApiError } from '@/lib/api';
import type { DryItemView } from '@/types/api';
import { useSites, useSiteOptions } from '@/lib/useSites';
import { isCompanyWide } from '@/lib/roles';
import { getWorkingSite } from '@/lib/workingSite';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

interface StockItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  openingStock: number;
  received: number;
  sold: number;
  closingStock: number;
  reorderLevel: number;
  supplier: string;
  site: string;
}

const CATEGORIES = ['Engine Oil', 'Gear Oil', 'Brake Fluid', 'Coolant', 'Grease', 'Filters', 'Additives', 'Other'];
const UNITS = ['Litres', 'Pieces', 'Cartons', 'Drums', 'Kg'];
const SUPPLIERS = ['Total Energies', 'Castrol', 'Shell Helix', 'Mobil', 'Caltex', 'Local Supplier'];

/**
 * Dry stock, from GET /api/dry-stock/items
 *
 * Two things the server knows that this screen's shape has no room for, and
 * they are worth keeping rather than flattening away:
 *
 *   COST PRICE is not on the item. It belongs to the movement that brought the
 *   stock in, because a case bought in March and one bought in September did
 *   not cost the same. Showing one number here would be choosing which of them
 *   to lie about, so it reads 0 and the margin comes from the statement.
 *
 *   A CYLINDER is tracked full or empty. An LPG exchange is not a sale of a
 *   cylinder, it is a swap -- and a system that counts it as stock out will be
 *   short a cylinder every time.
 */
function toStockItem(r: DryItemView): StockItem {
  return {
    id: r.itemId,
    // The state is appended once: names that already say it read "(empty) (empty)".
    name: r.isCylinder && r.cylinderState && !r.name.toLowerCase().includes(`(${r.cylinderState.toLowerCase()})`)
      ? `${r.name} (${r.cylinderState.toLowerCase()})` : r.name,
    category: r.category,
    unit: r.sellUnit,
    costPrice: 0,
    sellingPrice: r.unitPrice ?? 0,
    openingStock: 0,
    received: 0,
    sold: 0,
    closingStock: r.onHand,
    reorderLevel: r.reorderLevel,
    supplier: '',
    site: '',
  } satisfies StockItem;
}

const EMPTY_ITEM: Omit<StockItem, 'id'> = {
  name: '', category: 'Engine Oil', unit: 'Pieces', costPrice: 0, sellingPrice: 0,
  openingStock: 0, received: 0, sold: 0, closingStock: 0, reorderLevel: 10, supplier: '', site: '',
};

function fmt(n: number, dec = 0) { return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

export default function OtherStocksContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Was useState(INIT_STOCK): the initial value is read once, at mount, while
  // the load had not returned -- so the list stayed empty until an edit.
  const [stock, setStock] = useState<StockItem[]>([]);

  // Head office holds no stock: it sees the working site chosen in the top
  // bar (lib/workingSite). It read its own site: 0 of everything, no prices.
  const { user } = useAuth();
  const companyWide = isCompanyWide(user?.role);
  const siteOptions = useSiteOptions();
  const viewSite = getWorkingSite() ?? '';

  useEffect(() => {
    let cancelled = false;
    void api
      .get<DryItemView[]>('/api/dry-stock/items')
      .then((rows) => {
        if (!cancelled) {
          setStock(rows.map(toStockItem));
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

  const { isSiteManager, assignedSite } = useAuth();
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [siteFilter, setSiteFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<StockItem, 'id'>>({
    ...EMPTY_ITEM,
    site: (isSiteManager && assignedSite) ? assignedSite : EMPTY_ITEM.site,
  });
  const { showToast } = useToast();

  // Site managers only see their own site's stock
  const scopedStock = isSiteManager && assignedSite
    ? stock.filter(s => !s.site || s.site === assignedSite)
    : stock;

  const filtered = scopedStock.filter(s => {
    if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
    if (!isSiteManager && siteFilter !== 'all' && s.site && s.site !== siteFilter) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // At selling price: the API carries no cost for shop stock (cost lives on
  // each receipt). Valued at cost it read UGX 0 for everything. (W3)
  const totalValue = filtered.reduce((sum, s) => sum + s.closingStock * s.sellingPrice, 0);
  const lowStock = filtered.filter(s => s.closingStock <= s.reorderLevel).length;
  const totalSalesValue = filtered.reduce((sum, s) => sum + s.sold * s.sellingPrice, 0);

  const openAdd = () => {
    setEditId(null);
    setForm({ ...EMPTY_ITEM, site: (isSiteManager && assignedSite) ? assignedSite : EMPTY_ITEM.site });
    setShowModal(true);
  };
  const openEdit = (s: StockItem) => { setEditId(s.id); const { id, ...rest } = s; setForm(rest); setShowModal(true); };

  /**
   * Receive stock into an existing item.
   *
   * RECEIVING is a real action and goes to the server. SOLD is not typed here:
   * a sale is a receipt at the till, and the count follows the receipts. A
   * screen where you type how many were sold is a screen where the count
   * says whatever somebody wants it to. Creating a brand-new item has no
   * endpoint yet, and says so.
   */
  const handleSave = async () => {
      clearProblem('p0');
    if (!editId) {
      // A NEW ITEM. Created at zero stock; any opening quantity then arrives
      // as a RECEIVE, so every unit on the shelf has a movement behind it. An
      // item created with a typed-in quantity would be stock nobody can
      // account for at the next count.
      const CATS = ['LUBRICANT', 'SHOP', 'TYRE', 'ACCESSORY', 'SERVICE'];
      const UNITS = ['EACH', 'CARTON', 'LITRE', 'KG', 'PAIR', 'SET'];
      const wantCat = (form.category || '').toUpperCase();
      const category = CATS.find((c) => wantCat.includes(c) || c.startsWith(wantCat.slice(0, 4))) ?? 'SHOP';
      const wantUnit = (form.unit || '').toUpperCase();
      const sellUnit = UNITS.find((u) => wantUnit.includes(u) || u.startsWith(wantUnit.slice(0, 3))) ?? 'EACH';
      const sku = form.name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
      try {
        const created = await api.post<{ itemId: string }>('/api/dry-stock/items', {
          sku,
          name: form.name.trim(),
          category,
          sellUnit,
          reorderLevel: 0,
          unitPrice: form.sellingPrice > 0 ? form.sellingPrice : null,
        }, { idempotencyKey: `dry-item-${sku}` });

        if (form.openingStock > 0) {
          await api.post<unknown>('/api/dry-stock/receive', {
            itemId: created.itemId,
            qty: form.openingStock,
            unitCost: form.costPrice > 0 ? form.costPrice : null,
            note: 'Opening stock when the item was created',
          }, { submission: `dry-open:${created.itemId}` });
        }

        const rows = await api.get<DryItemView[]>('/api/dry-stock/items');
        setStock(rows.map(toStockItem));
        setShowModal(false);
        showToast(`${form.name.trim()} created as ${category.toLowerCase()}` +
          (form.openingStock > 0 ? `, ${form.openingStock} received` : ''), 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    if (form.sold > 0) {
      flagProblem('p0', 'Sales are not typed in — they come from shop receipts, so the count follows the till'); return;
    }
    if (!(form.received > 0)) {
      flagProblem('p0', 'Enter how many were received'); return;
    }
    try {
      await api.post<unknown>('/api/dry-stock/receive', {
        itemId: editId,
        qty: form.received,
        unitCost: form.costPrice > 0 ? form.costPrice : null,
        note: 'Received via stock screen',
      }, {
        // A retried receive must not receive the stock twice -- that inflates
        // the count, and the next stock-take reports a loss that never happened.
        submission: `dry-receive:${editId}`,
      });
      const rows = await api.get<DryItemView[]>('/api/dry-stock/items');
      setStock(rows.map(toStockItem));
      setShowModal(false);
      showToast(`${form.received} received into ${form.name}`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDelete = (_id: string) => {
    showToast('Stock items are never deleted - their movements refer to them.', 'error');
  };
  const updateForm = (field: keyof typeof form, value: string | number) => setForm(prev => ({ ...prev, [field]: value }));

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
          Could not load stock
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-lg rounded-2xl p-6 space-y-4 slide-up" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">{editId ? 'Edit Stock Item' : 'Add Stock Item'}</h3>
              <button onClick={() => setShowModal(false)} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close" title="Close">
                <Icon name="XMarkIcon" size={20} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-foreground mb-1">Product Name</label>
                <input className="input-field" value={form.name} onChange={e => updateForm('name', e.target.value)} placeholder="e.g. Castrol GTX 20W-50 (1L)" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Category</label>
                <select className="input-field" value={form.category} onChange={e => updateForm('category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Unit</label>
                <select className="input-field" value={form.unit} onChange={e => updateForm('unit', e.target.value)}>
                  {UNITS.map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
              {!isSiteManager && (
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Site</label>
                  <select className="input-field" value={form.site} onChange={e => updateForm('site', e.target.value)}>
                    {SITES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Supplier</label>
                <select className="input-field" value={form.supplier} onChange={e => updateForm('supplier', e.target.value)}>
                  <option value="">Select supplier</option>
                  {SUPPLIERS.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Cost Price (UGX)</label>
                <input className="input-field" type="number" value={form.costPrice} onChange={e => updateForm('costPrice', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Selling Price (UGX)</label>
                <input className="input-field" type="number" value={form.sellingPrice} onChange={e => updateForm('sellingPrice', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Opening Stock</label>
                <input className="input-field" type="number" value={form.openingStock} onChange={e => updateForm('openingStock', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Received</label>
                <input className="input-field" type="number" value={form.received} onChange={e => updateForm('received', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Sold</label>
                <input className="input-field" type="number" value={form.sold} onChange={e => updateForm('sold', Number(e.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Reorder Level</label>
                <input className="input-field" type="number" value={form.reorderLevel} onChange={e => updateForm('reorderLevel', Number(e.target.value))} />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={handleSave} className="btn-primary flex-1">{editId ? 'Update' : 'Add Item'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Other Stocks</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            {isSiteManager && assignedSite
              ? `Lubricants & non-fuel inventory — ${assignedSite}`
              : `Lubricants & non-fuel inventory — ${siteOptions.find((x) => x.id === viewSite)?.name ?? (companyWide ? 'the working site in the top bar' : 'this site')}`}
          </p>
        </div>
        <button onClick={openAdd} className="btn-primary">
          <Icon name="PlusIcon" size={16} />
          Add Stock Item
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Retail value', value: `UGX ${fmt(totalValue)}`, icon: 'ArchiveBoxIcon', color: 'var(--primary)' },
          { label: 'Sales Value', value: `UGX ${fmt(totalSalesValue)}`, icon: 'BanknotesIcon', color: '#60A5FA' },
          { label: 'Low Stock Items', value: String(lowStock), icon: 'ExclamationTriangleIcon', color: lowStock > 0 ? '#F59E0B' : 'var(--primary)' },
        ].map(kpi => (
          <div key={kpi.label} className="card p-4" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${kpi.color}20` }}>
                <Icon name={kpi.icon as Parameters<typeof Icon>[0]['name']} size={14} style={{ color: kpi.color }} />
              </div>
              <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{kpi.label}</span>
            </div>
            <p className="text-lg font-bold font-mono-nums text-foreground">{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          className="input-field max-w-xs"
          placeholder="Search products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="input-field w-auto" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
          <option value="all">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(160deg, #0F1C2E 0%, #0A1220 100%)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                {/* Opening, received and sold were always 0 and cost always 0:
                    the API gives what is on hand now, and the selling price. (W3) */}
                {['Product', 'Category', 'On hand', 'Reorder at', 'Sell price', 'Retail value', 'Actions']
                  .filter(Boolean).map(h => (
                  <th key={h!} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--muted-foreground)' }}>No stock items found</td></tr>
              )}
              {filtered.map((item, i) => {
                const isLow = item.closingStock <= item.reorderLevel;
                return (
                  <tr key={item.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-xs font-medium text-foreground">{item.name}</p>
                      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{item.supplier ? `${item.supplier} · ` : ''}{item.unit}</p>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>{item.category}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-mono-nums font-semibold" style={{ color: isLow ? '#ef4444' : 'var(--foreground)' }}>
                        {item.closingStock}
                        {isLow && <span className="ml-1 text-xs" style={{ color: '#ef4444' }}>⚠</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{item.reorderLevel}</td>
                    <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{item.sellingPrice ? fmt(item.sellingPrice) : '—'}</td>
                    <td className="px-4 py-3 text-xs font-mono-nums font-semibold text-foreground">{item.sellingPrice ? fmt(item.closingStock * item.sellingPrice) : '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(item)} className="p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors" title="Edit">
                          <Icon name="PencilIcon" size={13} className="text-primary" />
                        </button>
                        <button onClick={() => handleDelete(item.id)} className="p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors" title="Delete">
                          <Icon name="TrashIcon" size={13} style={{ color: '#ef4444' }} />
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
    </div>
  );
}
