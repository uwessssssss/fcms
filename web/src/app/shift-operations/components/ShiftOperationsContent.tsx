'use client';

import { businessToday } from '@/lib/dates';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { Checker, blank, errorCount, fieldStyle, hasErrors } from '@/lib/checks';
import type { Issue } from '@/lib/checks';
import { FieldIssues, IssueSummary } from '@/components/ui/Issues';
import React, { useCallback, useEffect, useState, useMemo } from 'react';

import { useToast } from '@/components/ui/Toast';
import CashDropsPanel from '@/components/CashDropsPanel';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { isCompanyWide } from '@/lib/roles';
import type {
  AssignmentView,
  CreditSaleView,
  CustomerView,
  DryItemView,
  DrySaleView,
  EquipmentRow,
  ExceptionView,
  RosterTemplateView,
  ShiftDetail,
  ShiftSummary,
  StaffRow,
  TankInventoryRow,
  TankView,
} from '@/types/api';

/**
 * The shift, from opening it to approving it.
 *
 * This was the hole under everything else. The close screen could CLOSE a
 * shift but nothing could open one, and nothing recorded what happens while it
 * is running -- so the close had to reconcile against readings no screen could
 * capture. Every figure downstream rests on this.
 *
 * What lives here, and why each belongs to the shift rather than a report:
 *
 *   OPENING      dips on every tank and a roster of who holds which nozzle.
 *                The opening totalizer is read off the pump head, not carried
 *                forward blindly -- if it disagrees with last night's close,
 *                somebody moved the meter.
 *   DIPS         a stick reading taken during the shift, in litres.
 *   PUMP TESTS   the can test. Litres through the meter that were not sold,
 *                so they must be recorded or the attendant is charged for them.
 *   OWN USE      fuel taken for the generator or the company vehicle. Same
 *                reason.
 *   HANDOVER     one attendant takes over a nozzle from another mid-shift.
 *                It closes the first person's meter reading and opens the
 *                second's, which is what makes a shortage belong to a person.
 *   EXCEPTIONS   what the close flagged for a human. They do not clear
 *                themselves.
 *   APPROVAL     a second manager signs off a closed shift. The database
 *                refuses the closer, a supervisor, and a manager from another
 *                site -- this screen only offers it.
 */
export default function ShiftOperationsContent() {
  const [partial, setPartial] = useState<string[]>([]);
  const { showToast } = useToast();

  const [shift, setShift] = useState<ShiftSummary | null>(null);
  const [detail, setDetail] = useState<ShiftDetail | null>(null);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionView[]>([]);
  const [closed, setClosed] = useState<ShiftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- opening ----
  const { user } = useAuth();
  const companyWide = isCompanyWide(user?.role);
  const [label, setLabel] = useState('DAY');
  const [openDips, setOpenDips] = useState<Record<string, string>>({});
  const [openTried, setOpenTried] = useState(false);
  // Capacity, safe fill, dead stock and the book figure for each tank -- the
  // equipment list the form is built from carries none of them.
  const [tankInfo, setTankInfo] = useState<Record<string, TankInventoryRow>>({});
  useEffect(() => {
    api.get<TankInventoryRow[]>('/api/v1/inventory/tanks')
      .then((rows) => setTankInfo(Object.fromEntries(rows.map((r) => [r.id, r]))))
      .catch(() => undefined);
  }, []);
  const [roster, setRoster] = useState<Record<string, { attendantId: string; totalizer: string; elec?: string }>>({});
  // Saved rosters: the usual nozzle-to-attendant pattern, applied in one go
  // instead of eight selections at six in the morning. Applying one fills the
  // attendants only -- the opening totalizers are still read off each pump.
  const [templates, setTemplates] = useState<RosterTemplateView[]>([]);
  const [templateName, setTemplateName] = useState('');
  useEffect(() => {
    void api.get<RosterTemplateView[]>('/api/rosters').then(setTemplates).catch(() => undefined);
  }, []);

  // ---- during the shift ----
  const [dip, setDip] = useState({ tankId: '', litres: '', water: '' });
  const [test, setTest] = useState({ nozzleId: '', can: '20', measured: '', returned: true });
  const [ownUse, setOwnUse] = useState({ tankId: '', litres: '', purpose: '' });
  const [hand, setHand] = useState({ assignmentId: '', incoming: '', totalizer: '', elec: '', reason: '', rollover: false });

  // ---- sales that are not cash at the pump ----
  //
  // CREDIT and DISCOUNTS are settlement types in the attendant's cash-up. If
  // an attendant fills a customer's truck on account and nothing records it
  // here, the close counts that fuel as unpaid -- and raises a SHORTAGE
  // against an attendant who did nothing wrong. The same for a discount. So
  // these are recorded during the shift, as they happen, against the person
  // who held the nozzle.
  const [customers, setCustomers] = useState<CustomerView[]>([]);
  const [items, setItems] = useState<DryItemView[]>([]);
  const [creditSales, setCreditSales] = useState<CreditSaleView[]>([]);
  const [tillSales, setTillSales] = useState<DrySaleView[]>([]);
  const [credit, setCredit] = useState({ customerId: '', assignmentId: '', litres: '', voucher: '', plate: '' });
  const [disc, setDisc] = useState({ attendantId: '', amount: '', reason: '' });
  const [till, setTill] = useState({ sellerId: '', itemId: '', qty: '1', receipt: '' });

  const attendants = staff.filter((s) => s.role.toUpperCase() === 'ATTENDANT' && s.isActive);
  const nozzles = equipment.filter((e) => e.kind === 'NOZZLE' && e.isActive);
  const tanks = equipment.filter((e) => e.kind === 'TANK' && e.isActive);

  const load = useCallback(async () => {
    try {
      const [eq, st, shifts] = await Promise.all([
        api.get<EquipmentRow[]>('/api/admin/equipment'),
        api.get<StaffRow[]>('/api/admin/staff'),
        api.get<ShiftSummary[]>('/api/shifts?days=7'),
      ]);
      setEquipment(eq);
      setStaff(st);
      setClosed(shifts.filter((s) => s.state === 'DECLARED' && !s.closedReason?.startsWith('__')));

      const current = await api.get<ShiftSummary | undefined>('/api/shifts/current');
      setShift(current ?? null);
      if (current) {
        const [d, ex] = await Promise.all([
          api.get<ShiftDetail>(`/api/shifts/${current.id}`),
          api.get<ExceptionView[]>(`/api/forecourt/exceptions?shiftId=${current.id}&openOnly=true`),
        ]);
        setDetail(d);
        setExceptions(ex);
        const [cs, it, csales, tsales] = await Promise.all([
          api.get<CustomerView[]>('/api/credit/customers').catch(() => { setPartial((x) => (x.includes('credit customers') ? x : [...x, 'credit customers'])); return [] as CustomerView[]; }),
          api.get<DryItemView[]>('/api/dry-stock/items').catch(() => { setPartial((x) => (x.includes('shop items') ? x : [...x, 'shop items'])); return [] as DryItemView[]; }),
          api.get<CreditSaleView[]>(`/api/credit/shifts/${current.id}/sales`).catch(() => { setPartial((x) => (x.includes("this shift's credit sales") ? x : [...x, "this shift's credit sales"])); return [] as CreditSaleView[]; }),
          api.get<DrySaleView[]>(`/api/dry-stock/shifts/${current.id}/sales`).catch(() => { setPartial((x) => (x.includes("this shift's shop sales") ? x : [...x, "this shift's shop sales"])); return [] as DrySaleView[]; }),
        ]);
        setCustomers(cs);
        setItems(it.filter((x) => !x.isCylinder));
        setCreditSales(csales);
        setTillSales(tsales);
      } else {
        setDetail(null);
        setExceptions([]);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      showToast(what, 'success');
    } catch (e) {
      // The server's refusal, in its own words: it names the nozzle, the tank
      // or the person, which is what the supervisor needs to act on.
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // BLANK MEANS MISSING; 0 MEANS 0. Number('') is 0, so a blank box went out
  // as a real zero -- and the dip filter below kept only values ABOVE zero,
  // which dropped a blank tank silently AND made a genuinely empty tank
  // impossible to record.
  const given = (v: string | undefined) => v !== undefined && v.trim() !== '' && Number.isFinite(Number(v));

  // What is missing or does not add up on the opening form, field by field.
  const openIssues = useMemo(() => {
    const c = new Checker();
    for (const t of tanks) {
      const f = `dip:${t.id}`, info = tankInfo[t.id];
      const v = c.number(f, openDips[t.id], `${t.code}: the opening dip (0 if empty)`, { min: 0 });
      if (v === null || !info) continue;
      if (v > info.capacityLitres) { c.error(f, `${t.code}: ${v.toLocaleString()} L is more than the tank holds (${info.capacityLitres.toLocaleString()} L)`); continue; }
      if (v > info.safeFill) c.warn(f, `${t.code}: above its safe fill of ${info.safeFill.toLocaleString()} L`);
      if (v > 0 && v < info.deadStock) c.warn(f, `${t.code}: below dead stock (${info.deadStock.toLocaleString()} L) - the pumps may draw water or air`);
      const diff = v - info.currentLitres;
      if (Math.abs(diff) > Math.max(50, info.capacityLitres * 0.005)) {
        c.warn(f, `${t.code}: ${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()} L against the book (${Math.round(info.currentLitres).toLocaleString()} L) - re-dip; if it is real it will need explaining`);
      }
    }
    const held = nozzles.filter((n) => roster[n.id]?.attendantId);
    if (nozzles.length > 0 && held.length === 0) c.error('roster', 'Put at least one attendant on a nozzle');
    for (const n of nozzles) {
      const r = roster[n.id], f = `roster:${n.id}`, name = `${n.parentCode ? n.parentCode + ' ' : ''}${n.code}`;
      if (r?.attendantId) c.number(f, r.totalizer, `${name}: the opening meter reading`, { min: 0 });
      else if (r && !blank(r.totalizer)) c.warn(f, `${name}: a reading but nobody holds it - it will not be opened`);
    }
    return c.issues;
  }, [tanks, nozzles, openDips, roster, tankInfo]);


  // ---- what is missing or does not add up, form by form ----
  const [tried, setTried] = useState<Record<string, boolean>>({});
  const tryForm = (k: string) => setTried((t) => ({ ...t, [k]: true }));
  const shiftIssues = useMemo(() => {
    const out: Record<string, Issue[]> = {};
    const active = detail?.assignments.filter((a) => a.state === 'ACTIVE') ?? [];
    { // spot dip
      const c = new Checker(); const info = tankInfo[dip.tankId];
      c.required('tank', dip.tankId, 'The tank');
      const v = c.number('litres', dip.litres, 'The litres dipped (0 if empty)', { min: 0 });
      if (v !== null && info) {
        if (v > info.capacityLitres) c.error('litres', `${v.toLocaleString()} L is more than ${info.code} holds (${info.capacityLitres.toLocaleString()} L)`);
        else {
          if (v > info.safeFill) c.warn('litres', `Above ${info.code}'s safe fill of ${info.safeFill.toLocaleString()} L`);
          const diff = v - info.currentLitres;
          if (Math.abs(diff) > Math.max(50, info.capacityLitres * 0.005))
            c.warn('litres', `${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()} L against the book (${Math.round(info.currentLitres).toLocaleString()} L) - re-dip before relying on it`);
        }
      }
      out.dip = c.issues;
    }
    { // pump test
      const c = new Checker();
      c.required('nozzle', test.nozzleId, 'The nozzle');
      const m = c.number('meter', test.measured, 'What the meter showed', { positive: true });
      const k = c.number('can', test.can, 'What is in the can', { positive: true });
      if (m !== null && k !== null && Math.abs(m - k) / k > 0.1)
        c.warn('meter', `Meter ${m} L against ${k} L in the can - more than 10% apart, which looks like a typo`);
      out.test = c.issues;
    }
    { // own use
      const c = new Checker(); const info = tankInfo[ownUse.tankId];
      c.required('tank', ownUse.tankId, 'The tank');
      const v = c.number('litres', ownUse.litres, 'The litres drawn', { positive: true });
      if (!ownUse.purpose.trim() || ownUse.purpose.trim().length < 3) c.error('purpose', 'What the fuel was for is needed');
      if (v !== null && info && v > info.currentLitres) c.warn('litres', `More than the book says is in ${info.code} (${Math.round(info.currentLitres).toLocaleString()} L)`);
      out.own = c.issues;
    }
    { // handover
      const c = new Checker(); const a = active.find((x) => x.id === hand.assignmentId);
      c.required('nozzle', hand.assignmentId, 'The nozzle being handed over');
      if (c.required('incoming', hand.incoming, 'Who takes over') && a && hand.incoming === a.attendantId)
        c.error('incoming', `${a.attendantName} already holds this nozzle`);
      const v = c.number('reading', hand.totalizer, 'The manual meter reading at handover', { min: 0 });
      // (730) Both meters, and their litres within 1 L of each other.
      const e = c.number('elec', hand.elec, 'The electronic meter reading at handover', { min: 0 });
      if (v !== null && e !== null && a?.openingTotalizer != null && a.openingElectronic != null && !hand.rollover) {
        const apart = (e - a.openingElectronic) - (v - a.openingTotalizer);
        if (Math.abs(apart) > 1 && hand.reason.trim().length < 5)
          c.error('elec', `The electronic meter shows ${(e - a.openingElectronic).toLocaleString()} L and the manual ${(v - a.openingTotalizer).toLocaleString()} L - ${apart > 0 ? '+' : ''}${apart.toFixed(2)} L apart, more than 1 L. Check both, or say why below.`);
      }
      if (v !== null && a?.openingTotalizer != null) {
        if (v < a.openingTotalizer && !hand.rollover)
          c.error('reading', `${v.toLocaleString()} is below this nozzle's opening reading of ${a.openingTotalizer.toLocaleString()} - check it, or tick that the meter rolled over`);
        if (v >= a.openingTotalizer && hand.rollover)
          c.warn('reading', 'Rollover is ticked, but the reading is above the opening - untick it unless the meter really went round');
      }
      out.hand = c.issues;
    }
    { // credit sale
      const c = new Checker(); const cust = customers.find((x) => x.id === credit.customerId);
      c.required('customer', credit.customerId, 'The customer');
      c.required('nozzle', credit.assignmentId, 'The nozzle and attendant');
      c.number('litres', credit.litres, 'The litres', { positive: true });
      if (cust && cust.headroom <= 0) c.warn('customer', `${cust.name} has no credit left - this will be flagged`);
      out.credit = c.issues;
    }
    { // discount
      const c = new Checker();
      c.required('attendant', disc.attendantId, 'The attendant');
      c.number('amount', disc.amount, 'The amount', { positive: true });
      if (disc.reason.trim().length < 5) c.error('reason', 'A real reason is needed - a discount with no reason is a gift nobody authorised');
      out.disc = c.issues;
    }
    { // shop sale
      const c = new Checker(); const item = items.find((x) => x.itemId === till.itemId);
      c.required('seller', till.sellerId, 'Who sold it');
      c.required('item', till.itemId, 'The item');
      const q = c.number('qty', till.qty, 'How many', { positive: true });
      if (q !== null && item && q > item.onHand) c.error('qty', `Only ${item.onHand} ${item.name} in stock - book the delivery first`);
      out.till = c.issues;
    }
    return out;
  }, [detail, tankInfo, dip, test, ownUse, hand, credit, disc, till, customers, items]);

  const openShift = () => {
    setOpenTried(true);
    if (hasErrors(openIssues)) {
      showToast(`Fix the ${errorCount(openIssues)} thing(s) marked in red before opening`, 'error');
      return;
    }
    return run('Shift opened', async () => {
      const undipped = tanks.filter((t) => !given(openDips[t.id]));
      if (undipped.length > 0) {
        throw new ApiError(422, 'DIP_MISSING',
          `Dip every tank before opening - ${undipped.map((t) => t.code).join(', ')} ${undipped.length === 1 ? 'has' : 'have'} none. ` +
          'An empty tank is dipped as 0.');
      }
      const dips = tanks.map((t) => ({ tankId: t.id, productLitres: Number(openDips[t.id]), waterLitres: null }));
      const lines = Object.entries(roster)
        .filter(([, r]) => r.attendantId)
        .map(([nozzleId, r]) => ({
          nozzleId,
          attendantId: r.attendantId,
          volumeTotalizer: r.totalizer ? Number(r.totalizer) : null,
          // (730) blank: carried from the nozzle's last close, as the manual one is
          electronicTotalizer: r.elec ? Number(r.elec) : null,
          photoUrl: null,
        }));
      // (status, code, message) -- the client's own order.
      if (dips.length === 0) {
        throw new ApiError(422, 'NO_DIPS',
          'Dip every tank before opening. The close measures against these, so a missing one cannot be recovered later.');
      }
      if (lines.length === 0) {
        throw new ApiError(422, 'NO_ROSTER', 'Put at least one attendant on a nozzle.');
      }
      await api.post<{ shiftId: string }>('/api/shifts/open', {
        label,
        openingDips: dips,
        roster: lines,
        businessDate: null,
      }, { idempotencyKey: `open-${label}-${businessToday()}` });
    });
  };

  const fmt = (n: number) => n.toLocaleString();

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
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>Could not load</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{loadError}</p>
      </div>
    );
  }

  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Shift operations</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          {shift
            ? `${shift.label} shift open since ${new Date(shift.openedAt).toLocaleTimeString()}, opened by ${shift.openedByName}`
            : companyWide ? 'Head office' : 'No shift is open. Everything below waits on one.'}
        </p>
      </div>

      {/* Head office runs no shifts: it has no tanks or pumps (240). The form
          below only ever said "this site has no tanks". */}
      {!shift && companyWide && (
        <div className="rounded-xl border p-4 space-y-1" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Shifts run at the stations</h2>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            A station&apos;s supervisor opens and closes its shifts. Head office sees them on Site Operations
            and Shift Reports, and approves the ones waiting below.
          </p>
        </div>
      )}

      {/* ── OPEN A SHIFT ── */}
      {!shift && !companyWide && (
        <div className="rounded-xl border p-4 space-y-4" style={card}>
          <h2 className="text-sm font-semibold text-foreground">Open a shift</h2>

          <label className="block text-xs max-w-xs">
            <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>Which shift</span>
            <select className="input-field w-full" value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="DAY">Day</option>
              <option value="MID">Mid</option>
              <option value="NIGHT">Night</option>
            </select>
          </label>

          <div>
            <p className="text-xs font-semibold mb-2 text-foreground">Opening dips, in litres</p>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              {tanks.map((t) => (
                <div key={t.id} className="text-xs">
                  <label className="flex items-center justify-between gap-2">
                    <span>{t.code}{t.detail ? ` · ${t.detail}` : ''}</span>
                    <input
                      type="number" min={0} className="input-field w-28 text-right"
                      style={fieldStyle(openIssues, `dip:${t.id}`, openTried)}
                      value={openDips[t.id] ?? ''}
                      onChange={(e) => setOpenDips((p) => ({ ...p, [t.id]: e.target.value }))}
                    />
                  </label>
                  <FieldIssues issues={openIssues} field={`dip:${t.id}`} tried={openTried} />
                </div>
              ))}
              {tanks.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  This site has no tanks set up yet.
                </p>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold mb-2 text-foreground">Who holds which nozzle</p>
            <p className="text-xs mb-2" style={{ color: 'var(--muted-foreground)' }}>
              The opening totalizer is what the pump head reads NOW. If it differs from
              last night&apos;s close, say so rather than carrying the old figure forward.
            </p>
            <div className="space-y-2">
              {nozzles.map((n) => (
                <div key={n.id} className="grid gap-2" style={{ gridTemplateColumns: '1fr 1.4fr 1fr 1fr' }}>
                  <span className="text-xs self-center">
                    {n.parentCode ? `${n.parentCode} · ` : ''}{n.code}
                  </span>
                  <select
                    className="input-field text-xs"
                    value={roster[n.id]?.attendantId ?? ''}
                    onChange={(e) =>
                      setRoster((p) => ({ ...p, [n.id]: { totalizer: p[n.id]?.totalizer ?? '', attendantId: e.target.value } }))}
                  >
                    <option value="">Nobody</option>
                    {attendants.map((a) => (
                      <option key={a.id} value={a.id}>{a.fullName} ({a.employeeNo})</option>
                    ))}
                  </select>
                  <input
                    type="number" min={0} placeholder="Manual" aria-label="Manual meter" className="input-field text-xs text-right"
                    style={fieldStyle(openIssues, `roster:${n.id}`, openTried)}
                    value={roster[n.id]?.totalizer ?? ''}
                    onChange={(e) =>
                      setRoster((p) => ({ ...p, [n.id]: { ...p[n.id], attendantId: p[n.id]?.attendantId ?? '', totalizer: e.target.value } }))}
                  />
                  <input
                    type="number" min={0} placeholder="Electronic" aria-label="Electronic meter" className="input-field text-xs text-right"
                    title="Blank carries the electronic reading from this nozzle's last close. Its first ever opening must be read."
                    value={roster[n.id]?.elec ?? ''}
                    onChange={(e) =>
                      setRoster((p) => ({ ...p, [n.id]: { ...p[n.id], attendantId: p[n.id]?.attendantId ?? '', totalizer: p[n.id]?.totalizer ?? '', elec: e.target.value } }))}
                  />
                  <div style={{ gridColumn: '1 / -1' }}><FieldIssues issues={openIssues} field={`roster:${n.id}`} tried={openTried} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            {templates.length > 0 && (
              <select className="input-field text-xs" defaultValue=""
                      onChange={(e) => {
                        const t = templates.find((x) => x.id === e.target.value);
                        if (!t) return;
                        setRoster((p) => {
                          const next = { ...p };
                          for (const l of t.lines) next[l.nozzleId] = { totalizer: p[l.nozzleId]?.totalizer ?? '', attendantId: l.attendantId };
                          return next;
                        });
                        showToast(`${t.name} applied - now read each opening totalizer`, 'success');
                      }}>
                <option value="">Use a saved roster...</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.label ? ` (${t.label})` : ''}</option>)}
              </select>
            )}
            <input placeholder="Save this roster as..." className="input-field text-xs" value={templateName}
                   onChange={(e) => setTemplateName(e.target.value)} />
            <button disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                    style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                    onClick={async () => {
                      const lines = Object.entries(roster).filter(([, v]) => v.attendantId).map(([nozzleId, v]) => ({ nozzleId, attendantId: v.attendantId }));
                      if (!templateName.trim() || lines.length === 0) { showToast('Name it, and put at least one attendant on a nozzle', 'error'); return; }
                      try {
                        await api.post<unknown>('/api/rosters', { name: templateName.trim(), label, lines },
                          { idempotencyKey: `roster-${templateName.trim().toLowerCase()}` });
                        setTemplates(await api.get<RosterTemplateView[]>('/api/rosters'));
                        setTemplateName('');
                        showToast('Roster saved', 'success');
                      } catch (e) {
                        showToast((e as ApiError).message, 'error');
                      }
                    }}>
              Save roster
            </button>
          </div>
          <FieldIssues issues={openIssues} field="roster" tried={openTried} />
          <IssueSummary issues={openIssues} tried={openTried} />
          <button
            onClick={openShift} disabled={busy}
            className="w-full py-2 rounded-xl text-sm font-semibold"
            style={{ background: 'var(--primary)', color: 'var(--primary-foreground)', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Opening...' : 'Open the shift'}
          </button>
        </div>
      )}

      {/* ── DURING THE SHIFT ── */}
      {shift && detail && (
        <>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Record a dip</h2>
              <select className="input-field w-full text-xs" value={dip.tankId}
                      onChange={(e) => setDip({ ...dip, tankId: e.target.value })}>
                <option value="">Tank...</option>
                {detail.tanks.map((t: TankView) => (
                  <option key={t.tankId} value={t.tankId}>{t.code} · {t.productCode}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min={0} placeholder="Product litres" className="input-field text-xs"
                       value={dip.litres} onChange={(e) => setDip({ ...dip, litres: e.target.value })} />
                <input type="number" min={0} placeholder="Water litres" className="input-field text-xs"
                       value={dip.water} onChange={(e) => setDip({ ...dip, water: e.target.value })} />
              </div>
              <IssueSummary issues={shiftIssues.dip} tried={!!tried.dip} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  tryForm('dip');
                  if (hasErrors(shiftIssues.dip)) return;
                  void run('Dip recorded', () =>
                  api.post<unknown>('/api/forecourt/dips', {
                    tankId: dip.tankId,
                    context: 'SPOT',
                    productLitres: Number(dip.litres),
                    waterLitres: dip.water ? Number(dip.water) : null,
                    dipMm: null, waterDipMm: null, temperatureC: null, photoUrl: null,
                  }, { submission: `dip:${shift.id}` }));
                }}
              >
                Record dip
              </button>
            </div>

            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Pump test</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Litres through the meter that nobody bought. Unrecorded, the attendant pays for them.
              </p>
              <select className="input-field w-full text-xs" value={test.nozzleId}
                      onChange={(e) => setTest({ ...test, nozzleId: e.target.value })}>
                <option value="">Nozzle...</option>
                {detail.assignments.map((a: AssignmentView) => (
                  <option key={a.nozzleId} value={a.nozzleId}>{a.pumpCode} · {a.nozzleCode} · {a.productCode}</option>
                ))}
              </select>
              {/* Labelled by WHAT EACH NUMBER IS, not by procedure. These read "Can
                  size" and "Measured" -- and "measured" means opposite things in
                  the two ways a test is done: fill the can to its mark and read the
                  meter, or run the meter to 20.00 and read the can's neck. Entered
                  the second way, the pump's error was charged to the attendant AND
                  pushed into the tank's variance. The close deducts what the METER
                  counted; the can holds what really came out. */}
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Meter showed (L)
                  <input type="number" min={0} step="0.01" className="input-field w-full text-xs mt-1"
                         value={test.measured} onChange={(e) => setTest({ ...test, measured: e.target.value })} />
                </label>
                <label className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  In the can (L)
                  <input type="number" min={0} step="0.01" className="input-field w-full text-xs mt-1"
                         value={test.can} onChange={(e) => setTest({ ...test, can: e.target.value })} />
                </label>
              </div>
              {/* Shown, not judged: the tolerance is the company's policy, which this
                  screen does not read -- a hard-coded 0.5% here would contradict it. */}
              {Number(test.measured) > 0 && Number(test.can) > 0 && (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  The meter {Number(test.measured) >= Number(test.can) ? 'over' : 'under'}-reads by{' '}
                  {Math.abs((Number(test.measured) - Number(test.can)) * 1000).toFixed(0)} mL
                  ({(Math.abs(Number(test.measured) - Number(test.can)) / Number(test.can) * 100).toFixed(2)}%).
                </p>
              )}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={test.returned}
                       onChange={(e) => setTest({ ...test, returned: e.target.checked })} />
                <span>Poured back into the tank</span>
              </label>
              <IssueSummary issues={shiftIssues.test} tried={!!tried.test} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  tryForm('test');
                  if (hasErrors(shiftIssues.test)) return;
                  void run('Pump test recorded', () =>
                  api.post<unknown>(`/api/forecourt/shifts/${shift.id}/pump-tests`, {
                    nozzleId: test.nozzleId,
                    canSizeLitres: Number(test.can),
                    measuredLitres: Number(test.measured),
                    returnedToTank: test.returned,
                    witnessedBy: null, photoUrl: null,
                  }, { submission: `pump-test:${shift.id}` }));
                }}
              >
                Record test
              </button>
            </div>

            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Own use</h2>
              <select className="input-field w-full text-xs" value={ownUse.tankId}
                      onChange={(e) => setOwnUse({ ...ownUse, tankId: e.target.value })}>
                <option value="">Tank...</option>
                {detail.tanks.map((t: TankView) => (
                  <option key={t.tankId} value={t.tankId}>{t.code} · {t.productCode}</option>
                ))}
              </select>
              <input type="number" min={0} placeholder="Litres" className="input-field w-full text-xs"
                     value={ownUse.litres} onChange={(e) => setOwnUse({ ...ownUse, litres: e.target.value })} />
              <input placeholder="What for? e.g. standby generator" className="input-field w-full text-xs"
                     value={ownUse.purpose} onChange={(e) => setOwnUse({ ...ownUse, purpose: e.target.value })} />
              <IssueSummary issues={shiftIssues.own} tried={!!tried.own} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  tryForm('own');
                  if (hasErrors(shiftIssues.own)) return;
                  void run('Own use recorded', () =>
                  api.post<unknown>(`/api/forecourt/shifts/${shift.id}/own-use`, {
                    tankId: ownUse.tankId, nozzleId: null,
                    litres: Number(ownUse.litres), purpose: ownUse.purpose, reference: null,
                  }, { submission: `own-use:${shift.id}` }));
                }}
              >
                Record own use
              </button>
            </div>

            {/* (580) Witnessed cash drops: nobody carries a shift's takings to close. */}
            <CashDropsPanel
              shiftId={shift.id}
              people={Array.from(new Map<string, { id: string; name: string }>([
                ...detail.assignments.map((x) => [x.attendantId, { id: x.attendantId, name: x.attendantName }] as [string, { id: string; name: string }]),
                ...tillSales.map((x) => [x.sellerId, { id: x.sellerId, name: x.sellerName }] as [string, { id: string; name: string }]),
              ]).values())}
            />

            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Handover</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Closes one attendant&apos;s reading and opens the next one&apos;s, so a
                shortage belongs to whoever held the nozzle.
              </p>
              <select className="input-field w-full text-xs" value={hand.assignmentId}
                      onChange={(e) => setHand({ ...hand, assignmentId: e.target.value })}>
                <option value="">Who is handing over...</option>
                {detail.assignments.filter((a) => a.state === 'ACTIVE').map((a) => (
                  <option key={a.id} value={a.id}>{a.attendantName} · {a.pumpCode}/{a.nozzleCode}</option>
                ))}
              </select>
              <select className="input-field w-full text-xs" value={hand.incoming}
                      onChange={(e) => setHand({ ...hand, incoming: e.target.value })}>
                <option value="">Taking over...</option>
                {attendants.map((a) => (
                  <option key={a.id} value={a.id}>{a.fullName} ({a.employeeNo})</option>
                ))}
              </select>
              <input type="number" min={0} placeholder="Manual meter at handover" className="input-field w-full text-xs"
                     value={hand.totalizer} onChange={(e) => setHand({ ...hand, totalizer: e.target.value })} />
              <input type="number" min={0} placeholder="Electronic meter at handover" className="input-field w-full text-xs"
                     aria-label="Electronic meter at handover"
                     value={hand.elec} onChange={(e) => setHand({ ...hand, elec: e.target.value })} />
              <input className="input-field w-full text-xs" aria-label="Why the two meters differ"
                     placeholder="Only if the meters differ by more than 1 L: why"
                     value={hand.reason} onChange={(e) => setHand({ ...hand, reason: e.target.value })} />
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <input type="checkbox" checked={hand.rollover} onChange={(e) => setHand({ ...hand, rollover: e.target.checked })} />
                The meter rolled over past its maximum since this nozzle opened
              </label>
              <IssueSummary issues={shiftIssues.hand} tried={!!tried.hand} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  // The outgoing attendant is billed on THIS reading (410). A blank
                  // sent as 0 would sit below their opening and read as a rollover.
                  tryForm('hand');
                  if (hasErrors(shiftIssues.hand)) return;
                  void run('Handover recorded', () =>
                  api.post<unknown>('/api/forecourt/handover', {
                    assignmentId: hand.assignmentId,
                    incomingAttendantId: hand.incoming,
                    volumeTotalizer: Number(hand.totalizer),
                    electronicTotalizer: Number(hand.elec), photoUrl: null,
                    isRollover: hand.rollover,
                    differenceReason: hand.reason.trim() || null,
                  }, { idempotencyKey: `hand-${hand.assignmentId}-${hand.totalizer}` }));
                }}
              >
                Record handover
              </button>
            </div>
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Credit sale</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Fuel on account. Unrecorded, the attendant is short by exactly this amount at close.
              </p>
              <select className="input-field w-full text-xs" value={credit.customerId}
                      onChange={(e) => setCredit({ ...credit, customerId: e.target.value })}>
                <option value="">Customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} - headroom {Math.max(0, c.headroom).toLocaleString()}
                  </option>
                ))}
              </select>
              <select className="input-field w-full text-xs" value={credit.assignmentId}
                      onChange={(e) => setCredit({ ...credit, assignmentId: e.target.value })}>
                <option value="">Nozzle and attendant...</option>
                {detail.assignments.filter((a) => a.state === 'ACTIVE').map((a) => (
                  <option key={a.id} value={a.id}>{a.pumpCode}/{a.nozzleCode} · {a.productCode} · {a.attendantName}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min={0} placeholder="Litres" className="input-field text-xs"
                       value={credit.litres} onChange={(e) => setCredit({ ...credit, litres: e.target.value })} />
                <input placeholder="Voucher no." className="input-field text-xs"
                       value={credit.voucher} onChange={(e) => setCredit({ ...credit, voucher: e.target.value })} />
              </div>
              <IssueSummary issues={shiftIssues.credit} tried={!!tried.credit} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  const a = detail.assignments.find((x) => x.id === credit.assignmentId);
                  tryForm('credit');
                  if (hasErrors(shiftIssues.credit)) return;
                  if (!a) return;
                  void run('Credit sale recorded', () =>
                    api.post<unknown>(`/api/credit/shifts/${shift.id}/sales`, {
                      customerId: credit.customerId,
                      vehicleId: null,
                      attendantId: a.attendantId,
                      nozzleId: a.nozzleId,
                      // The server prices it -- the customer's agreed price if one
                      // is in force (600), else this shift's -- and flags it if it
                      // would take the customer over their limit.
                      litres: Number(credit.litres),
                      voucherNo: credit.voucher.trim() || null,
                      odometer: null, signedBy: null, evidenceUrl: null,
                    }, { submission: `credit-sale:${shift.id}` }));
                }}
              >
                Record credit sale
              </button>
              {creditSales.length > 0 && (
                <div className="pt-2 space-y-1 border-t" style={{ borderColor: 'var(--border)' }}>
                  {creditSales.slice(0, 5).map((c) => (
                    <p key={c.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span className="text-foreground">{c.customerName}</span> · {c.litres.toLocaleString()} L {c.productCode}
                      {' '}· UGX {c.amount.toLocaleString()} · {c.attendantName}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Discount</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Money given away with a reason, against the attendant who gave it.
              </p>
              <select className="input-field w-full text-xs" value={disc.attendantId}
                      onChange={(e) => setDisc({ ...disc, attendantId: e.target.value })}>
                <option value="">Attendant...</option>
                {Array.from(new Map(detail.assignments.map((a) => [a.attendantId, a])).values()).map((a) => (
                  <option key={a.attendantId} value={a.attendantId}>{a.attendantName}</option>
                ))}
              </select>
              <input type="number" min={0} placeholder="Amount" className="input-field w-full text-xs"
                     value={disc.amount} onChange={(e) => setDisc({ ...disc, amount: e.target.value })} />
              <input placeholder="Why? e.g. fleet agreement, loyalty" className="input-field w-full text-xs"
                     value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} />
              <IssueSummary issues={shiftIssues.disc} tried={!!tried.disc} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  tryForm('disc');
                  if (hasErrors(shiftIssues.disc)) return;
                  void run('Discount recorded', () =>
                    api.post<unknown>(`/api/ops/shifts/${shift.id}/discounts`, {
                      attendantId: disc.attendantId,
                      amount: Number(disc.amount),
                      litres: null,
                      reason: disc.reason.trim(),
                      customerRef: null,
                    }, { submission: `discount:${shift.id}` }));
                }}
              >
                Record discount
              </button>
            </div>

            <div className="rounded-xl border p-4 space-y-2" style={card}>
              <h2 className="text-sm font-semibold text-foreground">Shop sale</h2>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Lubricants and shop items. Priced by the server; the count follows the receipt.
              </p>
              <select className="input-field w-full text-xs" value={till.sellerId}
                      onChange={(e) => setTill({ ...till, sellerId: e.target.value })}>
                <option value="">Sold by...</option>
                {Array.from(new Map(detail.assignments.map((a) => [a.attendantId, a])).values()).map((a) => (
                  <option key={a.attendantId} value={a.attendantId}>{a.attendantName}</option>
                ))}
              </select>
              <select className="input-field w-full text-xs" value={till.itemId}
                      onChange={(e) => setTill({ ...till, itemId: e.target.value })}>
                <option value="">Item...</option>
                {items.map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.name}{i.unitPrice ? ` - UGX ${i.unitPrice.toLocaleString()}` : ''} ({i.onHand} in stock)
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min={1} placeholder="Qty" className="input-field text-xs"
                       value={till.qty} onChange={(e) => setTill({ ...till, qty: e.target.value })} />
                <input placeholder="Receipt no." className="input-field text-xs"
                       value={till.receipt} onChange={(e) => setTill({ ...till, receipt: e.target.value })} />
              </div>
              <IssueSummary issues={shiftIssues.till} tried={!!tried.till} />
              <button disabled={busy}
                className="w-full py-2 rounded-lg text-xs font-semibold"
                style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}
                onClick={() => {
                  tryForm('till');
                  if (hasErrors(shiftIssues.till)) return;
                  void run('Shop sale recorded', () =>
                    api.post<unknown>(`/api/dry-stock/shifts/${shift.id}/sales`, {
                      sellerId: till.sellerId,
                      receiptNo: till.receipt.trim() || null,
                      customerRef: null,
                      lines: [{ itemId: till.itemId, qty: Number(till.qty), exchangeInItemId: null }],
                    }, { submission: `shop-sale:${shift.id}` }));
                }}
              >
                Record shop sale
              </button>
              {tillSales.length > 0 && (
                <p className="text-xs pt-2 border-t" style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}>
                  {tillSales.length} sale(s) this shift · UGX {tillSales.reduce((t, x) => t + x.totalAmount, 0).toLocaleString()}
                </p>
              )}
            </div>
          </div>

          {/* ── EXCEPTIONS ── */}
          <div className="rounded-xl border p-4 space-y-2" style={card}>
            <h2 className="text-sm font-semibold text-foreground">
              Open exceptions {exceptions.length > 0 && `(${exceptions.length})`}
            </h2>
            {exceptions.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Nothing outstanding on this shift.
              </p>
            )}
            {exceptions.map((x) => (
              <div key={x.id} className="rounded-lg border p-3 space-y-2"
                   style={{ borderColor: x.level === 'CRITICAL' ? '#ef4444' : 'var(--border)' }}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">{x.code}</span>
                  <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {new Date(x.raisedAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{x.detail}</p>
                <input
                  className="input-field w-full text-xs"
                  placeholder="What was found, and what was done about it"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const resolution = (e.target as HTMLInputElement).value.trim();
                    if (resolution.length < 5) {
                      showToast('Say what was actually found — "ok" explains nothing later', 'error');
                      return;
                    }
                    void run('Exception resolved', () =>
                      api.post<unknown>(`/api/forecourt/exceptions/${x.id}/resolve`, { resolution }));
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── APPROVE A CLOSED SHIFT ── */}
      <div className="rounded-xl border p-4 space-y-2" style={card}>
        <h2 className="text-sm font-semibold text-foreground">Closed, waiting for approval</h2>
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          A second manager signs off. The database refuses the person who closed it,
          a supervisor, and a manager from another station — this screen only offers it.
        </p>
        {closed.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Nothing waiting.</p>
        )}
        {closed.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-lg border p-3"
               style={{ borderColor: 'var(--border)' }}>
            <div>
              <p className="text-xs font-semibold text-foreground">{s.businessDate} · {s.label}</p>
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                UGX {fmt(s.salesValue)} · {fmt(s.salesLitres)} L
                {s.openExceptions > 0 ? ` · ${s.openExceptions} exception(s) open` : ''}
              </p>
            </div>
            <button disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{ background: '#22c55e', color: '#fff' }}
              onClick={() => run('Shift approved', () =>
                api.post<unknown>(`/api/shifts/${s.id}/approve`, {}))}
            >
              Approve
            </button>
          </div>
        ))}
      </div>
      <PartialLoadNotice missing={partial} />
    </div>
  );
}
