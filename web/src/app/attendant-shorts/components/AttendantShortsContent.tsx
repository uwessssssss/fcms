'use client';
import { useStatement, field, num } from '@/lib/useStatement';
import { ApiError, api } from '@/lib/api';
import { useSites } from '@/lib/useSites';
import type { StaffRow } from '@/types/api';
import { businessToday } from '@/lib/dates';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';
import { shiftLabelName } from '@/lib/shiftLabel';

interface Short {
  id: string;
  date: string;
  shift: string;
  attendantName: string;
  badge: string;
  nozzle: string;
  expectedAmount: number;
  actualAmount: number;
  shortAmount: number;
  status: 'pending' | 'resolved' | 'written-off';
  /** Carried from the server so a recovery can name what it recovers. */
  shortageId?: string;
  staffId?: string;
  recovered?: number;
  outstanding?: number;
  notes: string;
  site: string;
}

const NOZZLES = ['Pump 1 – Nozzle 1 (AGO)', 'Pump 1 – Nozzle 2 (AGO)', 'Pump 1 – Nozzle 3 (PMS)', 'Pump 1 – Nozzle 4 (PMS)', 'Pump 2 – Nozzle 1 (AGO)', 'Pump 2 – Nozzle 2 (AGO)', 'Pump 2 – Nozzle 3 (PMS)', 'Pump 2 – Nozzle 4 (PMS)'];

/**
 * Shortages, from GET /api/statements/shortages
 *
 * Raised, recovered and still owed. A shortage nobody chased is a wage
 * subsidy, which is why the outstanding column matters more than the raised.
 */
function toShort(r: Record<string, unknown>): Short {
  return {
    // The shortage's own id: two shortages for one person on one day (a day
    // and a night shift) used to share a key and one hid the other.
    id: field(r, 'shortage_id') || field(r, 'date') + field(r, 'employee_no'),
    date: field(r, 'date'),
    shift: shiftLabelName(field(r, 'shift')),
    attendantName: field(r, 'attendant'),
    badge: field(r, 'employee_no'),
    nozzle: '',
    // Expected and actual are not on this statement: it reports the SHORTAGE,
    // which is their difference. Deriving a pair from one figure would invent
    // two numbers that never existed.
    expectedAmount: num(r, 'raised'),
    actualAmount: 0,
    shortAmount: num(r, 'raised'),
    // 'resolved', which is what the badges know. This returned 'recovered' --
    // not a status this screen has -- and a cast hid it from the compiler, so
    // a settled shortage rendered with a badge for nothing.
    status: field(r, 'status').toLowerCase() === 'settled' ? 'resolved' : 'pending',
    shortageId: field(r, 'shortage_id') || undefined,
    staffId: field(r, 'staff_id') || undefined,
    recovered: num(r, 'recovered'),
    outstanding: num(r, 'outstanding'),
    notes: field(r, 'reason'),
    site: field(r, 'site'),
  } as Short;
}

const EMPTY_FORM = {
  date: businessToday(),
  shift: 'Day',
  attendantName: '',
  badge: 'ATT-001',
  nozzle: NOZZLES[0],
  expectedAmount: 0,
  actualAmount: 0,
  shortAmount: 0,
  status: 'pending' as Short['status'],
  notes: '',
  site: '',
};

function fmt(n: number) { return 'UGX ' + n.toLocaleString('en-UG'); }

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  pending: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  resolved: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
  'written-off': { bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
};

export default function AttendantShortsContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  // The real attendants. This dropdown listed six invented people --
  // "James Okoro (ATT-001)" and so on -- from the template.
  const [ATTENDANTS, setAttendantNames] = useState<string[]>([]);
  useEffect(() => {
    void api
      .get<StaffRow[]>('/api/admin/staff')
      .then((rows) => setAttendantNames(
        rows.filter((r) => r.role.toUpperCase() === 'ATTENDANT' && r.isActive)
            .map((r) => `${r.fullName} (${r.employeeNo})`)))
      .catch(() => undefined);
  }, []);
  const SITES = useSites();
  const { rows: liveRows, loading, error: loadError, reload: reloadShorts } =
    useStatement<Short>('shortages', toShort);

  const { isSiteManager, assignedSite } = useAuth();
  const [shorts, setShorts] = useState<Short[]>([]);

  // ── RECOVERY ──
  // Money an attendant repays against a shortage. The server refuses a
  // recovery larger than what is still owed (OVER_RECOVERY), a salary
  // deduction without a signed acknowledgement, and a write-off by anyone
  // without shortage.write_off -- so this form offers the choices and lets the
  // database say no in its own words.
  const [recovering, setRecovering] = useState<Short | null>(null);
  const [recAmount, setRecAmount] = useState('');
  const [recMethod, setRecMethod] = useState('CASH');
  const [recAck, setRecAck] = useState(false);
  const [recEvidence, setRecEvidence] = useState('');

  const openRecovery = (s0: Short) => {
    setRecovering(s0);
    setRecAmount(String(s0.outstanding ?? ''));
    setRecMethod('CASH');
    setRecAck(false);
    setRecEvidence('');
  };

  const submitRecovery = async () => {
      clearProblem('p0');
    if (!recovering?.staffId) return;
    const amount = Number(recAmount);
    if (!(amount > 0)) { flagProblem('p0', 'Enter the amount recovered'); return; }
    if (amount > (recovering.outstanding ?? 0)) {
      flagProblem('p0', `Only ${(recovering.outstanding ?? 0).toLocaleString()} is still owed`); return;
    }
    if (recMethod === 'SALARY_DEDUCTION' && (!recAck || !recEvidence.trim())) {
      showToast('A salary deduction needs the attendant\'s signed acknowledgement, and a link to it', 'error');
      return;
    }
    try {
      await api.post<unknown>('/api/ops/shortages/recover', {
        staffId: recovering.staffId,
        shortageId: recovering.shortageId ?? null,
        amount,
        method: recMethod,
        acknowledged: recAck,
        evidenceUrl: recEvidence.trim() || null,
      }, {
        // A retried recovery must not dock the same money twice.
        submission: `recovery:${recovering.shortageId ?? recovering.staffId}`,
      });
      setRecovering(null);
      reloadShorts();
      showToast(`${amount.toLocaleString()} recovered from ${recovering.attendantName}`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  // Seeded from the server. Without this the hook fetched, the rows sat in
  // `liveRows`, and the table rendered this array -- which nothing ever filled.
  // The screen was blank while reporting no error at all.
  useEffect(() => setShorts(liveRows), [liveRows]);
  const [siteFilter, setSiteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const { showToast } = useToast();

  const scopedShorts = isSiteManager && assignedSite
    ? shorts.filter(s => s.site === assignedSite)
    : shorts;

  const filtered = scopedShorts.filter(s => {
    if (!isSiteManager && siteFilter !== 'all' && s.site !== siteFilter) return false;
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (dateFrom && s.date < dateFrom) return false;
    if (dateTo && s.date > dateTo) return false;
    return true;
  });

  const totalShorts = filtered.reduce((sum, s) => sum + s.shortAmount, 0);
  const pendingShorts = filtered.filter(s => s.status === 'pending').reduce((sum, s) => sum + s.shortAmount, 0);
  const resolvedShorts = filtered.filter(s => s.status === 'resolved').reduce((sum, s) => sum + s.shortAmount, 0);

  const openAdd = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setShowModal(true);
  };
  const openEdit = (s: Short) => {
    setEditId(s.id);
    const { id, ...rest } = s;
    setForm(rest);
    setShowModal(true);
  };
  /**
   * A shortage cannot be typed in here, and that is the control, not a gap.
   *
   * This form raised a shortage as "expected minus actual" typed by hand. On
   * the server a shortage is tied to exactly one cash-up -- a unique link --
   * because the expected figure has to come from the METERS, not from a
   * number somebody entered. A hand-typed shortage could be raised against
   * anyone, for any amount, twice. Shortages are raised at shift close, where
   * the meters, the tanks and the attendant's declaration meet.
   */
  const handleSave = () => {
    showToast(
      'Shortages are raised at shift close, from the meters against the attendant\'s cash-up — not typed in here. Close the shift to raise one.',
      'error',
    );
    setShowModal(false);
  };
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const handleDelete = (_id: string) => {
    showToast('A shortage is a debt against a person - it is never deleted. Record a recovery or a write-off instead.', 'error');
  };
  // Refused, with the reason. This used to change the screen and announce
  // success without reaching the server, so the change vanished on reload.
  const updateStatus = (_id: string, _status: Short['status']) => {
    showToast("A shortage's status follows its recoveries. Use Recover rather than changing the label.", 'error');
  };

  const inputCls = 'w-full rounded-xl px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-[var(--primary)]';
  const inputStyle = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Attendant Shorts</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Track and manage pump attendant cash shortages</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)' }}>
          <Icon name="PlusIcon" size={16} />Record Short
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total Shorts', value: fmt(totalShorts), icon: 'ExclamationTriangleIcon', color: '#ef4444' },
          { label: 'Pending Recovery', value: fmt(pendingShorts), icon: 'ClockIcon', color: '#f59e0b' },
          { label: 'Recovered', value: fmt(resolvedShorts), icon: 'CheckCircleIcon', color: '#22c55e' },
        ].map(card => (
          <div key={card.label} className="rounded-2xl p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${card.color}18` }}>
                <Icon name={card.icon} size={20} style={{ color: card.color }} />
              </div>
              <div>
                <p className="text-lg font-bold text-foreground">{card.value}</p>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{card.label}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        {isSiteManager && assignedSite ? (
          <span className="px-3 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
            📍 {assignedSite}
          </span>
        ) : (
          <select className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={siteFilter} onChange={e => setSiteFilter(e.target.value)}>
            <option value="all">All Sites</option>
            {SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <select className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
          <option value="written-off">Written Off</option>
        </select>
        <input type="date" className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <input type="date" className="px-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Date/Shift', 'Attendant', 'Nozzle', 'Expected', 'Actual', 'Short', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-foreground">{s.date}</p>
                    <p className="text-xs capitalize" style={{ color: 'var(--muted-foreground)' }}>{s.shift}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-foreground">{s.attendantName}</p>
                    <p className="text-xs font-mono" style={{ color: 'var(--muted-foreground)' }}>{s.badge}</p>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>{s.nozzle}</td>
                  <td className="px-4 py-3 text-foreground">{s.expectedAmount.toLocaleString('en-UG')}</td>
                  <td className="px-4 py-3 text-foreground">{s.actualAmount.toLocaleString('en-UG')}</td>
                  <td className="px-4 py-3 font-bold" style={{ color: '#ef4444' }}>{s.shortAmount.toLocaleString('en-UG')}</td>
                  <td className="px-4 py-3">
                    <select value={s.status} onChange={e => updateStatus(s.id, e.target.value as Short['status'])} className="px-2 py-1 rounded-full text-xs font-semibold outline-none cursor-pointer" style={{ ...STATUS_STYLES[s.status], border: 'none' }}>
                      <option value="pending">Pending</option>
                      <option value="resolved">Resolved</option>
                      <option value="written-off">Written Off</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {s.status === 'pending' && (s.outstanding ?? 0) > 0 && s.staffId && (
                        <button
                          onClick={() => openRecovery(s)}
                          className="px-2 py-1 rounded-lg text-xs font-semibold"
                          style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}
                        >
                          Recover
                        </button>
                      )}
                      <button onClick={() => openEdit(s)} className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        <Icon name="PencilIcon" size={14} className="text-foreground" />
                      </button>
                      <button onClick={() => handleDelete(s.id)} className="p-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
                        <Icon name="TrashIcon" size={14} style={{ color: '#ef4444' }} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <Icon name="CheckCircleIcon" size={36} className="mx-auto mb-2" style={{ color: '#22c55e' }} />
              <p className="text-foreground font-semibold">No shorts recorded</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {recovering && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="w-full max-w-md rounded-2xl border p-5 space-y-3" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold text-foreground">Record a recovery</h2>
              <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                {recovering.attendantName} · {(recovering.outstanding ?? 0).toLocaleString()} still owed
              </p>
            </div>
            <label className="block text-xs">
              <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>Amount recovered</span>
              <input type="number" min={0} className="input-field w-full" value={recAmount}
                     onChange={(e) => setRecAmount(e.target.value)} />
            </label>
            <label className="block text-xs">
              <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>How</span>
              <select className="input-field w-full" value={recMethod} onChange={(e) => setRecMethod(e.target.value)}>
                <option value="CASH">Paid back in cash</option>
                <option value="SALARY_DEDUCTION">Deducted from wages</option>
                <option value="NEXT_SHIFT_OFFSET">Offset against a later shift</option>
                <option value="WRITE_OFF">Written off (needs authority)</option>
              </select>
            </label>
            {recMethod === 'SALARY_DEDUCTION' && (
              <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={recAck} onChange={(e) => setRecAck(e.target.checked)} />
                  <span>The attendant has signed an acknowledgement of this deduction.</span>
                </label>
                <input className="input-field w-full text-xs" placeholder="Link to the signed acknowledgement"
                       value={recEvidence} onChange={(e) => setRecEvidence(e.target.value)} />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setRecovering(null)} className="flex-1 py-2 rounded-xl text-sm"
                      style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={submitRecovery} className="flex-1 py-2 rounded-xl text-sm font-semibold"
                      style={{ background: '#22c55e', color: '#fff' }}>Record recovery</button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editId ? 'Edit Short Record' : 'Record Short'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Date</label>
                  <input type="date" className={inputCls} style={inputStyle} value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Shift</label>
                  <select className={inputCls} style={inputStyle} value={form.shift} onChange={e => setForm(p => ({ ...p, shift: e.target.value }))}>
                    <option value="Day">Day</option>
                    <option value="Mid">Mid</option>
                    <option value="Night">Night</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Attendant</label>
                  <select className={inputCls} style={inputStyle} value={form.attendantName} onChange={e => {
                    const parts = e.target.value.split(' (');
                    setForm(p => ({ ...p, attendantName: parts[0], badge: parts[1]?.replace(')', '') ?? '' }));
                  }}>
                    {ATTENDANTS.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Nozzle</label>
                  <select className={inputCls} style={inputStyle} value={form.nozzle} onChange={e => setForm(p => ({ ...p, nozzle: e.target.value }))}>
                    {NOZZLES.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Expected (UGX)</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.expectedAmount} onChange={e => setForm(p => ({ ...p, expectedAmount: Number(e.target.value) }))} min={0} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Actual (UGX)</label>
                  <input type="number" className={inputCls} style={inputStyle} value={form.actualAmount} onChange={e => setForm(p => ({ ...p, actualAmount: Number(e.target.value) }))} min={0} />
                </div>
              </div>
              <div className="p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Calculated Short</p>
                <p className="text-xl font-bold" style={{ color: '#ef4444' }}>UGX {Math.max(0, form.expectedAmount - form.actualAmount).toLocaleString('en-UG')}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Site</label>
                  {isSiteManager && assignedSite ? (
                    <div className={inputCls} style={{ ...inputStyle, color: 'rgb(96,165,250)', fontWeight: 600 }}>
                      {assignedSite}
                    </div>
                  ) : (
                    <select className={inputCls} style={inputStyle} value={form.site} onChange={e => setForm(p => ({ ...p, site: e.target.value }))}>
                      {SITES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Status</label>
                  <select className={inputCls} style={inputStyle} value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value as Short['status'] }))}>
                    <option value="pending">Pending</option>
                    <option value="resolved">Resolved</option>
                    <option value="written-off">Written Off</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Notes</label>
                <textarea className={inputCls} style={inputStyle} rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Additional notes..." />
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
  );
}
