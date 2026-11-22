'use client';
import { useCan } from '@/lib/useCan';
import { useStatement, field, num } from '@/lib/useStatement';
import type { ShiftSummary, TankInventoryRow } from '@/types/api';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { useSites } from '@/lib/useSites';
import { businessToday } from '@/lib/dates';
import { FormProblem, IssueSummary } from '@/components/ui/Issues';
import { Checker } from '@/lib/checks';
import React, { useState, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/context/AuthContext';

interface Delivery {
  id: string;
  site: string;
  supplier: string;
  grade: string;
  gradeColor: string;
  costPricePerLitre: number;
  driverName: string;
  vehicleReg: string;
  deliveryDate: string;
  dipsBefore: number;
  dipsAfter: number;
  quantityAt20: number;
  invoiceQty: number;
  gainLoss: number;
  notes?: string;
  /** As printed on the note. What the supplier's invoice is matched against. */
  deliveryNoteNo?: string;
  /** Ticked only by someone who checked every seal. Unticked is flagged. */
  sealsIntact?: boolean;
  sealNumbers?: string;
}

const SUPPLIERS = ['Total Energies', 'Vivo Energy (Shell)', 'Stabex International', 'Hashi Energy', 'Petro Uganda', 'Ola Energy'];
const GRADES = [
  { label: 'AGO (Diesel)', color: '#f59e0b' },
  { label: 'PMS (Petrol)', color: '#22c55e' },
  { label: 'Super PMS', color: '#8b5cf6' },
  { label: 'Kerosene', color: '#3b82f6' },
];

// Served by the statements registry: GET /api/statements/deliveries
//
// This screen's content is a statement the server already produces --
// same query, same columns, same totals, already validated against the
// schema. Wiring it here rather than adding a fifth endpoint that would
// drift from the statement showing the same figures.
const GRADE_COLOUR: Record<string, string> = {
  PMS: '#00D4A0', AGO: '#F59E0B', IK: '#60A5FA', LPG: '#A78BFA',
};

/**
 * Deliveries, from GET /api/statements/deliveries
 *
 * What the note said against what the dips found. A shortfall on delivery is
 * the cheapest loss to prove and the easiest to miss.
 */
function toDelivery(r: Record<string, unknown>): Delivery {
  const grade = field(r, 'tank').split('-').pop() ?? '';
  return {
    id: field(r, 'note') + field(r, 'date'),
    site: field(r, 'site'),
    supplier: field(r, 'supplier'),
    grade,
    gradeColor: GRADE_COLOUR[grade] ?? '#64748B',
    // The cost the load was received at, and the two dips that prove it --
    // all on record; they were shown as 0.
    costPricePerLitre: num(r, 'cost_per_litre'),
    driverName: field(r, 'driver'),
    vehicleReg: field(r, 'truck'),
    deliveryDate: field(r, 'date').slice(0, 10),
    dipsBefore: num(r, 'dip_before'),
    dipsAfter: num(r, 'dip_after'),
    quantityAt20: num(r, 'received'),
    invoiceQty: num(r, 'on_note'),
    // Negative means the truck brought less than the note claimed, which is
    // the whole reason this screen exists.
    gainLoss: num(r, 'variance'),
    notes: field(r, 'status'),
  } satisfies Delivery;
}

const EMPTY_DELIVERY: Omit<Delivery, 'id'> = {
  site: '', supplier: '', grade: 'AGO (Diesel)', gradeColor: '#f59e0b',
  costPricePerLitre: 0, driverName: '', vehicleReg: '', deliveryDate: businessToday(),
  dipsBefore: 0, dipsAfter: 0, quantityAt20: 0, invoiceQty: 0, gainLoss: 0, notes: '',
  // Seals start UNTICKED. Defaulting to intact would assert an inspection
  // nobody made; unticked, the delivery is recorded for a manager to review.
  deliveryNoteNo: '', sealsIntact: false, sealNumbers: '',
};

function fmt(n: number, dec = 0) { return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

export default function DeliveriesContent() {
  const can = useCan();
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const { showToast } = useToast();
  const { rows: liveRows, loading, error: loadError, reload: reloadDeliveries } =
    useStatement<Delivery>('deliveries', toDelivery);

  const { isSiteManager, assignedSite } = useAuth();
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  // Seeded from the server. Without this the hook fetched, the rows sat in
  // `liveRows`, and the table rendered this array -- which nothing ever filled.
  // The screen was blank while reporting no error at all.
  useEffect(() => setDeliveries(liveRows), [liveRows]);
  const [siteFilter, setSiteFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Delivery, 'id'>>({
    ...EMPTY_DELIVERY,
    site: (isSiteManager && assignedSite) ? assignedSite : EMPTY_DELIVERY.site,
  });

  // Site managers only see their own site's deliveries
  const scopedDeliveries = isSiteManager && assignedSite
    ? deliveries.filter((d) => !d.site || d.site === assignedSite)   // the API scopes a station's rows; some carry no site (W1)
    : deliveries;

  const filtered = scopedDeliveries.filter(d => {
    if (!isSiteManager && siteFilter !== 'all' && d.site !== siteFilter) return false;
    if (gradeFilter !== 'all' && d.grade !== gradeFilter) return false;
    if (dateFrom && d.deliveryDate < dateFrom) return false;
    if (dateTo && d.deliveryDate > dateTo) return false;
    return true;
  });

  // What does not add up on the delivery being received -- shown as it is typed.
  const deliveryIssues = useMemo(() => {
    const c = new Checker();
    const received = form.dipsAfter - form.dipsBefore;
    if (form.dipsAfter > 0 && !(received > 0)) c.error('dips', `The after dip (${form.dipsAfter.toLocaleString()} L) must be higher than the before dip (${form.dipsBefore.toLocaleString()} L)`);
    if (!(form.invoiceQty > 0)) c.error('invoice', 'The litres on the delivery note are needed');
    if (received > 0 && form.invoiceQty > 0) {
      const gap = received - form.invoiceQty;
      if (Math.abs(gap) > Math.max(20, form.invoiceQty * 0.005))
        c.warn('dips', `${Math.abs(Math.round(gap)).toLocaleString()} L ${gap < 0 ? 'SHORT' : 'over'} against the note (${form.invoiceQty.toLocaleString()} L) - ${gap < 0 ? 'the supplier owes this, or the dips are wrong' : 're-dip before accepting a gain'}`);
    }
    if (form.sealsIntact === false) c.warn('seals', 'Seals not intact - record the seal numbers and keep photos before discharging');
    if (!(form.costPricePerLitre > 0)) c.warn('cost', 'No cost per litre - the stock will be costed at zero until it is entered');
    return c.issues;
  }, [form]);

  const totalVolume = filtered.reduce((s, d) => s + d.quantityAt20, 0);
  const totalGainLoss = filtered.reduce((s, d) => s + d.gainLoss, 0);
  const totalCost = filtered.reduce((s, d) => s + d.quantityAt20 * d.costPricePerLitre, 0);

  const openAdd = () => {
    setEditId(null);
    setForm({
      ...EMPTY_DELIVERY,
      site: (isSiteManager && assignedSite) ? assignedSite : EMPTY_DELIVERY.site,
    });
    setShowModal(true);
  };

  const openEdit = (d: Delivery) => {
    setEditId(d.id);
    const { id, ...rest } = d;
    setForm(rest);
    setShowModal(true);
  };

  /**
   * Book a delivery in and receive it: two server calls, because they are two
   * events -- the note arriving, and the fuel going into the tank with a dip
   * either side.
   *
   * The dips are LITRES, and the received figure is after minus before. That
   * is what a shortfall claim against a transporter rests on, which is why the
   * server stopped converting millimetres through a straight-line chart.
   *
   * SEALS are whatever the receiver ticked. The box starts unticked, so a
   * delivery nobody inspected is recorded as seals-not-confirmed and flagged,
   * rather than asserting an inspection that never happened.
   */
  const handleSave = async () => {
      clearProblem('p0');
    if (editId) {
      flagProblem('p0', 'A received delivery is in the ledger and is not edited'); return;
    }
    if (!form.deliveryNoteNo?.trim()) {
      showToast('Enter the delivery note number as printed — the supplier\'s invoice is matched against it', 'error');
      return;
    }
    if (!(form.dipsBefore > 0) || !(form.dipsAfter > 0) || form.dipsAfter <= form.dipsBefore) {
      flagProblem('p0', 'Dip the tank before and after, in litres — the after dip must be higher'); return;
    }
    try {
      const current = await api.get<ShiftSummary | undefined>('/api/shifts/current');
      if (!current) {
        showToast('A delivery is received during an open shift — its dips are part of that shift\'s reconciliation', 'error');
        return;
      }
      const tanks = await api.get<TankInventoryRow[]>('/api/v1/inventory/tanks');
      const code = (form.grade.match(/\b(PMS|AGO|IK|LPG)\b/i)?.[1] ?? form.grade).toUpperCase();
      const tank = tanks.find((t) => t.gradeCode === code);
      if (!tank) { flagProblem('p0', `No ${code} tank at this site`); return; }

      const created = await api.post<{ deliveryId: string }>('/api/deliveries', {
        supplierId: null,
        // The number printed on the note, required above.
        deliveryNoteNo: form.deliveryNoteNo.trim(),
        invoiceNo: null, depot: null, transporter: form.supplier || null,
        truckReg: form.vehicleReg || null, driverName: form.driverName || null,
        sealNumbers: (form.sealNumbers ?? '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
        lines: [{ tankId: tank.id, loadedLitres: form.invoiceQty, unitCost: form.costPricePerLitre > 0 ? form.costPricePerLitre : null }],
      }, { idempotencyKey: `delivery-${form.deliveryNoteNo?.trim()}` });

      await api.post<unknown>(`/api/deliveries/${created.deliveryId}/receive?shiftId=${current.id}`, {
        // What the person receiving the truck asserted -- never assumed.
        sealsIntact: form.sealsIntact === true,
        sealPhotoUrl: null,
        lines: [{ tankId: tank.id, litresBefore: form.dipsBefore, litresAfter: form.dipsAfter, rejectedLitres: 0, rejectionReason: null }],
      });

      reloadDeliveries();
      setShowModal(false);
      const received = form.dipsAfter - form.dipsBefore;
      const diff = received - form.invoiceQty;
      showToast(
        `Received ${received.toLocaleString()} L against ${form.invoiceQty.toLocaleString()} L on the note` +
          (Math.abs(diff) >= 1 ? ` — ${diff > 0 ? 'over' : 'SHORT'} by ${Math.abs(diff).toLocaleString()} L` : ''),
        Math.abs(diff) >= 1 && diff < 0 ? 'error' : 'success',
      );
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handleDelete = (id: string) => setDeliveries(prev => prev.filter(d => d.id !== id));

  const updateForm = (field: keyof typeof form, value: string | number) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-6">
      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="rounded-2xl border w-full max-w-2xl max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-6 py-4 border-b flex items-center justify-between sticky top-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}>
              <h3 className="text-base font-bold text-foreground">{editId ? 'Edit Delivery' : 'Record New Delivery'}</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-muted" aria-label="Close" title="Close">
                <Icon name="XMarkIcon" size={16} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
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
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Delivery Date</label>
                  <input type="date" value={form.deliveryDate} onChange={e => updateForm('deliveryDate', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Supplier</label>
                  <select value={form.supplier} onChange={e => updateForm('supplier', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg">
                    <option value="">— Select Supplier —</option>
                    {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Fuel Grade</label>
                  <select value={form.grade} onChange={e => updateForm('grade', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg">
                    {GRADES.map(g => <option key={g.label} value={g.label}>{g.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Cost Price (UGX/Litre)</label>
                  <input type="number" value={form.costPricePerLitre || ''} onChange={e => updateForm('costPricePerLitre', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" placeholder="e.g. 4200" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Driver Name</label>
                  <input type="text" value={form.driverName} onChange={e => updateForm('driverName', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" placeholder="e.g. J. Kamau" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Vehicle Reg.</label>
                  <input type="text" value={form.vehicleReg} onChange={e => updateForm('vehicleReg', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" placeholder="e.g. UAX 123K" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Delivery Note No.</label>
                  <input type="text" value={form.deliveryNoteNo ?? ''} placeholder="As printed on the note"
                         onChange={e => setForm(f => ({ ...f, deliveryNoteNo: e.target.value }))}
                         className="input-field py-2 px-3 text-sm w-full rounded-lg" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Seal Numbers</label>
                  <input type="text" value={form.sealNumbers ?? ''} placeholder="e.g. 004512, 004513"
                         onChange={e => setForm(f => ({ ...f, sealNumbers: e.target.value }))}
                         className="input-field py-2 px-3 text-sm w-full rounded-lg" />
                </div>
                <div className="col-span-full">
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={form.sealsIntact === true}
                           onChange={e => setForm(f => ({ ...f, sealsIntact: e.target.checked }))} />
                    <span>
                      I checked every seal on the truck and they were intact. Leave this unticked if
                      any seal was broken, missing, or not checked — the delivery is then flagged for a manager.
                    </span>
                  </label>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Invoice Qty (Litres)</label>
                  <input type="number" value={form.invoiceQty || ''} onChange={e => updateForm('invoiceQty', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" placeholder="Litres on invoice" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Dips Before (Litres)</label>
                  <input type="number" value={form.dipsBefore || ''} onChange={e => updateForm('dipsBefore', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" placeholder="Tank level before" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Dips After (Litres)</label>
                  <input type="number" value={form.dipsAfter || ''} onChange={e => updateForm('dipsAfter', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" placeholder="Tank level after" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Quantity @ 20°C Received</label>
                  <input type="number" value={form.quantityAt20 || ''} onChange={e => updateForm('quantityAt20', Number(e.target.value))} className="input-field py-2 px-3 text-sm w-full rounded-lg font-mono-nums" placeholder="Temperature-corrected qty" min="0" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--muted-foreground)' }}>Notes</label>
                  <input type="text" value={form.notes || ''} onChange={e => updateForm('notes', e.target.value)} className="input-field py-2 px-3 text-sm w-full rounded-lg" placeholder="Optional notes" />
                </div>
              </div>
              {/* Computed gain/loss preview */}
              {form.quantityAt20 > 0 && form.invoiceQty > 0 && (
                <div className="p-3 rounded-lg" style={{ backgroundColor: (form.quantityAt20 - form.invoiceQty) >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${(form.quantityAt20 - form.invoiceQty) >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}` }}>
                  <p className="text-xs font-semibold" style={{ color: (form.quantityAt20 - form.invoiceQty) >= 0 ? '#22c55e' : '#ef4444' }}>
                    Gain/Loss: {form.quantityAt20 - form.invoiceQty >= 0 ? '+' : ''}{fmt(form.quantityAt20 - form.invoiceQty, 0)} L
                    {' '}(Invoice: {fmt(form.invoiceQty)} L | Received @ 20°C: {fmt(form.quantityAt20)} L)
                  </p>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t flex gap-3 justify-end" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-xl text-sm font-medium border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
              <IssueSummary issues={deliveryIssues} tried={!!problems.p0} />
              <FormProblem msg={problems.p0} />
              <button onClick={handleSave} className="px-4 py-2 rounded-xl text-sm font-bold" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                {editId ? 'Save Changes' : 'Record Delivery'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Fuel Deliveries</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Record and track all fuel deliveries with dips, cost price and gain/loss</p>
        </div>
        {can('delivery.receive') && (
          <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
            <Icon name="PlusIcon" size={16} />Record Delivery
          </button>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Deliveries', value: String(filtered.length), icon: 'TruckIcon', color: 'var(--primary)' },
          { label: 'Volume Received', value: `${fmt(totalVolume / 1000, 1)}k L`, icon: 'BeakerIcon', color: '#3b82f6' },
          { label: 'Total Cost', value: `UGX ${fmt(totalCost / 1000000, 1)}M`, icon: 'BanknotesIcon', color: '#f59e0b' },
          { label: 'Net Gain/Loss', value: `${totalGainLoss >= 0 ? '+' : ''}${fmt(totalGainLoss)} L`, icon: totalGainLoss >= 0 ? 'ArrowTrendingUpIcon' : 'ArrowTrendingDownIcon', color: totalGainLoss >= 0 ? '#22c55e' : '#ef4444' },
        ].map(card => (
          <div key={card.label} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${card.color}20` }}>
                <Icon name={card.icon as Parameters<typeof Icon>[0]['name']} size={16} style={{ color: card.color } as React.CSSProperties} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{card.label}</span>
            </div>
            <p className="text-2xl font-bold font-mono-nums text-foreground">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="rounded-xl border p-4 flex flex-wrap items-center gap-3" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <Icon name="FunnelIcon" size={15} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
        {/* Site filter — head office only */}
        {!isSiteManager && (
          <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg">
            <option value="all">All Sites</option>
            {SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {isSiteManager && assignedSite && (
          <span className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
            📍 {assignedSite}
          </span>
        )}
        <select value={gradeFilter} onChange={e => setGradeFilter(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg">
          <option value="all">All Grades</option>
          {GRADES.map(g => <option key={g.label} value={g.label}>{g.label}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>From</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>To</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg" />
        </div>
        {(siteFilter !== 'all' || gradeFilter !== 'all' || dateFrom || dateTo) && (
          <button onClick={() => { setSiteFilter('all'); setGradeFilter('all'); setDateFrom(''); setDateTo(''); }} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs" style={{ color: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)' }}>
            <Icon name="XMarkIcon" size={12} />Clear
          </button>
        )}
      </div>

      {/* Deliveries table */}
      <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                {['Date', 'Site', 'Supplier', 'Grade', 'Driver / Vehicle', 'Cost/L', 'Dips Before', 'Dips After', 'Qty @ 20°C', 'Invoice Qty', 'Gain/Loss', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, idx) => (
                <tr key={d.id} style={{ borderBottom: idx < filtered.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/40 transition-colors">
                  <td className="px-4 py-3 text-xs font-medium text-foreground whitespace-nowrap">{d.deliveryDate}</td>
                  <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{d.site}</td>
                  <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">{d.supplier}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.gradeColor }} />
                      {d.grade}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-foreground">{d.driverName}</p>
                    <p className="text-xs font-mono-nums" style={{ color: 'var(--muted-foreground)' }}>{d.vehicleReg}</p>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{fmt(d.costPricePerLitre)}</td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{fmt(d.dipsBefore)} L</td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{fmt(d.dipsAfter)} L</td>
                  <td className="px-4 py-3 text-xs font-mono-nums font-semibold" style={{ color: 'var(--primary)' }}>{fmt(d.quantityAt20)} L</td>
                  <td className="px-4 py-3 text-xs font-mono-nums text-foreground">{fmt(d.invoiceQty)} L</td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: d.gainLoss >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: d.gainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                      {d.gainLoss >= 0 ? '+' : ''}{fmt(d.gainLoss)} L
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {can('delivery.receive') && (<button onClick={() => openEdit(d)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" aria-label="Edit" title="Edit">
                        <Icon name="PencilSquareIcon" size={13} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                      </button>)}
                      {can('delivery.receive') && (<button onClick={() => handleDelete(d.id)} className="p-1.5 rounded-lg hover:bg-muted transition-colors" aria-label="Delete" title="Delete">
                        <Icon name="TrashIcon" size={13} style={{ color: '#ef4444' } as React.CSSProperties} />
                      </button>)}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>No deliveries found matching filters</td></tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                  <td colSpan={8} className="px-4 py-3 text-xs font-bold text-foreground">TOTALS</td>
                  <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: 'var(--primary)' }}>{fmt(totalVolume)} L</td>
                  <td />
                  <td className="px-4 py-3">
                    <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: totalGainLoss >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: totalGainLoss >= 0 ? '#22c55e' : '#ef4444' }}>
                      {totalGainLoss >= 0 ? '+' : ''}{fmt(totalGainLoss)} L
                    </span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
