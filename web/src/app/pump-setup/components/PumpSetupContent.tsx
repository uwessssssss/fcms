'use client';
import { ApiError, api } from '@/lib/api';
import type { EquipmentRow, ProductRow, TankInventoryRow, UpsertNozzle, UpsertPump, UpsertTank } from '@/types/api';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { FormProblem } from '@/components/ui/Issues';
import React, { useMemo, useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';

interface Nozzle {
  id: string;
  nozzleNo: number;
  grade: string;
  gradeColor: string;
  tankId: string;
}

interface Pump {
  id: string;
  pumpNo: number;
  label: string;
  nozzles: Nozzle[];
}

interface Tank {
  id: string;
  label: string;
  grade: string;
  gradeColor: string;
  capacity: number;
}

const GRADE_OPTIONS = [
  { label: 'AGO (Diesel)', color: '#f59e0b' },
  { label: 'PMS (Petrol)', color: '#22c55e' },
  { label: 'Super PMS', color: '#8b5cf6' },
  { label: 'Kerosene', color: '#3b82f6' },
];

/** Tanks, from the same endpoint the tank screen uses -- so they agree. */
function toSetupTank(r: TankInventoryRow): Tank {
  const colours: Record<string, string> = { PMS: '#00D4A0', AGO: '#F59E0B', IK: '#60A5FA', LPG: '#A78BFA' };
  return {
    id: r.id,
    label: r.code,
    grade: r.gradeCode,
    gradeColor: colours[r.gradeCode] ?? '#64748B',
    capacity: r.capacityLitres,
  } satisfies Tank;
}

const GRADE_COLOUR: Record<string, string> = {
  PMS: '#00D4A0',
  AGO: '#F59E0B',
  IK: '#60A5FA',
  LPG: '#A78BFA',
};

/**
 * Pumps with their nozzles, from GET /api/admin/equipment
 *
 * The server returns a FLAT list -- tanks, pumps and nozzles as peers, each
 * naming its parent. Nesting happens here because the shape a screen wants and
 * the shape a table has are different questions, and flattening in SQL then
 * re-nesting in three different screens is how they drift apart.
 *
 * A NOZZLE NAMES ITS PUMP AND ITS TANK SEPARATELY, and that is not redundant:
 * one tank can feed nozzles on several pumps, and a pump can carry nozzles
 * drawing from different tanks. Systems that assume a pump has one grade
 * cannot reconcile a real forecourt.
 */
function toPumps(rows: EquipmentRow[]): Pump[] {
  const nozzles = rows.filter((r) => r.kind === 'NOZZLE');

  return rows
    .filter((r) => r.kind === 'PUMP')
    .map((p, i) => ({
      id: p.id,
      pumpNo: Number(p.code.replace(/\D/g, '')) || i + 1,
      label: p.detail ? `${p.code} — ${p.detail}` : p.code,
      nozzles: nozzles
        .filter((n) => n.parentCode === p.code)
        .map((n, j) => {
          const grade = (n.detail ?? '').split(/[\s·]/)[0] ?? '';
          return {
            id: n.id,
            nozzleNo: Number(n.code.replace(/\D/g, '')) || j + 1,
            grade,
            gradeColor: GRADE_COLOUR[grade] ?? '#64748B',
            tankId: n.tankId ?? '',
          };
        }),
    }));
}

function fmt(n: number) { return n.toLocaleString('en-UG'); }

export default function PumpSetupContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const [partial, setPartial] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Add equipment, and switch it off.
   *
   * There was nowhere in the application to add a tank, a pump or a nozzle:
   * the forecourt could only be built by hand in SQL. DEACTIVATING is the
   * other half -- equipment is never deleted, because a nozzle with meter
   * readings against it must keep existing or those readings lose their
   * subject. Switching it off takes it out of tomorrow's roster and leaves
   * yesterday's evidence intact.
   */


  const setActive = async (kind: string, id: string, active: boolean) => {
    try {
      await api.post<unknown>(`/api/admin/equipment/${kind.toLowerCase()}/${id}/active?active=${active}`, {});
      const rows = await api.get<EquipmentRow[]>('/api/admin/equipment');
      setPumps(toPumps(rows));
      showToast(active ? 'Back in service' : 'Switched off - its history stays', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    void api
      .get<EquipmentRow[]>('/api/admin/equipment')
      .then((rows) => {
        if (!cancelled) {
          setPumps(toPumps(rows));
          setSiteTankIds(new Set(rows.filter((r) => r.kind === 'TANK').map((r) => r.id)));
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

  const [pumps, setPumps] = useState<Pump[]>([]);
  const [allTanks, setTanks] = useState<Tank[]>([]);
  // This site's tanks only: the tank list is the company's, the pumps one site's.
  const [siteTankIds, setSiteTankIds] = useState<Set<string>>(new Set());
  const tanks = useMemo(() => (siteTankIds.size ? allTanks.filter((t) => siteTankIds.has(t.id)) : allTanks), [allTanks, siteTankIds]);
  const [activeTab, setActiveTab] = useState<'pumps' | 'tanks'>('pumps');
  const { showToast } = useToast();

  // Pump modal state
  const [showPumpModal, setShowPumpModal] = useState(false);
  const [editPumpId, setEditPumpId] = useState<string | null>(null);
  const [pumpForm, setPumpForm] = useState({ label: '', pumpNo: 1 });

  // Nozzle modal state
  const [showNozzleModal, setShowNozzleModal] = useState(false);
  const [editNozzleId, setEditNozzleId] = useState<string | null>(null);
  const [nozzleTargetPumpId, setNozzleTargetPumpId] = useState<string>('');
  const [nozzleForm, setNozzleForm] = useState({ nozzleNo: 1, grade: 'AGO (Diesel)', gradeColor: '#f59e0b', tankId: '' });

  // Tank modal state
  const [showTankModal, setShowTankModal] = useState(false);
  const [editTankId, setEditTankId] = useState<string | null>(null);
  const [tankForm, setTankForm] = useState({ label: '', grade: 'AGO (Diesel)', gradeColor: '#f59e0b', capacity: 20000 });

  useEffect(() => {
    let cancelled = false;
    void api
      .get<TankInventoryRow[]>('/api/v1/inventory/tanks')
      .then((rows) => {
        if (!cancelled) setTanks(rows.map(toSetupTank));
      })
      .catch(() => setPartial((x) => (x.includes('the tanks') ? x : [...x, 'the tanks'])));
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Pump CRUD ──
  const openAddPump = () => {
    setEditPumpId(null);
    setPumpForm({ label: `Pump ${pumps.length + 1}`, pumpNo: pumps.length + 1 });
    setShowPumpModal(true);
  };
  const openEditPump = (p: Pump) => {
    setEditPumpId(p.id);
    setPumpForm({ label: p.label, pumpNo: p.pumpNo });
    setShowPumpModal(true);
  };
  // ADD is real; EDIT is refused. These are the handlers the visible modals
  // call -- an earlier addEquipment() I wrote was never given a button, so
  // "Pump added" here only ever changed the screen.
  const savePump = async () => {
    if (!pumpForm.label.trim()) return;
    if (editPumpId) {
      // EDIT: load the whole record, change what this form shows, send the
      // rest back untouched. If the change touches wiring that is frozen on
      // used equipment, the database refuses and says why (migration 340).
      try {
        const cur = await api.get<UpsertPump>(`/api/admin/pumps/${editPumpId}`);
        await api.put<unknown>(`/api/admin/pumps/${editPumpId}`, { ...cur, code: pumpForm.label.trim().toUpperCase() });
        const [eqRows, tankRows] = await Promise.all([
          api.get<EquipmentRow[]>('/api/admin/equipment'),
          api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
        ]);
        setPumps(toPumps(eqRows));
        setTanks(tankRows.map(toSetupTank));
        setShowPumpModal(false);
        showToast('Pump updated', 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    try {
      await api.post<unknown>('/api/admin/pumps', {
        code: pumpForm.label.trim().toUpperCase(), make: null, serialNo: null,
      }, { idempotencyKey: `pump-${pumpForm.label.trim().toUpperCase()}` });
      const [eqRows, tankRows] = await Promise.all([
        api.get<EquipmentRow[]>('/api/admin/equipment'),
        api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
      ]);
      setPumps(toPumps(eqRows));
      setTanks(tankRows.map(toSetupTank));
      setShowPumpModal(false);
      showToast('Pump added', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  const deletePump = (id: string) => void setActive('PUMP', id, false);

  // ── Nozzle CRUD ──
  const openAddNozzle = (pumpId: string) => {
    const pump = pumps.find(p => p.id === pumpId);
    setNozzleTargetPumpId(pumpId);
    setEditNozzleId(null);
    setNozzleForm({ nozzleNo: (pump?.nozzles.length ?? 0) + 1, grade: 'AGO (Diesel)', gradeColor: '#f59e0b', tankId: tanks[0]?.id ?? '' });
    setShowNozzleModal(true);
  };
  const openEditNozzle = (pumpId: string, nozzle: Nozzle) => {
    setNozzleTargetPumpId(pumpId);
    setEditNozzleId(nozzle.id);
    setNozzleForm({ nozzleNo: nozzle.nozzleNo, grade: nozzle.grade, gradeColor: nozzle.gradeColor, tankId: nozzle.tankId });
    setShowNozzleModal(true);
  };
  const saveNozzle = async () => {
      clearProblem('p0');
    if (editNozzleId) {
      // EDIT: load the whole record, change what this form shows, send the
      // rest back untouched. If the change touches wiring that is frozen on
      // used equipment, the database refuses and says why (migration 340).
      try {
        const cur = await api.get<UpsertNozzle>(`/api/admin/nozzles/${editNozzleId}`);
        await api.put<unknown>(`/api/admin/nozzles/${editNozzleId}`, {
          ...cur,
          tankId: nozzleForm.tankId && nozzleForm.tankId !== 't1' ? nozzleForm.tankId : cur.tankId,
        });
        const [eqRows, tankRows] = await Promise.all([
          api.get<EquipmentRow[]>('/api/admin/equipment'),
          api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
        ]);
        setPumps(toPumps(eqRows));
        setTanks(tankRows.map(toSetupTank));
        setShowNozzleModal(false);
        showToast('Nozzle updated', 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    // A nozzle must draw from a REAL tank. The form used to default to 't1',
    // an id that exists nowhere.
    if (!nozzleForm.tankId || nozzleForm.tankId === 't1') {
      flagProblem('p0', 'Choose the tank this nozzle draws from'); return;
    }
    const pump = pumps.find((p) => p.id === nozzleTargetPumpId);
    try {
      await api.post<unknown>('/api/admin/nozzles', {
        code: `${pump?.label ?? 'P'}-N${nozzleForm.nozzleNo}`.toUpperCase(),
        pumpId: nozzleTargetPumpId,
        tankId: nozzleForm.tankId,
        // Six digits before the totalizer rolls over, the common head. Wrong,
        // and a genuine rollover reads as a meter running backwards.
        integerDigits: 6,
        maxFlowLpm: 50,
      }, { idempotencyKey: `nozzle-${nozzleTargetPumpId}-${nozzleForm.nozzleNo}` });
      const [eqRows, tankRows] = await Promise.all([
        api.get<EquipmentRow[]>('/api/admin/equipment'),
        api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
      ]);
      setPumps(toPumps(eqRows));
      setTanks(tankRows.map(toSetupTank));
      setShowNozzleModal(false);
      showToast('Nozzle added', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  const deleteNozzle = (_pumpId: string, nozzleId: string) => void setActive('NOZZLE', nozzleId, false);

  // ── Tank CRUD ──
  const openAddTank = () => {
    setEditTankId(null);
    setTankForm({ label: `Tank ${tanks.length + 1}`, grade: 'AGO (Diesel)', gradeColor: '#f59e0b', capacity: 20000 });
    setShowTankModal(true);
  };
  const openEditTank = (t: Tank) => {
    setEditTankId(t.id);
    setTankForm({ label: t.label, grade: t.grade, gradeColor: t.gradeColor, capacity: t.capacity });
    setShowTankModal(true);
  };
  const saveTank = async () => {
      clearProblem('p1');
    if (!tankForm.label.trim()) return;
    if (editTankId) {
      // EDIT: load the whole record, change what this form shows, send the
      // rest back untouched. If the change touches wiring that is frozen on
      // used equipment, the database refuses and says why (migration 340).
      try {
        const cur = await api.get<UpsertTank>(`/api/admin/tanks/${editTankId}`);
        const products = await api.get<ProductRow[]>('/api/v1/products');
        const want = tankForm.grade.toUpperCase();
        const product = products.find((x) => want.includes(x.code.toUpperCase()));
        await api.put<unknown>(`/api/admin/tanks/${editTankId}`, {
          ...cur,
          code: tankForm.label.trim().toUpperCase(),
          productId: product?.id ?? cur.productId,
          nominalLitres: tankForm.capacity,
          // Safe fill cannot exceed the tank; keep it unless the tank shrank.
          safeFill: cur.safeFill > tankForm.capacity ? Math.round(tankForm.capacity * 0.95) : cur.safeFill,
        });
        const [eqRows, tankRows] = await Promise.all([
          api.get<EquipmentRow[]>('/api/admin/equipment'),
          api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
        ]);
        setPumps(toPumps(eqRows));
        setTanks(tankRows.map(toSetupTank));
        setShowTankModal(false);
        showToast('Tank updated', 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    try {
      // The grade picked here, matched to a real product by its code.
      const products = await api.get<ProductRow[]>('/api/v1/products');
      const want = tankForm.grade.toUpperCase();
      const product = products.find((p) => want.includes(p.code.toUpperCase()))
        ?? products.find((p) => want.includes(p.name.toUpperCase().split(' ')[0] ?? '~'));
      if (!tankForm.label.trim()) { flagProblem('p1', 'The tank needs a name, e.g. T1'); return; }
      if (!(tankForm.capacity > 0)) { flagProblem('p1', 'Capacity must be more than 0 litres'); return; }
      if (!product) { flagProblem('p1', `No product matches ${tankForm.grade} - add it under Products first`); return; }
      await api.post<unknown>('/api/admin/tanks', {
        code: tankForm.label.trim().toUpperCase(),
        productId: product.id,
        nominalLitres: tankForm.capacity,
        // Safe fill at 95% of nominal, the usual allowance for expansion,
        // and no dead stock until the tank's own chart says otherwise. Both
        // are starting points to correct, stated here rather than hidden.
        safeFill: Math.round(tankForm.capacity * 0.95),
        deadStock: 0,
        maxDipMm: 2400,
      }, { idempotencyKey: `tank-${tankForm.label.trim().toUpperCase()}` });
      const [eqRows, tankRows] = await Promise.all([
        api.get<EquipmentRow[]>('/api/admin/equipment'),
        api.get<TankInventoryRow[]>('/api/v1/inventory/tanks'),
      ]);
      setPumps(toPumps(eqRows));
      setTanks(tankRows.map(toSetupTank));
      setShowTankModal(false);
      showToast('Tank added', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  const deleteTank = (id: string) => void setActive('TANK', id, false);

  const inputCls = 'w-full rounded-xl px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-[var(--primary)]';
  const inputStyle = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' };

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
          Could not load the forecourt layout
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pump Setup</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            Configure pumps, nozzles, and link them to tanks
          </p>
        </div>
        <div className="flex gap-2">
          {activeTab === 'pumps' && (
            <button onClick={openAddPump} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)' }}>
              <Icon name="PlusIcon" size={16} />Add Pump
            </button>
          )}
          {activeTab === 'tanks' && (
            <button onClick={openAddTank} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)' }}>
              <Icon name="PlusIcon" size={16} />Add Tank
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        {(['pumps', 'tanks'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className="px-5 py-2 rounded-lg text-sm font-semibold capitalize transition-all"
            style={activeTab === tab ? { background: 'var(--primary)', color: '#000' } : { color: 'var(--muted-foreground)' }}>
            {tab === 'pumps' ? `Pumps (${pumps.length})` : `Tanks (${tanks.length})`}
          </button>
        ))}
      </div>

      {/* Pumps Tab */}
      {activeTab === 'pumps' && (
        <div className="grid gap-4">
          {pumps.map(pump => (
            <div key={pump.id} className="rounded-2xl p-5" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,212,160,0.1)', border: '1px solid rgba(0,212,160,0.2)' }}>
                    <Icon name="CpuChipIcon" size={20} className="text-[var(--primary)]" />
                  </div>
                  <div>
                    <p className="font-bold text-foreground">{pump.label}</p>
                    <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{pump.nozzles.length} nozzle{pump.nozzles.length !== 1 ? 's' : ''} configured</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => openAddNozzle(pump.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(0,212,160,0.1)', color: 'var(--primary)', border: '1px solid rgba(0,212,160,0.2)' }}>
                    <Icon name="PlusIcon" size={12} />Add Nozzle
                  </button>
                  <button onClick={() => openEditPump(pump)} className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }} aria-label="Edit" title="Edit">
                    <Icon name="PencilIcon" size={14} className="text-foreground" />
                  </button>
                  <button onClick={() => deletePump(pump.id)} className="p-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }} aria-label="Delete" title="Delete">
                    <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' }} />
                  </button>
                </div>
              </div>

              {pump.nozzles.length === 0 ? (
                <p className="text-sm text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No nozzles added yet. Click "Add Nozzle" to configure.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {pump.nozzles.map(nozzle => {
                    const tank = tanks.find(t => t.id === nozzle.tankId);
                    return (
                      <div key={nozzle.id} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: nozzle.gradeColor }} />
                            <span className="text-xs font-bold text-foreground">Nozzle {nozzle.nozzleNo}</span>
                          </div>
                          <div className="flex gap-1">
                            <button onClick={() => openEditNozzle(pump.id, nozzle)} className="p-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }} aria-label="Edit" title="Edit">
                              <Icon name="PencilIcon" size={11} className="text-foreground" />
                            </button>
                            <button onClick={() => deleteNozzle(pump.id, nozzle.id)} className="p-1 rounded" style={{ background: 'rgba(239,68,68,0.1)' }} aria-label="Delete" title="Delete">
                              <Icon name="TrashIcon" size={11} style={{ color: '#ef4444' }} />
                            </button>
                          </div>
                        </div>
                        <p className="text-xs font-semibold" style={{ color: nozzle.gradeColor }}>{nozzle.grade}</p>
                        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>→ {tank?.label ?? 'No tank linked'}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {pumps.length === 0 && (
            <div className="text-center py-16 rounded-2xl" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
              <Icon name="CpuChipIcon" size={40} className="mx-auto mb-3" style={{ color: 'var(--muted-foreground)' }} />
              <p className="text-foreground font-semibold">No pumps configured</p>
              <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Add your first pump to get started</p>
            </div>
          )}
        </div>
      )}

      {/* Tanks Tab */}
      {activeTab === 'tanks' && (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                  {['Tank', 'Grade', 'Capacity (L)', 'Linked Nozzles', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tanks.map((tank, i) => {
                  const linkedNozzles = pumps.flatMap(p => p.nozzles.filter(n => n.tankId === tank.id).map(n => `${p.label} N${n.nozzleNo}`));
                  return (
                    <tr key={tank.id} style={{ borderBottom: i < tanks.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      <td className="px-4 py-3 font-semibold text-foreground">{tank.label}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tank.gradeColor }} />
                          <span style={{ color: tank.gradeColor }}>{tank.grade}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground">{fmt(tank.capacity)} L</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {linkedNozzles.length === 0 ? (
                            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>None</span>
                          ) : linkedNozzles.map(n => (
                            <span key={n} className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(0,212,160,0.1)', color: 'var(--primary)', border: '1px solid rgba(0,212,160,0.2)' }}>{n}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button onClick={() => openEditTank(tank)} className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }} aria-label="Edit" title="Edit">
                            <Icon name="PencilIcon" size={14} className="text-foreground" />
                          </button>
                          <button onClick={() => deleteTank(tank.id)} className="p-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }} aria-label="Delete" title="Delete">
                            <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' }} />
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

      {/* Pump Modal */}
      {showPumpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editPumpId ? 'Edit Pump' : 'Add Pump'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Pump Label</label>
                <input className={inputCls} style={inputStyle} value={pumpForm.label} onChange={e => setPumpForm(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Pump 1" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Pump Number</label>
                <input type="number" className={inputCls} style={inputStyle} value={pumpForm.pumpNo} onChange={e => setPumpForm(p => ({ ...p, pumpNo: Number(e.target.value) }))} min={1} />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowPumpModal(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>Cancel</button>
              <button onClick={savePump} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-black" style={{ background: 'var(--primary)' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Nozzle Modal */}
      {showNozzleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editNozzleId ? 'Edit Nozzle' : 'Add Nozzle'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Nozzle Number</label>
                <input type="number" className={inputCls} style={inputStyle} value={nozzleForm.nozzleNo} onChange={e => setNozzleForm(p => ({ ...p, nozzleNo: Number(e.target.value) }))} min={1} />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Fuel Grade</label>
                <select className={inputCls} style={inputStyle} value={nozzleForm.grade} onChange={e => setNozzleForm(p => ({ ...p, grade: e.target.value }))}>
                  {GRADE_OPTIONS.map(g => <option key={g.label} value={g.label}>{g.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Link to Tank</label>
                <select className={inputCls} style={inputStyle} value={nozzleForm.tankId} onChange={e => setNozzleForm(p => ({ ...p, tankId: e.target.value }))}>
                  {tanks.map(t => <option key={t.id} value={t.id}>{t.label} – {t.grade}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowNozzleModal(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={saveNozzle} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-black" style={{ background: 'var(--primary)' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Tank Modal */}
      {showTankModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editTankId ? 'Edit Tank' : 'Add Tank'}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Tank Label</label>
                <input className={inputCls} style={inputStyle} value={tankForm.label} onChange={e => setTankForm(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Tank 1" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Fuel Grade</label>
                <select className={inputCls} style={inputStyle} value={tankForm.grade} onChange={e => setTankForm(p => ({ ...p, grade: e.target.value }))}>
                  {GRADE_OPTIONS.map(g => <option key={g.label} value={g.label}>{g.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Capacity (Litres)</label>
                <input type="number" className={inputCls} style={inputStyle} value={tankForm.capacity} onChange={e => setTankForm(p => ({ ...p, capacity: Number(e.target.value) }))} min={1000} step={1000} />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowTankModal(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p1} />
              <button onClick={saveTank} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-black" style={{ background: 'var(--primary)' }}>Save</button>
            </div>
          </div>
        </div>
      )}
      <PartialLoadNotice missing={partial} />
    </div>
  );
}
