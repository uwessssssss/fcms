'use client';
import { ApiError, api } from '@/lib/api';
import type { SiteApprovalRow, StaffRow } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useSites } from '@/lib/useSites';
import { FormProblem } from '@/components/ui/Issues';
import React, { useState, useCallback, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';

interface AppUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'head_office' | 'site_manager' | 'shift_supervisor' | 'attendant' | 'accountant';
  site: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  lastLogin: string;
  initials: string;
}

const ROLES = [
  { value: 'head_office', label: 'Head Office', color: 'var(--primary)' },
  { value: 'site_manager', label: 'Site Manager', color: '#3b82f6' },
  { value: 'shift_supervisor', label: 'Shift Supervisor', color: '#8b5cf6' },
  { value: 'accountant', label: 'Accountant', color: '#f59e0b' },
  { value: 'attendant', label: 'Attendant', color: '#22c55e' },
] as const;


/**
 * People come from /api/admin/staff.
 *
 * ATTENDANTS HAVE NO SIGN-IN, and that is not an oversight to paper over: they
 * are subjects of the record, not authors of it, and a composite foreign key
 * in the database makes it structurally impossible for one to author a
 * reading. So an operator shows with no last-login rather than a blank that
 * looks like a lapsed account.
 */
function toAppUser(r: StaffRow): AppUser {
  const role = r.role.toUpperCase();
  return {
    id: r.id,
    name: r.fullName,
    email: r.employeeNo,
    phone: r.phone ?? '',
    // From the ROLE, not the is_operator flag. That flag means "may author
    // records" (role <> ATTENDANT) and was read here as its opposite, so
    // supervisors showed as attendants and attendants as supervisors.
    role:
      role === 'SYSTEM_ADMIN' || role === 'HEAD_OFFICE'
        ? 'head_office'
        : role === 'MANAGER'
          ? 'site_manager'
          : role === 'ACCOUNTANT'
            ? 'accountant'
            : role === 'ATTENDANT'
              ? 'attendant'
              : 'shift_supervisor',
    site: '',
    status: !r.isActive
      ? 'inactive'
      : r.lockedUntil
        ? 'suspended'
        : 'active',
    createdAt: r.hiredOn ?? '',
    // Attendants have no sign-in by design; everyone else does.
    lastLogin: role === 'ATTENDANT'
      ? 'No sign-in — works the forecourt'
      : (r.lastLoginAt ?? 'Never'),
    initials: r.fullName
      .split(' ')
      .map((x) => x[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  };
}

const emptyForm: Omit<AppUser, 'id' | 'createdAt' | 'lastLogin' | 'initials'> = {
  name: '', email: '', phone: '', role: 'attendant', site: '', status: 'active',
};

const statusConfig = {
  active: { label: 'Active', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  inactive: { label: 'Inactive', color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
  suspended: { label: 'Suspended', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
} as const;

function getInitials(name: string) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

export default function UsersContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const SITES = ['All Sites', ...useSites()];
  const { assignedSite, assignedSiteId } = useAuth();

  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<StaffRow[]>('/api/admin/staff')
      .then((rows) => {
        if (!cancelled) {
          setUsers(rows.map(toAppUser));
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
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [form, setForm] = useState<Omit<AppUser, 'id' | 'createdAt' | 'lastLogin' | 'initials'>>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [filterRole, setFilterRole] = useState('all');
  const [filterSite, setFilterSite] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Which sites can approve their own shifts.
  //
  // Shown HERE rather than on a settings page nobody opens, because this is
  // the screen where somebody can do something about it: a site short of a
  // manager needs a manager appointed, and the button is right there.
  const [readiness, setReadiness] = useState<SiteApprovalRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<SiteApprovalRow[]>('/api/v1/organisation/approval-readiness')
      .then((rows) => {
        if (!cancelled) setReadiness(rows.filter((r) => !r.canSelfApprove && r.kind !== 'HEAD_OFFICE'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showModal]);
  const { showToast } = useToast();

  const filtered = users.filter((u) => {
    if (filterRole !== 'all' && u.role !== filterRole) return false;
    if (filterSite !== 'all' && u.site !== filterSite) return false;
    if (filterStatus !== 'all' && u.status !== filterStatus) return false;
    if (searchQuery && !u.name.toLowerCase().includes(searchQuery.toLowerCase()) && !u.email.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const openAdd = () => { setEditing(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (u: AppUser) => {
    setEditing(u);
    setForm({ name: u.name, email: u.email, phone: u.phone, role: u.role, site: u.site, status: u.status });
    setShowModal(true);
  };

  /**
   * Appointing somebody.
   *
   * This used to add a row to local state and say "User created successfully"
   * -- which was a lie the moment the page reloaded. Worse, it hid the rule
   * that matters: a MANAGER MAY NOT APPOINT ANOTHER MANAGER, because the
   * second manager is who approves the first one's shifts.
   *
   * The server enforces that. The point of this screen is to carry the
   * server's refusal back in the words it used, rather than a generic failure.
   */
  const handleSave = useCallback(async () => {
      clearProblem('p0');
    if (!form.name.trim() || !form.email.trim()) {
      flagProblem('p0', 'A name and an employee number are required'); return;
    }

    // Editing an existing person is not wired yet, and pretending otherwise is
    // how the old version misled. Say so.
    if (editing) {
      flagProblem('p0', 'Editing a person is not wired to the server yet'); return;
    }

    const roleForServer =
      form.role === 'head_office'
        ? 'HEAD_OFFICE'
        : form.role === 'site_manager'
          ? 'MANAGER'
          : form.role === 'accountant'
            ? 'ACCOUNTANT'
            : form.role === 'attendant'
              ? 'ATTENDANT'
              : 'SUPERVISOR';

    try {
      await api.post<{ id: string }>('/api/v1/organisation/people', {
        siteId: assignedSiteId,
        employeeNo: form.email.trim().toUpperCase(),
        fullName: form.name.trim(),
        role: roleForServer,
        phone: form.phone || null,
        hiredOn: null,
      }, { idempotencyKey: `person-${String(form.email.trim().toUpperCase())}` });

      showToast(`${form.name.trim()} appointed`, 'success');
      setShowModal(false);

      // Re-read rather than guessing what the server stored. It assigns the id
      // and may normalise the employee number, and a row invented here would
      // differ from the one everybody else sees.
      const rows = await api.get<StaffRow[]>('/api/admin/staff');
      setUsers(rows.map(toAppUser));
    } catch (e) {
      const err = e as ApiError;
      // MAY_NOT_APPOINT_THIS_ROLE carries the actual reason -- that a manager
      // cannot appoint their own reviewer. Show it; a generic "failed" here
      // would leave somebody wondering whether the server was down.
      showToast(err.message, 'error');
    }
  }, [form, editing, showToast, assignedSiteId, clearProblem, flagProblem]);
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      // Deactivated, not deleted: everything they signed stays attributed.
      await api.post<unknown>(`/api/admin/staff/${deleteTarget}/active?active=false`, {});
      const rows = await api.get<StaffRow[]>('/api/admin/staff');
      setUsers(rows.map(toAppUser));
      setDeleteTarget(null);
      showToast('Switched off - their history stays', 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };
  // Two different acts. UNLOCK clears a lockout after too many wrong
  // passwords. REVOKE takes away the ability to sign in at all and ends every
  // session -- refused by the database unless you could have appointed them,
  // so a manager cannot lock out the other manager.
  const accessAction = async (u: AppUser, action: 'unlock' | 'revoke-access') => {
    try {
      // Two literal paths, not one built from `action`: a path assembled from
      // a variable cannot be matched to a route by anyone reading it -- and
      // the wiring check could not verify it either.
      if (action === 'unlock') await api.post<unknown>(`/api/admin/staff/${u.id}/unlock`, {});
      else await api.post<unknown>(`/api/admin/staff/${u.id}/revoke-access`, {});
      showToast(action === 'unlock' ? `${u.name} can sign in again` : `${u.name} can no longer sign in`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const toggleStatus = async (u: AppUser) => {
    const activate = u.status !== 'active';
    try {
      await api.post<unknown>(`/api/admin/staff/${u.id}/active?active=${activate}`, {});
      const rows = await api.get<StaffRow[]>('/api/admin/staff');
      setUsers(rows.map(toAppUser));
      showToast(activate ? `${u.name} switched on` : `${u.name} switched off`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const getRoleConfig = (role: string) => ROLES.find(r => r.value === role) ?? { label: role, color: '#6b7280' };

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
          Could not load the staff list
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
    {/* A site that cannot approve its own shifts. Named, with the reason,
        because "two managers" is a rule nobody remembers until a shift
        will not close at the end of a long night. */}
    {readiness.length > 0 && (
      <div
        className="mb-4 rounded-xl px-4 py-3"
        style={{
          background: 'var(--watch-bg)',
          border: '1px solid var(--watch-edge)',
        }}
      >
        <p className="text-sm font-semibold" style={{ color: 'var(--watch)' }}>
          {readiness.length} site{readiness.length === 1 ? '' : 's'} cannot approve their own shifts
        </p>
        {readiness.map((r) => (
          <p key={r.siteId} className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            <strong>{r.name}</strong> — {r.note}
          </p>
        ))}
      </div>
    )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">User Management</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Create, manage and control access for all forecourt staff
          </p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
          <Icon name="UserPlusIcon" size={15} />Create User
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Users', value: String(users.length), icon: 'UsersIcon', color: 'var(--primary)' },
          { label: 'Active', value: String(users.filter(u => u.status === 'active').length), icon: 'CheckCircleIcon', color: '#22c55e' },
          { label: 'Suspended', value: String(users.filter(u => u.status === 'suspended').length), icon: 'NoSymbolIcon', color: '#ef4444' },
          { label: 'Sites Covered', value: String(new Set(users.map(u => u.site)).size), icon: 'BuildingStorefrontIcon', color: '#3b82f6' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${c.color}20` }}>
                <Icon name={c.icon as Parameters<typeof Icon>[0]['name']} size={16} style={{ color: c.color } as React.CSSProperties} />
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{c.label}</span>
            </div>
            <p className="text-xl font-bold font-mono-nums text-foreground">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by name or email..." className="input-field w-full pl-8 py-1.5 text-xs" />
        </div>
        <select value={filterRole} onChange={e => setFilterRole(e.target.value)} className="input-field py-1.5 px-3 text-xs">
          <option value="all">All Roles</option>
          {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <select value={filterSite} onChange={e => setFilterSite(e.target.value)} className="input-field py-1.5 px-3 text-xs">
          <option value="all">All Sites</option>
          {SITES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input-field py-1.5 px-3 text-xs">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
        </select>
        <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{filtered.length} users</span>
      </div>

      {/* Users Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((u) => {
          const sc = statusConfig[u.status] ?? { ...Object.values(statusConfig)[0], label: String(u.status) };   // unknown value: neutral, not a crash
          const rc = getRoleConfig(u.role);
          return (
            <div key={u.id} className="rounded-xl border p-4 space-y-3 hover:shadow-md transition-shadow" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold" style={{ backgroundColor: `${rc.color}20`, color: rc.color }}>
                    {u.initials}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{u.name}</p>
                    <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{u.email}</p>
                  </div>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: sc.bg, color: sc.color }}>{sc.label}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${rc.color}15`, color: rc.color }}>{rc.label}</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                  <Icon name="BuildingStorefrontIcon" size={10} className="inline mr-1" />
                  {u.site}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <div>
                  <span className="block font-medium">Phone</span>
                  <span className="font-mono-nums">{u.phone}</span>
                </div>
                <div>
                  <span className="block font-medium">Last Login</span>
                  <span>{u.lastLogin}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
                <button onClick={() => openEdit(u)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>
                  <Icon name="PencilSquareIcon" size={13} />Edit
                </button>
                {u.role !== 'attendant' && (
                  <>
                    <button onClick={() => void accessAction(u, 'unlock')} title="Clear a lockout"
                            className="px-2 py-1 mr-1 rounded-lg text-xs" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>Unlock</button>
                    <button onClick={() => void accessAction(u, 'revoke-access')} title="Stop them signing in"
                            className="px-2 py-1 mr-1 rounded-lg text-xs" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>Revoke</button>
                  </>
                )}
                <button onClick={() => toggleStatus(u)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: u.status === 'active' ? '#f59e0b' : '#22c55e' }}>
                  <Icon name={u.status === 'active' ? 'PauseCircleIcon' : 'PlayCircleIcon'} size={13} />
                  {u.status === 'active' ? 'Suspend' : 'Activate'}
                </button>
                <button onClick={() => setDeleteTarget(u.id)} className="p-1.5 rounded-lg border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: '#ef4444' }} title="Delete user">
                  <Icon name="TrashIcon" size={14} />
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-3 py-12 text-center" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="UsersIcon" size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No users found matching your filters</p>
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit User' : 'Create New User'} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Full Name *</label>
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input-field w-full text-sm" placeholder="Full name" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Email *</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input-field w-full text-sm" placeholder="user@company.com" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Phone</label>
              <input type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input-field w-full text-sm" placeholder="+256 7XX XXX XXX" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Role</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as AppUser['role'] }))} className="input-field w-full text-sm">
                {/* The API appoints station roles only; it refuses HEAD_OFFICE here
                    (AdminService.Roles), so the form no longer offers it. */}
                {ROLES.filter(r => r.value !== 'head_office').map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Assigned Site</label>
              <select value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} className="input-field w-full text-sm">
                {SITES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as AppUser['status'] }))} className="input-field w-full text-sm">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          </div>
          {!editing && (
            <div className="p-3 rounded-lg text-xs" style={{ backgroundColor: 'rgba(var(--primary-rgb),0.08)', color: 'var(--muted-foreground)' }}>
              <Icon name="InformationCircleIcon" size={13} className="inline mr-1" />
              A temporary password will be sent to the user&apos;s email upon creation.
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
            <FormProblem msg={problems.p0} />
            <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {editing ? 'Update User' : 'Create User'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete User" size="sm">
        <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>Permanently delete this user? They will lose all access immediately.</p>
        <div className="flex justify-end gap-3">
          <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
          <button onClick={handleDelete} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: '#ef4444', color: '#fff' }}>Delete User</button>
        </div>
      </Modal>
    </div>
  );
}
