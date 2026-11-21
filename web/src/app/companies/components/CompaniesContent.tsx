'use client';

import { FormProblem } from '@/components/ui/Issues';
import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { CompanyRow } from '@/types/api';
import { useToast } from '@/components/ui/Toast';
import Modal from '@/components/ui/Modal';
import StatusBadge from '@/components/ui/StatusBadge';

/**
 * Companies, for the system administrator.
 *
 * This is the only screen above a company rather than inside one, and it is
 * the first thing that happens when a dealer signs up: a company exists, a
 * head office exists, and only then can anybody be appointed to anything.
 *
 * THE HEAD OFFICE IS PART OF THE SAME FORM, not a second step. A company
 * without one has nobody who may appoint its managers, so it cannot be
 * staffed -- and a setup wizard that lets you create something unusable has
 * only moved the error somewhere less helpful.
 */

interface CompanyForm {
  name: string;
  legalName: string;
  registrationNo: string;
  taxId: string;
  countryCode: string;
  baseCurrency: string;
  timezone: string;
  headOfficeName: string;
  headOfficeAddress: string;
  /** The first person in the company. Required -- see CreateCompany. */
  headOfficeEmployeeNo: string;
  headOfficeManagerName: string;
  headOfficePhone: string;
}

const EMPTY: CompanyForm = {
  name: '',
  legalName: '',
  registrationNo: '',
  taxId: '',
  countryCode: 'UG',
  baseCurrency: 'UGX',
  timezone: 'Africa/Kampala',
  headOfficeName: '',
  headOfficeEmployeeNo: '',
  headOfficeManagerName: '',
  headOfficePhone: '',
  headOfficeAddress: '',
};

const COUNTRIES = [
  { code: 'UG', name: 'Uganda', currency: 'UGX', tz: 'Africa/Kampala' },
  { code: 'KE', name: 'Kenya', currency: 'KES', tz: 'Africa/Nairobi' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS', tz: 'Africa/Dar_es_Salaam' },
  { code: 'RW', name: 'Rwanda', currency: 'RWF', tz: 'Africa/Kigali' },
  { code: 'SS', name: 'South Sudan', currency: 'SSP', tz: 'Africa/Juba' },
];

function fmt(n: number): string {
  return n.toLocaleString();
}

export default function CompaniesContent() {
  // A form's problem stays beside its save button until fixed (FormProblem).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const flagProblem = (k: string, m: string) => setProblems((p) => ({ ...p, [k]: m }));
  const clearProblem = (k: string) => setProblems((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k]; return n; });
  const { showToast } = useToast();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CompanyForm>(EMPTY);

  const load = useCallback(() => {
    setLoading(true);
    void api
      .get<CompanyRow[]>('/api/v1/organisation/companies')
      .then((rows) => {
        setCompanies(rows);
        setLoadError(null);
      })
      .catch((e) => setLoadError((e as ApiError).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // ── ADD A SITE ──
  //
  // A company is created with a head office, which trades nothing. Until it
  // has a STATION or a DEPOT it has no pumps, no shifts and no takings -- the
  // company exists and can do nothing. This was the missing step.
  const [siteFor, setSiteFor] = useState<CompanyRow | null>(null);
  const [siteForm, setSiteForm] = useState({
    code: '', name: '', kind: 'STATION', address: '', dayStartsAt: '06:00', revenueTarget: '',
  });
  const [savingSite, setSavingSite] = useState(false);

  const saveSite = async () => {
      clearProblem('p0');
    if (!siteFor) return;
    if (!siteForm.code.trim() || !siteForm.name.trim()) {
      flagProblem('p0', 'A site needs a code and a name'); return;
    }
    setSavingSite(true);
    try {
      await api.post<{ siteId: string }>('/api/v1/organisation/sites', {
        companyId: siteFor.id,
        code: siteForm.code.trim().toUpperCase(),
        name: siteForm.name.trim(),
        kind: siteForm.kind,
        address: siteForm.address.trim() || null,
        // The company's own zone, not the browser's: which day a shift belongs
        // to is decided where the fuel is sold.
        timezone: 'Africa/Kampala',
        // When the trading day starts. A station running a night shift needs
        // this, or the night's takings land on the wrong date.
        dayStartsAt: `${siteForm.dayStartsAt}:00`,
        revenueTarget: siteForm.revenueTarget ? Number(siteForm.revenueTarget) : null,
      }, { idempotencyKey: `site-${siteFor.id}-${siteForm.code.trim().toUpperCase()}` });
      setSiteFor(null);
      setSiteForm({ code: '', name: '', kind: 'STATION', address: '', dayStartsAt: '06:00', revenueTarget: '' });
      await load();
      showToast(`${siteForm.name.trim()} added — it needs two managers before it can approve its own shifts`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setSavingSite(false);
    }
  };

  const save = useCallback(async () => {
      clearProblem('p1');
    if (!form.name.trim()) {
      flagProblem('p1', 'A company needs a name'); return;
    }
    if (!form.headOfficeEmployeeNo.trim() || !form.headOfficeManagerName.trim()) {
      flagProblem('p1', 'Name the person who will run this company — nobody can be added to it afterwards'); return;
    }
    if (!form.headOfficeName.trim()) {
      showToast(
        'A company is created with its head office — without one there is nobody who may appoint its managers',
        'error',
      );
      return;
    }

    setSaving(true);
    try {
      await api.post<CompanyRow>('/api/v1/organisation/companies', {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        registrationNo: form.registrationNo.trim() || null,
        taxId: form.taxId.trim() || null,
        countryCode: form.countryCode,
        baseCurrency: form.baseCurrency,
        timezone: form.timezone,
        headOfficeName: form.headOfficeName.trim(),
        headOfficeEmployeeNo: form.headOfficeEmployeeNo.trim().toUpperCase(),
        headOfficeManagerName: form.headOfficeManagerName.trim(),
        headOfficePhone: form.headOfficePhone.trim() || null,
        headOfficeAddress: form.headOfficeAddress.trim() || null,
      }, { idempotencyKey: `company-${form.name.trim().toLowerCase()}-${form.headOfficeEmployeeNo.trim().toUpperCase()}` });

      showToast(`${form.name.trim()} created`, 'success');
      setShowModal(false);
      setForm(EMPTY);
      load();
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setSaving(false);
    }
  }, [form, showToast, load, clearProblem, flagProblem]);

  /** Picking a country fills in what follows from it, still editable. */
  const pickCountry = (code: string) => {
    const c = COUNTRIES.find((x) => x.code === code);
    setForm((f) => ({
      ...f,
      countryCode: code,
      baseCurrency: c?.currency ?? f.baseCurrency,
      timezone: c?.tz ?? f.timezone,
    }));
  };

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
          Could not load companies
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          {loadError}
        </p>
        <p className="text-xs mt-3" style={{ color: 'var(--muted-foreground)' }}>
          This screen is for system administrators. A 403 here means the account
          you are signed in as runs a company rather than the platform.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Every dealer on the platform. Each owns its sites and its books.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          + New company
        </button>
      </div>

      {companies.length === 0 ? (
        <div
          className="rounded-xl px-6 py-12 text-center"
          style={{ border: '1px dashed var(--border)' }}
        >
          <p className="text-sm font-semibold">No companies yet</p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Create one, and it comes with the head office that will appoint its
            managers.
          </p>
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
          {companies.map((c) => (
            <div
              key={c.id}
              className="rounded-xl p-5"
              style={{
                background: 'linear-gradient(160deg, var(--card-top,#0F1C2E), var(--card-bottom,#0A1220))',
                border: '1px solid var(--border)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{c.name}</p>
                  {c.legalName && (
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {c.legalName}
                    </p>
                  )}
                </div>
                <StatusBadge status={c.isActive ? 'active' : 'idle'} size="sm" />
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div>
                  <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
                    Sites
                  </p>
                  <p className="text-lg font-bold mt-0.5">{fmt(c.siteCount)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
                    People
                  </p>
                  <p className="text-lg font-bold mt-0.5">{fmt(c.staffCount)}</p>
                </div>
              </div>

              <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                {c.headOfficeName ? (
                  <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    Head office: <span style={{ color: 'var(--foreground)' }}>{c.headOfficeName}</span>
                  </p>
                ) : (
                  // Should be impossible -- a company is created with one. If
                  // it ever shows, something wrote to the database directly and
                  // that company cannot appoint anybody.
                  <p className="text-xs font-semibold" style={{ color: 'var(--destructive)' }}>
                    No head office. This company cannot appoint managers.
                  </p>
                )}
                <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {c.countryCode} · {c.baseCurrency}
                  {c.registrationNo ? ` · ${c.registrationNo}` : ''}
                </p>
                {c.siteCount === 0 && (
                  <p className="text-xs mt-2 font-semibold" style={{ color: '#F59E0B' }}>
                    No trading site yet — this company cannot sell anything.
                  </p>
                )}
                <button
                  onClick={() => setSiteFor(c)}
                  className="mt-3 w-full py-2 rounded-lg text-xs font-semibold"
                  style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                >
                  Add a station or depot
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={siteFor !== null}
        onClose={() => setSiteFor(null)}
        title="Add a site"
        subtitle={siteFor ? `A station or depot for ${siteFor.name}. The head office trades nothing itself.` : ''}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setSiteFor(null)}>
              Cancel
            </button>
            <FormProblem msg={problems.p0} />
            <button className="btn-primary" onClick={saveSite} disabled={savingSite}>
              {savingSite ? 'Adding…' : 'Add site'}
            </button>
          </div>
        }
      >
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Code</span>
            <input className="input-field w-full" placeholder="KIB02" value={siteForm.code}
                   onChange={(e) => setSiteForm((f) => ({ ...f, code: e.target.value }))} />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Kind</span>
            <select className="input-field w-full" value={siteForm.kind}
                    onChange={(e) => setSiteForm((f) => ({ ...f, kind: e.target.value }))}>
              <option value="STATION">Station — pumps and nozzles</option>
              <option value="DEPOT">Depot — bulk loads out</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Name</span>
            <input className="input-field w-full" placeholder="Kiboga Road Service Station" value={siteForm.name}
                   onChange={(e) => setSiteForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Address</span>
            <input className="input-field w-full" value={siteForm.address}
                   onChange={(e) => setSiteForm((f) => ({ ...f, address: e.target.value }))} />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Trading day starts</span>
            <input type="time" className="input-field w-full" value={siteForm.dayStartsAt}
                   onChange={(e) => setSiteForm((f) => ({ ...f, dayStartsAt: e.target.value }))} />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Monthly revenue target</span>
            <input type="number" min={0} className="input-field w-full" value={siteForm.revenueTarget}
                   onChange={(e) => setSiteForm((f) => ({ ...f, revenueTarget: e.target.value }))} />
          </label>
        </div>
      </Modal>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="New company"
        subtitle="Created together with its head office — a company without one has nobody who may appoint its managers."
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setShowModal(false)}>
              Cancel
            </button>
            <FormProblem msg={problems.p1} />
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Creating…' : 'Create company'}
            </button>
          </div>
        }
      >
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Trading name</span>
            <input
              className="input-field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Astro Investments"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Registered name</span>
            <input
              className="input-field"
              value={form.legalName}
              onChange={(e) => setForm({ ...form, legalName: e.target.value })}
              placeholder="Astro Investments Limited"
            />
            <span className="block text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
              What appears on a statement an auditor reads.
            </span>
          </label>

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Registration number</span>
            <input
              className="input-field"
              value={form.registrationNo}
              onChange={(e) => setForm({ ...form, registrationNo: e.target.value })}
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Tax identification</span>
            <input
              className="input-field"
              value={form.taxId}
              onChange={(e) => setForm({ ...form, taxId: e.target.value })}
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Country</span>
            <select
              className="input-field"
              value={form.countryCode}
              onChange={(e) => pickCountry(e.target.value)}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="block text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
              Sets the currency and time zone; both stay editable.
            </span>
          </label>

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Currency</span>
            <input
              className="input-field"
              value={form.baseCurrency}
              onChange={(e) => setForm({ ...form, baseCurrency: e.target.value.toUpperCase() })}
              maxLength={3}
            />
          </label>
        </div>

        <div
          className="mt-5 pt-5"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <p className="text-sm font-semibold">Head office</p>
          <p className="text-xs mt-1 mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Not a trading site: no tanks, no pumps, no shifts. It exists so that
            &ldquo;who runs this company&rdquo; is a row rather than a convention.
          </p>

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
            <label className="block">
              <span className="block text-sm font-medium mb-1.5">Name</span>
              <input
                className="input-field"
                value={form.headOfficeName}
                onChange={(e) => setForm({ ...form, headOfficeName: e.target.value })}
                placeholder="Astro Head Office"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium mb-1.5">Who runs it</span>
              <input
                className="input-field"
                value={form.headOfficeManagerName}
                onChange={(e) => setForm({ ...form, headOfficeManagerName: e.target.value })}
                placeholder="Full name"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium mb-1.5">Their sign-in</span>
              <input
                className="input-field"
                value={form.headOfficeEmployeeNo}
                onChange={(e) => setForm({ ...form, headOfficeEmployeeNo: e.target.value })}
                placeholder="HO01"
              />
              <span className="block text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                An employee number, not an email. Their password is set separately.
              </span>
            </label>

            <label className="block">
              <span className="block text-sm font-medium mb-1.5">Their phone</span>
              <input
                className="input-field"
                value={form.headOfficePhone}
                onChange={(e) => setForm({ ...form, headOfficePhone: e.target.value })}
                placeholder="+256700000000"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium mb-1.5">Address</span>
              <input
                className="input-field"
                value={form.headOfficeAddress}
                onChange={(e) => setForm({ ...form, headOfficeAddress: e.target.value })}
                placeholder="Plot 12, Kampala Road"
              />
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
