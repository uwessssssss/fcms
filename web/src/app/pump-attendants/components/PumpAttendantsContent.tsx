'use client';
import { ApiError, api } from '@/lib/api';
import type { DashboardOverview, StaffRow } from '@/types/api';
import { useSites } from '@/lib/useSites';
import { businessToday } from '@/lib/dates';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

interface Attendant {
  id: string;
  name: string;
  badge: string;
  phone: string;
  assignedNozzles: string[];
  status: 'active' | 'inactive';
  site: string;
  joinDate: string;
}


const NOZZLE_OPTIONS = [
  'Pump 1 – Nozzle 1 (AGO)', 'Pump 1 – Nozzle 2 (AGO)',
  'Pump 1 – Nozzle 3 (PMS)', 'Pump 1 – Nozzle 4 (PMS)',
  'Pump 2 – Nozzle 1 (AGO)', 'Pump 2 – Nozzle 2 (AGO)',
  'Pump 2 – Nozzle 3 (PMS)', 'Pump 2 – Nozzle 4 (PMS)',
];

/**
 * Attendants, from GET /api/admin/staff filtered to operators.
 *
 * AN ATTENDANT HAS NO SIGN-IN, and that is the defining fact about them rather
 * than a missing feature. They are subjects of the record, not authors of it:
 * a composite foreign key in the schema makes it structurally impossible for
 * one to author a meter reading, so there is no code path around it.
 *
 * The filter is the ROLE, read directly. It used to be `isOperator`, on the
 * belief that an operator works a nozzle -- but the schema defines it as
 * role <> 'ATTENDANT': an operator is someone allowed to AUTHOR records. The
 * filter was exactly inverted, and this screen listed supervisors and managers
 * as pump attendants while leaving every real attendant off.
 */
function toAttendant(r: StaffRow): Attendant {
  return {
    id: r.id,
    name: r.fullName,
    badge: r.employeeNo,
    phone: r.phone ?? '',
    // Which nozzles they hold belongs to the OPEN SHIFT, not to the person --
    // a roster changes every shift. This screen lists who is on strength.
    assignedNozzles: [],
    status: r.isActive ? 'active' : 'inactive',
    site: r.siteName,
    joinDate: r.hiredOn ?? '',
  };
}

const EMPTY_FORM = { name: '', badge: '', phone: '', assignedNozzles: [] as string[], status: 'active' as Attendant['status'], site: '', joinDate: businessToday() };

export default function PumpAttendantsContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = useSites();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<StaffRow[]>('/api/admin/staff')
      .then((rows) => {
        if (!cancelled) {
          setAttendants(rows.filter((x) => x.role.toUpperCase() === 'ATTENDANT').map(toAttendant));
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

  const { isSiteManager, assignedSite, assignedSiteId } = useAuth();
  const [attendants, setAttendants] = useState<Attendant[]>([]);
  const [siteFilter, setSiteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const { showToast } = useToast();

  const scopedAttendants = isSiteManager && assignedSite
    ? attendants.filter(a => !a.site || a.site === assignedSite)   // rows carry no site; the API scopes them (W1)
    : attendants;

  const filtered = scopedAttendants.filter(a => {
    if (!isSiteManager && siteFilter !== 'all' && a.site !== siteFilter) return false;
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase()) && !a.badge.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openAdd = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM, badge: `ATT-${String(attendants.length + 1).padStart(3, '0')}` });
    setShowModal(true);
  };
  const openEdit = (a: Attendant) => {
    setEditId(a.id);
    const { id, ...rest } = a;
    setForm(rest);
    setShowModal(true);
  };
  /**
   * Put an attendant on strength. Through the organisation endpoint, which
   * asks the database who may appoint whom -- the same gate as every person.
   * An attendant gets no sign-in: they are subjects of the record, not authors.
   */
  const handleSave = async () => {
      clearProblem('p0');
    if (!form.name.trim()) return;
    if (editId) {
      try {
        // The role stays ATTENDANT, so the appointment rule has nothing to
        // weigh. Changing someone's role is a different act, done by whoever
        // could have appointed them -- the database enforces that on every
        // route since migration 280.
        await api.put<unknown>(`/api/admin/staff/${editId}`, {
          employeeNo: (form.badge || '').trim().toUpperCase(),
          fullName: form.name.trim(),
          role: 'ATTENDANT',
          phone: form.phone || null,
          hiredOn: form.joinDate || null,
        });
        const rows = await api.get<StaffRow[]>('/api/admin/staff');
        setAttendants(rows.filter((x) => x.role.toUpperCase() === 'ATTENDANT').map(toAttendant));
        setShowModal(false);
        showToast(`${form.name.trim()} updated`, 'success');
      } catch (e) {
        showToast((e as ApiError).message, 'error');
      }
      return;
    }
    try {
      let siteId = assignedSiteId;
      if (!siteId) {
        // Head office has no trading site of its own: use the one chosen.
        const ov = await api.get<DashboardOverview>('/api/v1/dashboard/overview');
        siteId = (ov.sites.find((x) => x.name === form.site) ?? ov.sites[0])?.id ?? null;
      }
      if (!siteId) { flagProblem('p0', 'There is no trading site to put them on yet'); return; }
      await api.post<{ id: string }>('/api/v1/organisation/people', {
        siteId,
        employeeNo: (form.badge || '').trim().toUpperCase() || `ATT${Date.now() % 100000}`,
        fullName: form.name.trim(),
        role: 'ATTENDANT',
        phone: form.phone || null,
        hiredOn: form.joinDate || null,
      }, { idempotencyKey: `person-${String((form.badge || '').trim().toUpperCase() || `ATT${Date.now() % 100000}`)}` });
      const rows = await api.get<StaffRow[]>('/api/admin/staff');
      setAttendants(rows.filter((x) => x.role.toUpperCase() === 'ATTENDANT').map(toAttendant));
      setShowModal(false);
      showToast(`${form.name.trim()} is on strength`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  // Switched off, never deleted: their meter readings and cash-ups must keep
  // a subject. This removed them from the screen only.
  const handleDelete = async (id: string) => {
    try {
      await api.post<unknown>(`/api/admin/staff/${id}/active?active=false`, {});
      const rows = await api.get<StaffRow[]>('/api/admin/staff');
      setAttendants(rows.filter((x) => x.role.toUpperCase() === 'ATTENDANT').map(toAttendant));
      showToast('Switched off - their history stays', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  const toggleStatus = (id: string) => {
    setAttendants(prev => prev.map(a => a.id === id ? { ...a, status: a.status === 'active' ? 'inactive' : 'active' } : a));
  };
  const toggleNozzle = (nozzle: string) => {
    setForm(prev => ({
      ...prev,
      assignedNozzles: prev.assignedNozzles.includes(nozzle)
        ? prev.assignedNozzles.filter(n => n !== nozzle)
        : [...prev.assignedNozzles, nozzle],
    }));
  };

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
          Could not load attendants
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
          <h1 className="text-2xl font-bold text-foreground">Pump Attendants</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Manage attendants and assign them to specific nozzles</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)' }}>
          <Icon name="PlusIcon" size={16} />Add Attendant
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Attendants', value: attendants.length, icon: 'UsersIcon', color: '#3b82f6' },
          { label: 'Active', value: attendants.filter(a => a.status === 'active').length, icon: 'CheckCircleIcon', color: '#22c55e' },
          { label: 'Inactive', value: attendants.filter(a => a.status === 'inactive').length, icon: 'XCircleIcon', color: '#ef4444' },
          { label: 'Unassigned', value: attendants.filter(a => a.assignedNozzles.length === 0).length, icon: 'ExclamationCircleIcon', color: '#f59e0b' },
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
          <input className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm text-foreground outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} placeholder="Search by name or badge..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
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
                {['Attendant', 'Badge', 'Phone', 'Site', 'Assigned Nozzles', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a, i) => (
                <tr key={a.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'rgba(0,212,160,0.15)', color: 'var(--primary)' }}>
                        {a.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <span className="font-semibold text-foreground">{a.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><span className="font-mono text-xs px-2 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>{a.badge}</span></td>
                  <td className="px-4 py-3 text-foreground">{a.phone}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--muted-foreground)' }}>{a.site}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {a.assignedNozzles.length === 0 ? (
                        <span className="text-xs" style={{ color: '#f59e0b' }}>Unassigned</span>
                      ) : a.assignedNozzles.map(n => (
                        <span key={n} className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(0,212,160,0.1)', color: 'var(--primary)' }}>{n}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleStatus(a.id)} className="px-2.5 py-1 rounded-full text-xs font-semibold" style={a.status === 'active' ? { background: 'rgba(34,197,94,0.15)', color: '#22c55e' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                      {a.status === 'active' ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(a)} className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        <Icon name="PencilIcon" size={14} className="text-foreground" />
                      </button>
                      <button onClick={() => handleDelete(a.id)} className="p-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
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
              <Icon name="UsersIcon" size={36} className="mx-auto mb-2" style={{ color: 'var(--muted-foreground)' }} />
              <p className="text-foreground font-semibold">No attendants found</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-lg font-bold text-foreground mb-5">{editId ? 'Edit Attendant' : 'Add Attendant'}</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Full Name *</label>
                  <input className={inputCls} style={inputStyle} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Badge No.</label>
                  <input className={inputCls} style={inputStyle} value={form.badge} onChange={e => setForm(p => ({ ...p, badge: e.target.value }))} placeholder="ATT-001" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Phone</label>
                  <input className={inputCls} style={inputStyle} value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} placeholder="+256 7XX XXX XXX" />
                </div>
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
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Join Date</label>
                  <input type="date" className={inputCls} style={inputStyle} value={form.joinDate} onChange={e => setForm(p => ({ ...p, joinDate: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Status</label>
                  <select className={inputCls} style={inputStyle} value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value as 'active' | 'inactive' }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-2" style={{ color: 'var(--muted-foreground)' }}>Assigned Nozzles (select all that apply)</label>
                <div className="grid grid-cols-2 gap-2">
                  {NOZZLE_OPTIONS.map(nozzle => (
                    <label key={nozzle} className="flex items-center gap-2 p-2 rounded-lg cursor-pointer" style={{ background: form.assignedNozzles.includes(nozzle) ? 'rgba(0,212,160,0.1)' : 'rgba(255,255,255,0.03)', border: `1px solid ${form.assignedNozzles.includes(nozzle) ? 'rgba(0,212,160,0.3)' : 'rgba(255,255,255,0.07)'}` }}>
                      <input type="checkbox" checked={form.assignedNozzles.includes(nozzle)} onChange={() => toggleNozzle(nozzle)} className="accent-[var(--primary)]" />
                      <span className="text-xs text-foreground">{nozzle}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--muted-foreground)' }}>Cancel</button>
              <FormProblem msg={problems.p0} />
              <button onClick={handleSave} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-black" style={{ background: 'var(--primary)' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
