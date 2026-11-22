'use client';
import { api, ApiError } from '@/lib/api';
import type {
  CashDropList,
  AssignmentView,
  ChannelRef,
  CloseResult,
  ClosureContext,
  DrySaleView,
  PendingPriceView,
  PreviewResult,
  ReturnToTankRow,
  ShiftDetail,
  ShiftSummary,
  TankView,
} from '@/types/api';
import { useSites } from '@/lib/useSites';
import { businessToday } from '@/lib/dates';
import { shiftLabelName } from '@/lib/shiftLabel';
import PartialLoadNotice from '@/components/ui/PartialLoadNotice';
import { Checker, errorCount, fieldStyle, hasErrors } from '@/lib/checks';
import { IssueSummary } from '@/components/ui/Issues';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Nozzle {
  id: string;
  nozzleNo: number;
  grade: string;
  gradeColor: string;
  tankId: string;
  openElec: number;
  closeElec: number;
  openManual: number;
  closeManual: number;
  /** Why the two meters differ by more than 1 L (730): sends the close to the manager flagged. */
  meterReason?: string;
  /** The nozzle itself. `id` is the ASSIGNMENT -- what the close is keyed by. */
  nozzleId?: string;
  /**
   * Who holds it, per NOZZLE. The pump-level attendant is a display
   * convenience; the server lets two attendants share a pump, and a cash-up
   * is raised against whoever held each nozzle.
   */
  attendantId?: string;
  attendantName?: string;
}

interface Pump {
  id: string;
  pumpNo: number;
  label: string;
  attendantId: string;
  nozzles: Nozzle[];
}

interface Tank {
  id: string;
  label: string;
  grade: string;
  gradeColor: string;
  capacity: number;
  openingDip: number;
  /** null until dipped. 0 is a real reading -- an empty tank. */
  closingDip: number | null;
  deliveries: number;
}

interface Attendant {
  id: string;
  name: string;
  badge: string;
}

interface Expense {
  id: string;
  description: string;
  amount: number;
  category: string;
}

interface Discount {
  id: string;
  description: string;
  amount: number;
  authorisedBy: string;
}

// ─── Initial Data ─────────────────────────────────────────────────────────────


/**
 * Pumps start empty and are filled from the equipment list on load -- the
 * same source the pump-setup screen reads, so a pump added there appears here.
 */
const INIT_PUMPS: Pump[] = [];

/**
 * Expenses start EMPTY, and that is correct rather than missing.
 *
 * This list was pre-filled with plausible expenses -- a generator service, a
 * water bill -- on every shift. But a shift has no expenses until the
 * supervisor records one, and a form that arrives already filled in invites
 * somebody to close the shift with figures they never entered. The totals
 * below would then include money nobody spent.
 */
const INIT_EXPENSES: Expense[] = [];

/**
 * Discounts start empty for the same reason as expenses: a shift has given
 * none away until somebody records one. A pre-filled discount would reduce
 * the declared revenue by an amount no customer ever received.
 */
const INIT_DISCOUNTS: Discount[] = [];

// FUEL_PRICES (a hardcoded price table) was here. Prices now come from the shift, via fn_shift_price.
const EXPENSE_CATEGORIES = ['Utilities', 'Cleaning', 'Maintenance', 'Stationery', 'Other'];

function fmt(n: number, dec = 0) { return n.toLocaleString('en-UG', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function fmtUGX(n: number) { return 'UGX ' + fmt(n); }

// ─── Main Component ───────────────────────────────────────────────────────────
/** The colour of a grade's pump handle -- the same everywhere in the app. */
const GRADE_COLOUR: Record<string, string> = {
  PMS: '#00D4A0',
  AGO: '#F59E0B',
  IK: '#60A5FA',
  LPG: '#A78BFA',
};

/**
 * The open shift's assignments, as the screen's pumps.
 *
 * `nozzle.id` is the ASSIGNMENT id, because that is what the close is keyed by:
 * one nozzle can be held by two attendants across a handover, and each holding
 * is its own meter event. The nozzle's own id is kept alongside, because a
 * return to tank is recorded against the nozzle.
 *
 * Both OPENING readings come from the server (730): each carried from the
 * nozzle's last close. The two heads' absolute values legitimately differ --
 * only their litres compare, and they must agree to within 1 L.
 */
function toClosurePumps(asg: AssignmentView[], shiftTanks: TankView[]): Pump[] {
  const tankFor = (product: string) =>
    shiftTanks.find((t) => t.productCode === product)?.tankId ?? '';
  const byPump = new Map<string, AssignmentView[]>();
  for (const a of asg.filter((x) => x.state === 'ACTIVE')) {
    byPump.set(a.pumpCode, [...(byPump.get(a.pumpCode) ?? []), a]);
  }
  return Array.from(byPump.entries()).map(([code, list], i) => ({
    id: code,
    pumpNo: Number(code.replace(/\D/g, '')) || i + 1,
    label: code,
    attendantId: list[0]?.attendantId ?? '',
    nozzles: list.map((a, j) => ({
      id: a.id,
      nozzleId: a.nozzleId,
      attendantId: a.attendantId,
      attendantName: a.attendantName,
      nozzleNo: Number(a.nozzleCode.replace(/\D/g, '')) || j + 1,
      grade: a.productCode,
      gradeColor: GRADE_COLOUR[a.productCode] ?? '#64748B',
      tankId: tankFor(a.productCode),
      openElec: a.openingElectronic ?? 0,
      closeElec: 0,
      openManual: a.openingTotalizer ?? 0,
      closeManual: 0,
    })),
  }));
}

/** The shift's tanks: opening is the dip taken at open (the book only if none was taken),
 *  deliveries are what was received into the tank during the shift. */
function toShiftTank(t: TankView): Tank {
  return {
    id: t.tankId,
    label: `${t.code} \u2013 ${t.productCode}`,
    grade: t.productCode,
    gradeColor: GRADE_COLOUR[t.productCode] ?? '#64748B',
    capacity: t.nominalLitres,
    openingDip: t.openingLitres ?? t.bookLitres,
    closingDip: t.actualLitres ?? null,
    deliveries: t.receivedLitres ?? 0,
  };
}

export default function ShiftClosureContent() {
  const [partial, setPartial] = useState<string[]>([]);
  const SITES = useSites();
  const { isSiteManager, assignedSite } = useAuth();
  const [activeTab, setActiveTab] = useState<'meters' | 'dippings' | 'sales' | 'expenses' | 'gainloss' | 'attendants'>('meters');
  const [shiftDate, setShiftDate] = useState(businessToday());
  // The open shift's own label (DAY / NIGHT). This was a Morning / Afternoon /
  // Night picker that loaded nothing -- the screen always closes the current
  // shift -- but it, the date picker and the site picker headed the PRINTED
  // closure sheet, so a sheet could name the wrong shift, day and site. (W6)
  const [shiftLabelCode, setShiftLabelCode] = useState('');
  // The site's NAME, from the real site list. This defaulted to "Kampala
  // Central", a station that does not exist, and for a site manager it used
  // assignedSite -- which is an id, so the printed report header would have
  // shown a uuid where the station name belongs.
  const [site, setSite] = useState('');
  useEffect(() => {
    if (!site && SITES.length > 0) setSite(SITES[0]);
  }, [SITES, site]);
  const [pumps, setPumps] = useState<Pump[]>(INIT_PUMPS);
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [attendants, setAttendants] = useState<Attendant[]>([]);

  // ── THE OPEN SHIFT ──
  //
  // Loaded from /api/shifts/current, not the equipment list. Equipment cannot
  // know a nozzle's OPENING reading or who holds it this shift; the open
  // shift's assignments carry both, plus the assignment id the close is keyed
  // by. The previous version set the pumps from nothing at all, so the meter
  // table on this screen was permanently empty.
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [loadingShift, setLoadingShift] = useState(true);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [returns, setReturns] = useState<ReturnToTankRow[]>([]);
  const [channels, setChannels] = useState<ChannelRef[]>([]);

  const loadClosure = useCallback(async (id: string) => {
    const ctx = await api.get<ClosureContext>(`/api/v1/shifts/${id}/closure`);
    setPrices(Object.fromEntries(ctx.prices.map((x) => [x.productCode, x.unitPrice])));
    setReturns(ctx.returns);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // TWO calls, on purpose. /current returns a SUMMARY -- id, date, label
        // -- and 204 when nothing is open. The assignments and tanks come from
        // /{id}. An earlier draft read the summary as if it were the detail,
        // checked for a `.shift` field a summary does not have, and would have
        // reported "no shift is open" on every shift that was.
        const current = await api.get<ShiftSummary | undefined>('/api/shifts/current');
        if (cancelled) return;
        if (!current) {
          setShiftError('NO_OPEN_SHIFT');
          return;
        }
        const detail = await api.get<ShiftDetail>(`/api/shifts/${current.id}`);
        if (cancelled) return;
        setShiftId(detail.shift.id);
        setShiftDate(current.businessDate.slice(0, 10));
        setShiftLabelCode(current.label);
        setPumps(toClosurePumps(detail.assignments, detail.tanks));
        setTanks(detail.tanks.map(toShiftTank));
        const seen = new Map<string, Attendant>();
        for (const a of detail.assignments) {
          if (!seen.has(a.attendantId)) {
            seen.set(a.attendantId, { id: a.attendantId, name: a.attendantName, badge: a.employeeNo });
          }
        }
        // Shop sellers too. The database refuses a close that leaves out anyone
        // who SOLD (migration 360) -- and a shop hand who never held a nozzle
        // is not in the assignments, so without this the close was refused
        // naming someone this screen offered no way to cash up.
        const [chs, shop, , drops] = await Promise.all([
          api.get<ChannelRef[]>('/api/setup/payment-channels'),
          api.get<DrySaleView[]>(`/api/dry-stock/shifts/${detail.shift.id}/sales`).catch(() => { setPartial((x) => (x.includes('shop sellers to cash up') ? x : [...x, 'shop sellers to cash up'])); return [] as DrySaleView[]; }),
          loadClosure(detail.shift.id),
          // (580) what each attendant already dropped in the safe
          api.get<CashDropList>(`/api/shifts/${detail.shift.id}/cash-drops`).catch(() => { setPartial((x) => (x.includes('cash drops') ? x : [...x, 'cash drops'])); return null; }),
        ]);
        if (!cancelled) setDropList(drops);
        // Someone who dropped cash has takings to account for, even with no
        // nozzle or shop sale left on the screen -- the close refuses without them.
        for (const d of drops?.drops ?? []) {
          if (!d.voidedAt && !seen.has(d.attendantId)) seen.set(d.attendantId, { id: d.attendantId, name: d.attendant, badge: '' });
        }
        for (const d of shop) {
          if (!seen.has(d.sellerId)) seen.set(d.sellerId, { id: d.sellerId, name: d.sellerName, badge: '' });
        }
        setAttendants(Array.from(seen.values()));
        if (!cancelled) setChannels(chs);
      } catch (e) {
        const err = e as ApiError;
        if (!cancelled) setShiftError(err.status === 404 ? 'NO_OPEN_SHIFT' : err.message);
      } finally {
        if (!cancelled) setLoadingShift(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadClosure]);
  const [expenses, setExpenses] = useState<Expense[]>(INIT_EXPENSES);
  const [discounts, setDiscounts] = useState<Discount[]>(INIT_DISCOUNTS);
  // ── CASH-UP, PER ATTENDANT ──
  //
  // These were six constants -- cash 1,250,000, MTN 680,000, Airtel 320,000,
  // Visa 950,000, credit 480,000, counted 1,200,000 -- with no input attached,
  // so every shift declared 3.68 million shillings nobody took, and the
  // "cash short" check compared two fixed numbers and always passed.
  //
  // They are PER ATTENDANT now because the server's are: a shortage is raised
  // against a named person, and a shift-wide total cannot say who is short.
  type Declared = { cash: number; tenders: Record<string, number>; shortageReason: string };
  const [declared, setDeclared] = useState<Record<string, Declared>>({});
  const [dropList, setDropList] = useState<CashDropList | null>(null);
  const decl = (id: string): Declared => declared[id] ?? { cash: 0, tenders: {}, shortageReason: '' };
  const setDecl = (id: string, patch: Partial<Declared>) =>
    setDeclared((prev) => ({ ...prev, [id]: { ...decl(id), ...patch } }));

  const sumTender = (match: RegExp) =>
    Object.values(declared).reduce(
      (t, d) =>
        t +
        Object.entries(d.tenders)
          .filter(([code]) => match.test(code))
          .reduce((a, [, v]) => a + (v || 0), 0),
      0,
    );

  // The screen's existing summary reads these names, so they stay -- derived
  // from what was actually typed rather than fixed.
  // Cash in hand at close PLUS what was dropped in the safe during the shift
  // (580): both are cash the station holds.
  const droppedFor = (id: string) => dropList?.byAttendant.find((t) => t.attendantId === id);
  const droppedTotal = (dropList?.byAttendant ?? []).reduce((t, x) => t + x.dropped, 0);
  const cashPhysical = Object.values(declared).reduce((t, d) => t + (d.cash || 0), 0) + droppedTotal;
  const mtnMM = sumTender(/MTN/i);
  const airtelMM = sumTender(/AIRTEL/i);
  const mpesaMM = sumTender(/MPESA|M-PESA/i);
  const tigoPesa = sumTender(/TIGO/i);
  const visaAmount = sumTender(/VISA|CARD|MASTER/i);
  const creditSales = 0; // credit is recorded as credit sales during the shift, not re-typed here

  // Everything declared, cash and electronic. It used to be a separately typed
  // "counted" figure that nothing reconciled against anything.
  const actualCashCounted = cashPhysical + mtnMM + airtelMM + mpesaMM + tigoPesa + visaAmount;

  // What the SERVER says, once the supervisor has run the check. Null until
  // then -- and the close is not offered until it has run.
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [closing, setClosing] = useState(false);

  // Rollovers the supervisor has ASSERTED, per assignment. Never inferred: a
  // reading lower than the opening is either a totalizer that rolled past its
  // last digit or a typing mistake, and the system cannot tell which. Only a
  // person looking at the pump head can.
  const [rollovers, setRollovers] = useState<Record<string, boolean>>({});

  // Return to tank: the entry form.
  const [rttNozzle, setRttNozzle] = useState('');
  const [rttLitres, setRttLitres] = useState('');
  const [rttReason, setRttReason] = useState('');
  const [shiftStatus, setShiftStatus] = useState<'open' | 'closed'>('open');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const printRef = useRef<HTMLDivElement | null>(null);
  const { showToast } = useToast();

  // ── Computed: Nozzle totals ──
  const allNozzles = pumps.flatMap(p => p.nozzles.map(n => ({
    ...n,
    pumpLabel: p.label,
    attendantId: p.attendantId,
    // Nothing is "sold" until a closing reading is typed. Without the guard
    // every nozzle showed 0 minus its opening -- a six-figure NEGATIVE sale.
    // Each head is compared with its OWN opening (only deltas compare), which
    // the server now supplies. It was fixed at 0, so "Total Elec. Sales" read
    // 0.0 L on a shift that had sold fuel.
    elecSold: n.closeElec > 0 ? Math.max(0, n.closeElec - n.openElec) : 0,
    // A backwards reading counts as nothing sold until the supervisor asserts a
    // rollover; the server works out the rolled figure from the meter's digit
    // count, so the running total here stays conservative rather than guessing.
    manualSold: n.closeManual > 0 ? Math.max(0, n.closeManual - n.openManual) : 0,
    rtt: returns.filter((r) => r.nozzleId === n.nozzleId).reduce((a, r) => a + r.litres, 0),
    variance: 0,
  })));

  // ---- what is missing or does not add up before the close ----
  const [closeTried, setCloseTried] = useState(false);
  const closeIssues = useMemo(() => {
    const c = new Checker();
    for (const n of allNozzles) {
      const f = `read:${n.id}`, name = `${n.pumpLabel} nozzle ${n.nozzleNo}`;
      if (!(n.closeManual > 0)) { c.error(f, `${name}: the closing meter reading is needed`); continue; }
      if (n.closeManual < n.openManual && rollovers[n.id] !== true)
        c.error(f, `${name}: ${n.closeManual.toLocaleString()} is below its opening of ${n.openManual.toLocaleString()} - check it, or tick that the meter rolled over`);
      if (n.closeManual >= n.openManual && rollovers[n.id] === true)
        c.warn(f, `${name}: rollover is ticked, but the reading is above the opening`);
      if (n.manualSold > 30000) c.warn(f, `${name}: ${Math.round(n.manualSold).toLocaleString()} L in one shift - check the reading`);
      // (730) the electronic meter too, its litres within 1 L of the manual's
      if (!(n.closeElec > 0)) { c.error(f, `${name}: the closing electronic meter reading is needed - both meters are read`); continue; }
      if (n.closeElec < n.openElec) { c.error(f, `${name}: electronic ${n.closeElec.toLocaleString()} is below its opening of ${n.openElec.toLocaleString()}`); continue; }
      const apart = (n.closeElec - n.openElec) - n.manualSold;
      if (rollovers[n.id] !== true && Math.abs(apart) > 1 && (n.meterReason ?? '').trim().length < 5)
        c.error(f, `${name}: the meters are ${apart > 0 ? '+' : ''}${apart.toFixed(2)} L apart - at most 1 L. Check both readings, or say why`);
    }
    for (const t of tanks) {
      const f = `dip:${t.id}`;
      if (t.closingDip === null) { c.error(f, `${t.label}: the closing dip is needed (0 if empty)`); continue; }
      if (t.closingDip < 0) { c.error(f, `${t.label}: a dip cannot be negative`); continue; }
      if (t.closingDip > t.capacity) { c.error(f, `${t.label}: ${t.closingDip.toLocaleString()} L is more than the tank holds (${t.capacity.toLocaleString()} L)`); continue; }
      // What the meters say should be left: opening, plus deliveries, less what
      // its nozzles pumped. The gap is this shift's loss -- seen BEFORE closing.
      const pumped = allNozzles.filter((n) => n.tankId === t.id).reduce((a, n) => a + n.manualSold - n.rtt, 0);
      const expected = t.openingDip + t.deliveries - pumped;
      const gap = t.closingDip - expected;
      if (allNozzles.filter((n) => n.tankId === t.id).every((n) => n.closeManual > 0) && Math.abs(gap) > Math.max(50, t.capacity * 0.005))
        c.warn(f, `${t.label}: ${gap > 0 ? '+' : ''}${Math.round(gap).toLocaleString()} L against what the meters leave (${Math.round(expected).toLocaleString()} L) - re-dip; if it is real, it will need explaining`);
    }
    return c.issues;
  }, [allNozzles, tanks, rollovers]);
  const gateClose = (): boolean => {
    setCloseTried(true);
    if (hasErrors(closeIssues)) {
      showToast(`Fix the ${errorCount(closeIssues)} thing(s) marked in red before closing`, 'error');
      return false;
    }
    return true;
  };

  const totalElecSold = allNozzles.reduce((s, n) => s + n.elecSold, 0);
  const totalManualSold = allNozzles.reduce((s, n) => s + n.manualSold, 0);
  const totalMeterVariance = totalElecSold - totalManualSold;

  // ── Computed: Tank dippings ──
  const tankTotals = tanks.map(t => ({
    ...t,
    consumed: t.openingDip - (t.closingDip ?? 0) + t.deliveries,
    fillPct: ((t.closingDip ?? 0) / t.capacity) * 100,
  }));
  const totalDipConsumed = tankTotals.reduce((s, t) => s + t.consumed, 0);
  // A tank not yet dipped has no consumption; reading its blank as 0 showed the
  // whole tank as lost before anyone had dipped it.
  const dipsPending = tanks.some((t) => t.closingDip === null);

  // ── Computed: Sales ──
  const totalMobileMoney = mtnMM + airtelMM + mpesaMM + tigoPesa;
  const totalCash = cashPhysical + totalMobileMoney + visaAmount;
  const totalSales = totalCash + creditSales;
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const totalDiscounts = discounts.reduce((s, d) => s + d.amount, 0);
  const netSales = totalSales - totalDiscounts;
  const cashShort = preview ? preview.cashUps.reduce((t, c) => t + Math.max(0, c.unallocated), 0) : 0;
  const isShort = cashShort > 0;

  // ── Computed: Gain/Loss per grade ──
  const gradeGainLoss = Object.entries(
    allNozzles.reduce((acc, n) => {
      // Mechanical, net of return-to-tank. Without the RTT term, litres
      // poured back showed here as a GAIN -- the same litres the attendant was
      // being charged for as a sale.
      acc[n.grade] = (acc[n.grade] || 0) + Math.max(0, n.manualSold - n.rtt);
      return acc;
    }, {} as Record<string, number>)
  ).map(([grade, elecTotal]) => {
    const dipConsumed = tankTotals.filter(t => t.grade === grade).reduce((s, t) => s + t.consumed, 0);
    const gl = elecTotal - dipConsumed;
    // The shift's own price for this grade, from the same function the close
    // uses. It was FUEL_PRICES[grade] || 5000 -- a hardcoded table with an
    // invented fallback, different again from the 5,150 used for cash.
    const price = prices[grade] ?? 0;
    return { grade, elecTotal, dipConsumed, gl, glValue: gl * price };
  });

  const totalGainLoss = dipsPending ? 0 : gradeGainLoss.reduce((s, g) => s + g.gl, 0);
  const totalGainLossValue = dipsPending ? 0 : gradeGainLoss.reduce((s, g) => s + g.glValue, 0);

  // ── Accounting balance check ──
  // What the meters say is owed: each nozzle's MECHANICAL litres, less any
  // return to tank, at that grade's shift price.
  //
  // It was totalElecSold * 5150 -- one invented price across every grade, on
  // the electronic head, with no RTT. Three errors in one line, and the server
  // disagreed with all of them: it bills the mechanical totalizer, per grade,
  // net of returns. This is only a running guide while typing; the figure an
  // attendant is held to comes back from close-preview.
  const expectedFromMeters = allNozzles.reduce(
    (t, n) => t + Math.max(0, n.manualSold - n.rtt) * (prices[n.grade] ?? 0),
    0,
  );
  const totalRtt = allNozzles.reduce((t, n) => t + n.rtt, 0);
  const accountingItems = [
    { label: 'Meter readings entered', ok: totalManualSold > 0 },
    { label: 'Dipping records entered', ok: tanks.length > 0 && !dipsPending },
    { label: 'Every attendant has declared', ok: attendants.length > 0 && attendants.every((a) => declared[a.id] !== undefined) },
    { label: 'Checked against the server', ok: preview !== null },
    { label: 'Attendants allocated to all pumps', ok: pumps.every(p => p.attendantId !== '') },
    // Every unallocated shilling is either zero or a named shortage with a
    // reason -- the server's rule, read from the server's answer. The old
    // check compared two constants and could not fail.
    { label: 'Every shortage explained', ok: preview !== null && preview.cashUps.every((c) => c.unallocated <= 0 || (decl(c.staffId).shortageReason.trim().length >= 5)) },
  ];
  const canCloseShift = accountingItems.every(i => i.ok);

  // ── Handlers ──
  const updateNozzle = (pumpId: string, nozzleId: string, field: keyof Nozzle, value: number | string) => {
    setPumps(prev => prev.map(p => p.id === pumpId
      ? { ...p, nozzles: p.nozzles.map(n => n.id === nozzleId ? { ...n, [field]: value } : n) }
      : p
    ));
  };

  const updatePumpAttendant = (pumpId: string, attendantId: string) => {
    setPumps(prev => prev.map(p => p.id === pumpId ? { ...p, attendantId } : p));
  };

  const updateTank = (id: string, field: keyof Tank, value: number | null) => {
    setTanks(prev => prev.map(t => t.id === id ? { ...t, [field]: value } : t));
  };

  const addExpense = () => setExpenses(prev => [...prev, { id: `ex${Date.now()}`, description: '', amount: 0, category: 'Other' }]);
  const updateExpense = (id: string, field: keyof Expense, value: string | number) => setExpenses(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  const removeExpense = (id: string) => setExpenses(prev => prev.filter(e => e.id !== id));

  const addDiscount = () => setDiscounts(prev => [...prev, { id: `dc${Date.now()}`, description: '', amount: 0, authorisedBy: '' }]);
  const updateDiscount = (id: string, field: keyof Discount, value: string | number) => setDiscounts(prev => prev.map(d => d.id === id ? { ...d, [field]: value } : d));
  const removeDiscount = (id: string) => setDiscounts(prev => prev.filter(d => d.id !== id));

  const handleCloseShift = () => {
    if (!canCloseShift) { showToast('Please resolve all accounting items before closing the shift', 'error'); return; }
    setShowCloseConfirm(true);
  };

  /** The request the server's close takes -- the same body for preview and close. */
  const buildRequest = () => {
    const undipped = tanks.filter((t) => t.closingDip === null);
    if (undipped.length > 0) {
      throw new Error(`Dip every tank before closing - ${undipped.map((t) => t.label).join(', ')} ${undipped.length === 1 ? 'has' : 'have'} no closing dip. An empty tank is dipped as 0.`);
    }
    return buildBody();
  };

  const buildBody = () => ({
    reason: 'SCHEDULED',
    readings: allNozzles
      .filter((n) => n.closeManual > 0)
      .map((n) => ({
        assignmentId: n.id,
        volumeTotalizer: n.closeManual,
        electronicTotalizer: n.closeElec > 0 ? n.closeElec : null,
        differenceReason: (n.meterReason ?? '').trim() || null,
        amountTotalizer: null,
        // Only what the supervisor ticked. This was briefly inferred from
        // closing < opening, which would have waved any mistyped reading past
        // METER_ROLLBACK as a "rollover" -- the one rule that exists because a
        // backwards meter and a typo look identical to software.
        isRollover: rollovers[n.id] === true,
        photoUrl: null,
        evidenceReason: null,
        capturedAt: null,
      })),
    // EVERY tank, 0 included. This kept only dips above zero: a blank tank was
    // dropped silently, and a genuinely empty tank could never be dipped --
    // the close requires every tank, so that station could not close at all.
    dips: tanks
      .map((t) => ({
        tankId: t.id,
        productLitres: t.closingDip as number,
        waterLitres: null,
        dipMm: null,
        waterDipMm: null,
        temperatureC: null,
        photoUrl: null,
        capturedAt: null,
      })),
    cashUps: attendants.map((a) => {
      const d = decl(a.id);
      return {
        attendantId: a.id,
        cash: d.cash || 0,
        tenders: Object.entries(d.tenders)
          .filter(([, v]) => v > 0)
          .map(([channelCode, amount]) => ({ channelCode, amount, reference: null, evidenceUrl: null })),
        shortageReason: d.shortageReason.trim() || null,
        notes: null,
      };
    }),
  });

  // ── A PRICE CHANGE THAT IS DUE ──
  //
  // A scheduled price change takes effect by CUTTING THE SHIFT: this one
  // closes at the old price and the next opens at the new one, so litres sold
  // either side are valued correctly. It is done here and nowhere else,
  // because cutting a shift needs exactly what a close needs -- the readings,
  // the dips and the cash -- and those are already on this screen.
  //
  // THE ROSTER CARRIES FORWARD: the same attendants keep the same nozzles, and
  // each one's closing totalizer becomes their opening totalizer. Nobody
  // walks off the forecourt because the price moved.
  const [pendingPrice, setPendingPrice] = useState<PendingPriceView | null>(null);

  useEffect(() => {
    void api
      .get<PendingPriceView[]>('/api/ops/prices/pending')
      .then((rows) => {
        const due = rows
          .filter((r) => new Date(r.effectiveFrom) <= new Date())
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
        setPendingPrice(due ?? null);
      })
      .catch(() => setPartial((x) => (x.includes('a price change due now') ? x : [...x, 'a price change due now'])));
  }, []);

  const executePriceBreak = async () => {
    if (!shiftId || !pendingPrice || !gateClose()) return;
    setClosing(true);
    try {
      const req = buildRequest();
      const r = await api.post<{ closedShiftId: string; nextShiftId: string }>(
        `/api/ops/prices/${pendingPrice.id}/execute`,
        {
          readings: req.readings,
          dips: req.dips,
          cashUps: req.cashUps,
          // The same people, the same nozzles, opening where they closed.
          nextRoster: allNozzles
            .filter((n) => n.closeManual > 0 && n.attendantId)
            .map((n) => ({
              nozzleId: n.nozzleId,
              attendantId: n.attendantId,
              volumeTotalizer: n.closeManual,
              electronicTotalizer: n.closeElec > 0 ? n.closeElec : null,   // (730) opening where it closed, both meters
              photoUrl: null,
            })),
        },
        { idempotencyKey: `break-${pendingPrice.id}-${shiftId}` },
      );
      setShiftStatus('closed');
      showToast(
        `Closed at the old price and reopened at ${pendingPrice.newPrice.toLocaleString()} for ${pendingPrice.productCode}`,
        'success',
      );
      void r;
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setClosing(false);
    }
  };

  /**
   * Runs the REAL close and rolls it back. Every rule the database holds --
   * each litre classified, every shilling allocated, RTT deducted -- is applied
   * here, and the answer is what the supervisor sees before committing.
   */
  const runPreview = async () => {
    if (!shiftId || !gateClose()) return;
    setPreviewing(true);
    try {
      const r = await api.post<PreviewResult>(`/api/shifts/${shiftId}/close-preview`, buildRequest());
      setPreview(r);
      const short = r.cashUps.filter((c) => !c.isBalanced);
      showToast(
        short.length === 0
          ? 'Every attendant balances. The shift can close.'
          : `${short.length} attendant(s) short or over — recount, or give the reason for each shortage`,
        short.length === 0 ? 'success' : 'error',
      );
    } catch (e) {
      // The server's refusal, in its own words. It names the nozzle, the tank
      // or the person -- replacing it with "something went wrong" would hide
      // exactly what the supervisor needs to fix.
      showToast((e as ApiError).message, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const confirmClose = async () => {
    if (!gateClose()) return;
    if (!shiftId) return;
    setClosing(true);
    try {
      const r = await api.post<CloseResult>(`/api/shifts/${shiftId}/close`, buildRequest(), {
        // Derived from the shift, never a fresh uuid: a retried close must be
        // recognised as the same close, or a flaky connection closes twice.
        idempotencyKey: `close-${shiftId}`,
      });
      setShiftStatus('closed');
      setShowCloseConfirm(false);
      showToast(
        `Shift closed: ${r.meterEvents} meters, ${r.tanksReconciled} tanks, ${r.cashUps} cash-ups` +
          (r.exceptions > 0 ? ` — ${r.exceptions} exception(s) raised for a manager` : ''),
        'success',
      );
    } catch (e) {
      // Only a server success marks it closed. The old version set the status
      // locally and toasted success without ever calling the server -- the
      // shift stayed open in the database while the screen said it was done.
      setShowCloseConfirm(false);
      showToast((e as ApiError).message, 'error');
    } finally {
      setClosing(false);
    }
  };

  /** Record a return to tank against a nozzle, then re-read the shift's returns. */
  const recordRtt = async () => {
    if (!shiftId) return;
    const litres = Number(rttLitres);
    if (!rttNozzle || !(litres > 0) || rttReason.trim().length < 5) {
      showToast('Choose the nozzle, the litres returned, and say why (at least five characters)', 'error');
      return;
    }
    try {
      await api.post<{ id: string }>(`/api/v1/shifts/${shiftId}/rtt`, {
        nozzleId: rttNozzle,
        litres,
        reason: rttReason.trim(),
        witnessedBy: null,
      }, {
        // A retried RTT would relieve the attendant of the same litres twice --
        // a second write-off of their liability for fuel returned once.
        submission: `rtt:${shiftId}`,
      });
      await loadClosure(shiftId);
      setRttLitres('');
      setRttReason('');
      setPreview(null); // the numbers changed; the old verdict no longer applies
      showToast(`${litres} L returned to tank recorded`, 'success');
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    }
  };

  const handlePrint = () => { window.print(); showToast('Printing shift report...', 'success'); };

  const tabs = [
    { key: 'meters', label: 'Meter Readings', icon: 'CalculatorIcon' },
    { key: 'attendants', label: 'Attendants', icon: 'UserGroupIcon' },
    { key: 'dippings', label: 'Dippings', icon: 'BeakerIcon' },
    { key: 'sales', label: 'Sales & Payments', icon: 'CreditCardIcon' },
    { key: 'expenses', label: 'Expenses & Discounts', icon: 'BanknotesIcon' },
    { key: 'gainloss', label: 'Gain / Loss', icon: 'ArrowTrendingUpIcon' },
  ] as const;



  const priceBreakBanner = pendingPrice && shiftStatus === 'open' && (
    <div className="rounded-xl border p-4 mb-4 space-y-2" style={{ backgroundColor: 'var(--card)', borderColor: '#F59E0B' }}>
      <h2 className="text-sm font-semibold" style={{ color: '#F59E0B' }}>
        A price change is due
      </h2>
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        {pendingPrice.productCode} moves
        {pendingPrice.oldPrice ? ` from ${pendingPrice.oldPrice.toLocaleString()}` : ''} to{' '}
        {pendingPrice.newPrice.toLocaleString()}, effective{' '}
        {new Date(pendingPrice.effectiveFrom).toLocaleString()}. Closing this way cuts the
        shift: it closes at the old price and reopens immediately at the new one, with the
        same attendants on the same nozzles.
      </p>
      <button
        onClick={executePriceBreak}
        disabled={closing || !canCloseShift}
        className="w-full py-2 rounded-lg text-xs font-semibold"
        style={{
          background: '#F59E0B', color: '#111',
          opacity: closing || !canCloseShift ? 0.5 : 1,
        }}
      >
        {closing ? 'Closing...' : 'Close and reopen at the new price'}
      </button>
      {!canCloseShift && (
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          The same checks apply as an ordinary close - finish those first.
        </p>
      )}
    </div>
  );

  if (loadingShift) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (shiftError === 'NO_OPEN_SHIFT') {
    // Said plainly. An empty meter table would read as "this shift has no
    // nozzles", which is a different and alarming claim.
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold text-foreground">No shift is open</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
          A shift has to be opened, with its nozzles rostered to attendants, before
          it can be closed. There is nothing to reconcile yet.
        </p>
      </div>
    );
  }

  if (shiftError) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center">
        <p className="text-sm font-semibold" style={{ color: 'var(--destructive)' }}>
          Could not load the open shift
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{shiftError}</p>
      </div>
    );
  }

  return (
    <>
      {priceBreakBanner}
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #shift-print-area, #shift-print-area * { visibility: visible; }
          #shift-print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* Close Confirm Modal */}
      {showCloseConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="rounded-2xl border p-6 w-full max-w-md" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'rgba(34,197,94,0.15)' }}>
                <Icon name="CheckCircleIcon" size={20} style={{ color: '#22c55e' } as React.CSSProperties} />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">Confirm Shift Closure</h3>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>All items are balanced. This action cannot be undone.</p>
              </div>
            </div>
            <div className="space-y-2 mb-5">
              {[
                { label: 'Total Sales', value: fmtUGX(totalSales) },
                { label: 'Total Expenses', value: fmtUGX(totalExpenses) },
                { label: 'Cash Short', value: fmtUGX(cashShort), color: cashShort > 0 ? '#ef4444' : '#22c55e' },
                { label: 'Gain/Loss', value: `${totalGainLoss >= 0 ? '+' : ''}${fmt(totalGainLoss, 2)} L` },
              ].map(row => (
                <div key={row.label} className="flex justify-between text-xs py-1.5 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--muted-foreground)' }}>{row.label}</span>
                  <span className="font-bold font-mono-nums" style={{ color: row.color || 'var(--foreground)' }}>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCloseConfirm(false)} className="flex-1 py-2 rounded-xl text-sm font-medium border" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>Cancel</button>
              <button onClick={confirmClose} disabled={closing} className="flex-1 py-2 rounded-xl text-sm font-bold" style={{ backgroundColor: '#22c55e', color: '#fff', opacity: closing ? 0.6 : 1 }}>{closing ? 'Closing…' : 'Close Shift'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6 fade-in">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Shift Closure</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Record meter readings, dippings, attendant allocation and reconcile every cent</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/shift-closure/reports" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>
              <Icon name="DocumentChartBarIcon" size={15} />Reports
            </Link>
            <button onClick={handlePrint} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-muted" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>
              <Icon name="PrinterIcon" size={15} />Print
            </button>
            {shiftStatus === 'open' ? (
              <button onClick={handleCloseShift} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all" style={{ backgroundColor: canCloseShift ? 'var(--primary)' : 'var(--muted)', color: canCloseShift ? 'var(--primary-foreground)' : 'var(--muted-foreground)', cursor: canCloseShift ? 'pointer' : 'not-allowed' }}>
                <Icon name="LockClosedIcon" size={15} />Close Shift
              </button>
            ) : (
              <span className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                <Icon name="CheckCircleIcon" size={15} />Shift Closed
              </span>
            )}
          </div>
        </div>

        {/* Shift Info Bar */}
        <div className="rounded-xl border p-4 flex flex-wrap items-center gap-4 no-print" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <Icon name="CalendarDaysIcon" size={15} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
            <span className="px-3 py-1.5 rounded-lg text-sm font-mono-nums" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>{shiftDate}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>Shift:</span>
            <span className="px-3 py-1 rounded-md text-xs font-semibold" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {shiftLabelCode ? shiftLabelName(shiftLabelCode) : '—'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Icon name="BuildingStorefrontIcon" size={15} style={{ color: 'var(--muted-foreground)' } as React.CSSProperties} />
            {isSiteManager && assignedSite ? (
              <span className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(96,165,250,0.1)', color: 'rgb(96,165,250)', border: '1px solid rgba(96,165,250,0.2)' }}>
                📍 {assignedSite}
              </span>
            ) : (
              <select value={site} onChange={e => setSite(e.target.value)} className="input-field py-1.5 px-3 text-sm rounded-lg">
                {SITES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>
          <div className="ml-auto">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: shiftStatus === 'open' ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)', color: shiftStatus === 'open' ? '#f59e0b' : '#22c55e' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: shiftStatus === 'open' ? '#f59e0b' : '#22c55e' }} />
              {shiftStatus === 'open' ? 'In Progress' : 'Closed'}
            </span>
          </div>
        </div>

        {/* Accounting Checklist */}
        <div className="rounded-xl border p-4 no-print" style={{ backgroundColor: canCloseShift ? 'rgba(34,197,94,0.05)' : 'rgba(245,158,11,0.05)', borderColor: canCloseShift ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Icon name={canCloseShift ? 'CheckCircleIcon' : 'ClipboardDocumentCheckIcon'} size={16} style={{ color: canCloseShift ? '#22c55e' : '#f59e0b' } as React.CSSProperties} />
            <span className="text-sm font-semibold" style={{ color: canCloseShift ? '#22c55e' : '#f59e0b' }}>
              {canCloseShift ? 'All items balanced — ready to close shift' : 'Complete all items before closing shift'}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {accountingItems.map(item => (
              <div key={item.label} className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: item.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)' }}>
                  <Icon name={item.ok ? 'CheckIcon' : 'XMarkIcon'} size={10} style={{ color: item.ok ? '#22c55e' : '#ef4444' } as React.CSSProperties} />
                </div>
                <span className="text-xs" style={{ color: item.ok ? 'var(--foreground)' : 'var(--muted-foreground)' }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 no-print">
          {[
            { label: 'Total Elec. Sales', value: `${fmt(totalElecSold, 1)} L`, icon: 'BoltIcon', color: 'var(--primary)' },
            { label: 'Net Sales', value: fmtUGX(netSales), icon: 'BanknotesIcon', color: '#22c55e' },
            { label: 'Daily Gain/Loss', value: dipsPending ? '\u2014' : `${fmt(Math.abs(totalGainLoss), 1)} L`, icon: totalGainLoss >= 0 ? 'ArrowTrendingUpIcon' : 'ArrowTrendingDownIcon', color: dipsPending ? 'var(--muted-foreground)' : totalGainLoss >= 0 ? '#22c55e' : '#ef4444', suffix: dipsPending ? 'dip every tank' : totalGainLoss >= 0 ? 'GAIN' : 'LOSS' },
            { label: 'Total Expenses', value: fmtUGX(totalExpenses), icon: 'ReceiptRefundIcon', color: '#f59e0b' },
            { label: 'Cash Short', value: fmtUGX(Math.abs(cashShort)), icon: 'ExclamationTriangleIcon', color: isShort ? '#ef4444' : '#22c55e', suffix: isShort ? 'SHORT' : 'OK' },
          ].map(card => (
            <div key={card.label} className="rounded-xl p-4 border" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${card.color}20` }}>
                  <Icon name={card.icon as Parameters<typeof Icon>[0]['name']} size={14} style={{ color: card.color } as React.CSSProperties} />
                </div>
                <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{card.label}</span>
              </div>
              <div className="flex items-end gap-1.5">
                <p className="text-base font-bold font-mono-nums text-foreground">{card.value}</p>
                {card.suffix && <span className="text-xs font-bold mb-0.5" style={{ color: card.color }}>{card.suffix}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 rounded-xl overflow-x-auto no-print" style={{ backgroundColor: 'var(--muted)', border: '1px solid var(--border)' }}>
          {tabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className="flex items-center gap-2 flex-none sm:flex-1 justify-center px-3 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap"
              style={{ backgroundColor: activeTab === tab.key ? 'var(--card)' : 'transparent', color: activeTab === tab.key ? 'var(--primary)' : 'var(--muted-foreground)', boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
              <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />
              {/* Labelled on phones too: six unlabelled icons were a guess. The
                  bar scrolls sideways instead. (D3) */}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab: Attendant Allocation */}
        {activeTab === 'attendants' && (
          <div className="space-y-4">
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="UserGroupIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                <h2 className="text-sm font-semibold text-foreground">Pump Attendant Allocation</h2>
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(0,212,160,0.1)', color: 'var(--primary)' }}>
                  {pumps.filter(p => p.attendantId).length}/{pumps.length} allocated
                </span>
              </div>
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {pumps.map(pump => {
                  const att = attendants.find(a => a.id === pump.attendantId);
                  const pumpSales = pump.nozzles.reduce((s, n) => s + (n.closeElec - n.openElec), 0);
                  return (
                    <div key={pump.id} className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                            P{pump.pumpNo}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-foreground">{pump.label}</p>
                            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{pump.nozzles.length} nozzles · {fmt(pumpSales, 1)} L sold</p>
                          </div>
                        </div>
                        {att && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>{att.badge}</span>
                        )}
                      </div>
                      <div className="mb-3">
                        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--muted-foreground)' }}>Assigned Attendant</label>
                        <select
                          value={pump.attendantId}
                          onChange={e => updatePumpAttendant(pump.id, e.target.value)}
                          className="input-field py-2 px-3 text-sm w-full rounded-lg"
                        >
                          <option value="">— Select Attendant —</option>
                          {attendants.map(a => <option key={a.id} value={a.id}>{a.name} ({a.badge})</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        {pump.nozzles.map(n => (
                          <div key={n.id} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: n.gradeColor }} />
                            <span style={{ color: 'var(--muted-foreground)' }}>Nozzle {n.nozzleNo}:</span>
                            <span className="font-medium text-foreground">{n.grade}</span>
                            <span className="ml-auto font-mono-nums" style={{ color: 'var(--primary)' }}>{fmt(n.closeElec - n.openElec, 1)} L</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Tab: Meter Readings */}
        {activeTab === 'meters' && (
          <div className="space-y-4">
            {/* ROLLOVER. Asked only where a closing reading is LOWER than the
                opening -- asked on every nozzle it would be ticked without
                reading. Unticked, the server refuses the backwards meter by
                name, which is the safe failure. */}
            {allNozzles.some((n) => n.closeManual > 0 && n.closeManual < n.openManual) && (
              <div className="rounded-xl border p-4 space-y-2" style={{ backgroundColor: 'var(--card)', borderColor: '#ef4444' }}>
                <h2 className="text-sm font-semibold" style={{ color: '#ef4444' }}>
                  Meter reads lower than it opened
                </h2>
                {allNozzles
                  .filter((n) => n.closeManual > 0 && n.closeManual < n.openManual)
                  .map((n) => (
                    <label key={n.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={rollovers[n.id] === true}
                        onChange={(e) => {
                          setRollovers((prev) => ({ ...prev, [n.id]: e.target.checked }));
                          setPreview(null);
                        }}
                      />
                      <span>
                        {n.pumpLabel} N{n.nozzleNo}: opened {n.openManual.toLocaleString()}, closing{' '}
                        {n.closeManual.toLocaleString()}. Tick ONLY if the totalizer rolled past its last
                        digit. Otherwise the reading is wrong — correct it.
                      </span>
                    </label>
                  ))}
              </div>
            )}

            {/* RETURN TO TANK. Litres the meter counted that went back into the
                tank. Deducted from what the attendant owes and put back in the
                tank book. Recorded by a supervisor, with a reason, because it
                is the easiest place in a forecourt to hide theft: sell twenty
                litres for cash and declare them "returned". */}
            <div className="rounded-xl border p-4 space-y-3" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Return to tank (RTT)</h2>
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {totalRtt > 0 ? `${totalRtt.toLocaleString()} L returned this shift` : 'None recorded'}
                </span>
              </div>
              {returns.length > 0 && (
                <div className="space-y-1">
                  {returns.map((r) => (
                    <p key={r.id} className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <strong className="text-foreground">{r.nozzleLabel}</strong> · {r.litres.toLocaleString()} L · {r.reason} ·
                      recorded by {r.recordedBy}
                    </p>
                  ))}
                </div>
              )}
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
                <select className="input-field text-xs" value={rttNozzle} onChange={(e) => setRttNozzle(e.target.value)}>
                  <option value="">Nozzle…</option>
                  {allNozzles.map((n) => (
                    <option key={n.id} value={n.nozzleId ?? ''}>
                      {n.pumpLabel} · N{n.nozzleNo} · {n.grade}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  className="input-field text-xs"
                  placeholder="Litres returned"
                  value={rttLitres}
                  onChange={(e) => setRttLitres(e.target.value)}
                />
                <input
                  className="input-field text-xs"
                  placeholder="Why? e.g. line flushed after repair"
                  value={rttReason}
                  onChange={(e) => setRttReason(e.target.value)}
                />
                <button
                  onClick={recordRtt}
                  className="py-2 rounded-lg text-xs font-semibold"
                  style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  Record RTT
                </button>
              </div>
            </div>

            {pumps.map(pump => (
              <div key={pump.id} className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
                <div className="px-5 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}>
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>P{pump.pumpNo}</div>
                  <span className="text-sm font-semibold text-foreground">{pump.label}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(0,212,160,0.1)', color: 'var(--primary)' }}>
                    {pump.nozzles.length} nozzles
                  </span>
                  <span className="ml-auto text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    Attendant: <span className="font-medium text-foreground">{attendants.find(a => a.id === pump.attendantId)?.name || 'Not assigned'}</span>
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'rgba(0,0,0,0.1)' }}>
                        {['Nozzle', 'Grade', 'Tank', 'Open Elec.', 'Close Elec.', 'Elec. Sold', 'Open Manual', 'Close Manual', 'Manual Sold', 'Variance'].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pump.nozzles.map((n, i) => {
                        // Blank until a closing reading is typed: 0 minus the opening is not a sale.
                        const elecSold = n.closeElec > 0 ? n.closeElec - n.openElec : 0;
                        const manualSold = n.closeManual > 0 ? n.closeManual - n.openManual : 0;
                        const variance = n.closeElec > 0 && n.closeManual > 0 ? elecSold - manualSold : 0;
                        const tank = tanks.find(t => t.id === n.tankId);
                        return (
                          <tr key={n.id} style={{ borderBottom: i < pump.nozzles.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30">
                            <td className="px-3 py-2.5 text-xs font-medium text-foreground">Nozzle {n.nozzleNo}</td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: `${n.gradeColor}20`, color: n.gradeColor }}>{n.grade}</span>
                            </td>
                            <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>{tank?.label || n.tankId}</td>
                            <td className="px-3 py-2.5">
                              {/* carried from the last close; not typed here */}
                              <span className="font-mono-nums text-xs" title="Carried from this nozzle's last close">{n.openElec.toLocaleString()}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <input type="number" value={n.closeElec} onChange={e => updateNozzle(pump.id, n.id, 'closeElec', Number(e.target.value))} className="input-field py-1 px-2 text-xs w-28 font-mono-nums" />
                            </td>
                            <td className="px-3 py-2.5 font-mono-nums text-xs font-semibold" style={{ color: 'var(--primary)' }}>{fmt(elecSold, 1)} L</td>
                            <td className="px-3 py-2.5">
                              <span className="font-mono-nums text-xs" title="Carried from this nozzle's last close">{n.openManual.toLocaleString()}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <input type="number" style={fieldStyle(closeIssues, `read:${n.id}`, closeTried)} value={n.closeManual} onChange={e => updateNozzle(pump.id, n.id, 'closeManual', Number(e.target.value))} className="input-field py-1 px-2 text-xs w-28 font-mono-nums" />
                            </td>
                            <td className="px-3 py-2.5 font-mono-nums text-xs font-semibold text-foreground">{fmt(manualSold, 1)} L</td>
                            <td className="px-3 py-2.5">
                              <span className="text-xs font-bold font-mono-nums px-2 py-0.5 rounded-full" style={{ backgroundColor: Math.abs(variance) <= 1 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: Math.abs(variance) <= 1 ? '#22c55e' : '#ef4444' }}>
                                {variance >= 0 ? '+' : ''}{fmt(variance, 2)} L
                              </span>
                              {n.closeElec > 0 && n.closeManual > 0 && Math.abs(variance) > 1 && (
                                <input className="input-field text-xs mt-1 w-56" aria-label="Why the meters differ"
                                       placeholder="More than 1 L apart: why? (goes to the manager)"
                                       value={n.meterReason ?? ''}
                                       onChange={e => updateNozzle(pump.id, n.id, 'meterReason', e.target.value)} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {/* Totals */}
            <div className="rounded-xl border p-4 flex flex-wrap gap-6" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              {[
                { label: 'Total Elec. Sold', value: `${fmt(totalElecSold, 1)} L`, color: 'var(--primary)' },
                { label: 'Total Manual Sold', value: `${fmt(totalManualSold, 1)} L`, color: 'var(--foreground)' },
                { label: 'Total Variance', value: `${totalMeterVariance >= 0 ? '+' : ''}${fmt(totalMeterVariance, 2)} L`, color: allNozzles.every((n) => Math.abs((n.closeElec - n.openElec) - (n.closeManual - n.openManual)) <= 1) ? '#22c55e' : '#ef4444' },
              ].map(row => (
                <div key={row.label}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)' }}>{row.label}</p>
                  <p className="text-lg font-bold font-mono-nums" style={{ color: row.color }}>{row.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab: Dippings */}
        {activeTab === 'dippings' && (
          <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
            <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
              <Icon name="BeakerIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
              <h2 className="text-sm font-semibold text-foreground">Tank Dipping Records</h2>
              <span className="ml-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>Nozzles across different pumps sharing the same grade draw from the same tank</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                    {['Tank', 'Grade', 'Pumps Drawing', 'Opening Dip', 'Deliveries', 'Closing Dip', 'Consumed', 'Capacity', 'Fill %'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tankTotals.map((t, i) => {
                    const drawingPumps = pumps.filter(p => p.nozzles.some(n => n.tankId === t.id));
                    return (
                      <tr key={t.id} style={{ borderBottom: i < tankTotals.length - 1 ? '1px solid var(--border)' : 'none' }} className="hover:bg-muted/30">
                        <td className="px-4 py-3 text-xs font-medium text-foreground">{t.label}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: `${t.gradeColor}20`, color: t.gradeColor }}>{t.grade}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {drawingPumps.map(p => (
                              <span key={p.id} className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: 'var(--muted)', color: 'var(--foreground)' }}>P{p.pumpNo}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono-nums text-xs text-foreground" title="Dipped when the shift opened">{fmt(t.openingDip, 1)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono-nums text-xs text-foreground" title="Received on the Deliveries screen during this shift">{fmt(t.deliveries, 1)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <input type="number" style={fieldStyle(closeIssues, `dip:${t.id}`, closeTried)} value={t.closingDip ?? ''} onChange={e => updateTank(t.id, 'closingDip', e.target.value === '' ? null : Number(e.target.value))} className="input-field py-1 px-2 text-xs w-24 font-mono-nums" />
                        </td>
                        <td className="px-4 py-3 font-mono-nums text-xs font-semibold" style={{ color: 'var(--primary)' }}>{t.closingDip === null ? '\u2014' : `${fmt(t.consumed, 1)} L`}</td>
                        <td className="px-4 py-3 font-mono-nums text-xs text-foreground">{fmt(t.capacity)} L</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                              <div className="h-full rounded-full" style={{ width: `${Math.min(100, t.fillPct)}%`, backgroundColor: t.fillPct < 20 ? '#ef4444' : t.fillPct < 40 ? '#f59e0b' : '#22c55e' }} />
                            </div>
                            <span className="text-xs font-mono-nums" style={{ color: t.fillPct < 20 ? '#ef4444' : 'var(--muted-foreground)' }}>{fmt(t.fillPct, 1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)', backgroundColor: 'var(--muted)' }}>
                    <td colSpan={6} className="px-4 py-3 text-xs font-bold text-foreground">TOTAL CONSUMED</td>
                    <td className="px-4 py-3 font-mono-nums text-sm font-bold" style={{ color: 'var(--primary)' }}>{dipsPending ? '\u2014' : `${fmt(totalDipConsumed, 1)} L`}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Tab: Sales & Payments */}
        {activeTab === 'sales' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="BanknotesIcon" size={16} style={{ color: '#22c55e' } as React.CSSProperties} />
                <h2 className="text-sm font-semibold text-foreground">Cash & Payments Breakdown</h2>
              </div>
              <div className="p-5 space-y-3">
                {/* PER ATTENDANT, because the server's cash-up is. A shortage is
                    raised against a named person; a shift-wide total cannot say
                    who is short. This replaced eight shift-level fields that were
                    pre-filled with 3.68 million shillings of invented takings. */}
                {attendants.length === 0 && (
                  <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    Nobody is rostered on this shift, so there is no cash to declare.
                  </p>
                )}
                {attendants.map((a) => {
                  const d = decl(a.id);
                  const pc = preview?.cashUps.find((c) => c.staffId === a.id);
                  return (
                    <div
                      key={a.id}
                      className="rounded-lg border p-3 space-y-2"
                      style={{ borderColor: pc && !pc.isBalanced ? '#ef4444' : 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-foreground">{a.name}</span>
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{a.badge}</span>
                      </div>
                      {(() => {
                        const dr = droppedFor(a.id);
                        return (
                          <p className="text-xs flex items-center justify-between" style={{ color: 'var(--muted-foreground)' }}>
                            <span>Already dropped in the safe</span>
                            <span>
                              {dr ? `UGX ${fmt(dr.dropped)} · ${dr.drops} drop${dr.drops === 1 ? '' : 's'}` : 'none'}
                            </span>
                          </p>
                        );
                      })()}
                      <label className="flex items-center justify-between gap-3 text-xs">
                        <span title="Count only what the attendant still holds. Drops above are already counted.">Cash still held (not dropped)</span>
                        <input
                          type="number"
                          min={0}
                          className="input-field w-40 text-right"
                          value={d.cash || ''}
                          placeholder="0"
                          onChange={(e) => {
                            setDecl(a.id, { cash: Number(e.target.value) });
                            setPreview(null);
                          }}
                        />
                      </label>
                      {/* (590) The most an attendant carried -- their largest drop or
                          this cash -- over the cap is flagged at close. Said here, before
                          it happens, so the supervisor can record any drop not yet entered. */}
                      {dropList && dropList.cap > 0 && (d.cash || 0) > dropList.cap && (
                        <p className="text-[11px]" style={{ color: '#F59E0B' }}>
                          ⚠ UGX {fmt(d.cash || 0)} carried since the last drop is more than the UGX {fmt(dropList.cap)} cap
                          and will be flagged. If some of it went into the safe, record that drop first.
                        </p>
                      )}
                      {channels.map((ch) => (
                        <label key={ch.code} className="flex items-center justify-between gap-3 text-xs">
                          <span>
                            {ch.name}
                            {ch.tillNumber ? ` · till ${ch.tillNumber}` : ''}
                          </span>
                          <input
                            type="number"
                            min={0}
                            className="input-field w-40 text-right"
                            value={d.tenders[ch.code] || ''}
                            placeholder="0"
                            onChange={(e) => {
                              setDecl(a.id, { tenders: { ...d.tenders, [ch.code]: Number(e.target.value) } });
                              setPreview(null);
                            }}
                          />
                        </label>
                      ))}
                      {pc && (
                        // (730) The statement, from the meters to the cash in hand. Every
                        // line is the server's, from the close it would make.
                        <div className="text-xs pt-2 border-t space-y-0.5" style={{ borderColor: 'var(--border)' }} data-statement={pc.staffId}>
                          {[
                            ['Metered (manual)', `${fmt(pc.meteredLitres, 1)} L`],
                            ['less pump tests, own use, returned to tank', `-${fmt(pc.testLitres + pc.ownUseLitres + pc.returnedLitres, 1)} L`],
                            ['= litres sold', `${fmt(pc.soldLitres, 1)} L`],
                            ['Fuel sold', `UGX ${fmt(pc.fuelValue)}`],
                            ['+ shop sales', `UGX ${fmt(pc.shopValue)}`],
                            ['- mobile money', `UGX ${fmt(pc.mobileMoney)}`],
                            ['- card and vouchers', `UGX ${fmt(pc.cardAndVouchers)}`],
                            ['- credit sales', `UGX ${fmt(pc.creditTotal)}`],
                            ['- agreed prices', `UGX ${fmt(pc.agreedPrices)}`],
                            ['- discounts', `UGX ${fmt(pc.discountTotal)}`],
                            ['- dropped in the safe', `UGX ${fmt(pc.cashDropped)}`],
                            ['= cash expected now', `UGX ${fmt(pc.expectedCash)}`],
                            ['cash counted', `UGX ${fmt(pc.cashAtClose)}`],
                          ].map(([k, v]) => (
                            <div key={k} className="flex justify-between" style={{ color: k.startsWith('=') ? 'var(--foreground)' : 'var(--muted-foreground)', fontWeight: k.startsWith('=') ? 600 : 400 }}>
                              <span>{k}</span><span className="font-mono-nums">{v}</span>
                            </div>
                          ))}
                          <div className="flex justify-between font-bold pt-1" style={{ color: pc.isBalanced ? '#22c55e' : '#ef4444' }}>
                            <span>{pc.isBalanced ? 'Balances' : pc.unallocated > 0 ? 'Short' : 'Over'}</span>
                            <span className="font-mono-nums">{pc.isBalanced ? '—' : `UGX ${fmt(Math.abs(pc.unallocated))}`}</span>
                          </div>
                        </div>
                      )}
                      {pc && !pc.isBalanced && (
                        <input
                          className="input-field text-xs"
                          placeholder="Why is this attendant short? It becomes a receivable against them."
                          value={d.shortageReason}
                          onChange={(e) => setDecl(a.id, { shortageReason: e.target.value })}
                        />
                      )}
                    </div>
                  );
                })}
                <IssueSummary issues={closeIssues} tried={closeTried} />
                <button
                  onClick={runPreview}
                  disabled={previewing || !shiftId}
                  className="w-full py-2 rounded-lg text-sm font-semibold"
                  style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  {previewing ? 'Checking against the server…' : 'Check the numbers with the server'}
                </button>
                <div className="pt-3 border-t space-y-2" style={{ borderColor: 'var(--border)' }}>
                  {[
                    { label: 'Total Mobile Money', value: totalMobileMoney, color: '#f59e0b' },
                    { label: 'Total Cash (incl. MM + Visa)', value: totalCash, color: '#22c55e' },
                    { label: 'Total Sales (incl. Credit)', value: totalSales, color: 'var(--primary)' },
                  ].map(row => (
                    <div key={row.label} className="flex justify-between items-center">
                      <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{row.label}</span>
                      <span className="text-sm font-bold font-mono-nums" style={{ color: row.color }}>UGX {fmt(row.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="ExclamationTriangleIcon" size={16} style={{ color: '#ef4444' } as React.CSSProperties} />
                <h2 className="text-sm font-semibold text-foreground">Cash Reconciliation & Shorts</h2>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { label: 'Expected (meters, net of RTT)', value: expectedFromMeters, color: 'var(--foreground)' },
                  { label: 'Actual Cash Counted', value: actualCashCounted, color: 'var(--foreground)' },
                  { label: cashShort >= 0 ? 'Cash Short' : 'Cash Over', value: Math.abs(cashShort), color: cashShort > 0 ? '#ef4444' : '#22c55e' },
                  { label: 'Total Discounts Given', value: totalDiscounts, color: '#f59e0b' },
                  { label: 'Total Expenses', value: totalExpenses, color: '#f59e0b' },
                  { label: 'Net Sales (after discounts)', value: netSales, color: '#22c55e' },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{row.label}</span>
                    <span className="text-sm font-bold font-mono-nums" style={{ color: row.color }}>UGX {fmt(row.value)}</span>
                  </div>
                ))}
                <div className="p-3 rounded-lg mt-2" style={{ backgroundColor: isShort ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)', border: `1px solid ${isShort ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}` }}>
                  <div className="flex items-center gap-2">
                    <Icon name={isShort ? 'ExclamationTriangleIcon' : 'CheckCircleIcon'} size={14} style={{ color: isShort ? '#ef4444' : '#22c55e' } as React.CSSProperties} />
                    <span className="text-xs font-semibold" style={{ color: isShort ? '#ef4444' : '#22c55e' }}>
                      {isShort ? `SHORT: UGX ${fmt(cashShort)} — Requires investigation` : 'Cash balanced — No short'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Expenses & Discounts */}
        {activeTab === 'expenses' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <Icon name="ReceiptRefundIcon" size={16} style={{ color: '#f59e0b' } as React.CSSProperties} />
                  <h2 className="text-sm font-semibold text-foreground">Shift Expenses</h2>
                </div>
                <button onClick={addExpense} className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                  <Icon name="PlusIcon" size={12} />Add
                </button>
              </div>
              <div className="p-4 space-y-3">
                {expenses.map(e => (
                  <div key={e.id} className="flex items-center gap-2">
                    <input type="text" value={e.description} onChange={ev => updateExpense(e.id, 'description', ev.target.value)} className="input-field py-1.5 px-2 text-xs flex-1 rounded-lg" placeholder="Description" />
                    <select value={e.category} onChange={ev => updateExpense(e.id, 'category', ev.target.value)} className="input-field py-1.5 px-2 text-xs w-28 rounded-lg">
                      {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input type="number" value={e.amount || ''} onChange={ev => updateExpense(e.id, 'amount', Number(ev.target.value))} className="input-field py-1.5 px-2 text-xs w-28 font-mono-nums rounded-lg" placeholder="Amount" min="0" />
                    <button onClick={() => removeExpense(e.id)} className="p-1 rounded hover:bg-muted" aria-label="Close" title="Close">
                      <Icon name="XMarkIcon" size={13} style={{ color: '#ef4444' } as React.CSSProperties} />
                    </button>
                  </div>
                ))}
                {expenses.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No expenses recorded</p>}
                <div className="flex justify-between items-center pt-2 border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs text-foreground">Total Expenses</span>
                  <span className="text-sm font-bold font-mono-nums" style={{ color: '#f59e0b' }}>UGX {fmt(totalExpenses)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <Icon name="ReceiptPercentIcon" size={16} style={{ color: '#8b5cf6' } as React.CSSProperties} />
                  <h2 className="text-sm font-semibold text-foreground">Discounts Given</h2>
                </div>
                <button onClick={addDiscount} className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
                  <Icon name="PlusIcon" size={12} />Add
                </button>
              </div>
              <div className="p-4 space-y-3">
                {discounts.map(d => (
                  <div key={d.id} className="flex items-center gap-2">
                    <input type="text" value={d.description} onChange={ev => updateDiscount(d.id, 'description', ev.target.value)} className="input-field py-1.5 px-2 text-xs flex-1 rounded-lg" placeholder="Description" />
                    <input type="number" value={d.amount || ''} onChange={ev => updateDiscount(d.id, 'amount', Number(ev.target.value))} className="input-field py-1.5 px-2 text-xs w-24 font-mono-nums rounded-lg" placeholder="Amount" min="0" />
                    <input type="text" value={d.authorisedBy} onChange={ev => updateDiscount(d.id, 'authorisedBy', ev.target.value)} className="input-field py-1.5 px-2 text-xs w-24 rounded-lg" placeholder="Auth by" />
                    <button onClick={() => removeDiscount(d.id)} className="p-1 rounded hover:bg-muted" aria-label="Close" title="Close">
                      <Icon name="XMarkIcon" size={13} style={{ color: '#ef4444' } as React.CSSProperties} />
                    </button>
                  </div>
                ))}
                {discounts.length === 0 && <p className="text-xs text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No discounts recorded</p>}
                <div className="flex justify-between items-center pt-2 border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs text-foreground">Total Discounts</span>
                  <span className="text-sm font-bold font-mono-nums" style={{ color: '#8b5cf6' }}>UGX {fmt(totalDiscounts)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab: Gain/Loss */}
        {activeTab === 'gainloss' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="ArrowTrendingUpIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                <h2 className="text-sm font-semibold text-foreground">Daily Gain / Loss Analysis</h2>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { label: 'Electronic Meter Total', value: `${fmt(totalElecSold, 1)} L`, color: 'var(--primary)' },
                  { label: 'Dipping Consumed Total', value: dipsPending ? '\u2014' : `${fmt(totalDipConsumed, 1)} L`, color: 'var(--foreground)' },
                  { label: 'Daily Gain/Loss (Volume)', value: dipsPending ? '\u2014 (dip every tank)' : `${totalGainLoss >= 0 ? '+' : ''}${fmt(totalGainLoss, 2)} L`, color: totalGainLoss >= 0 ? '#22c55e' : '#ef4444' },
                  { label: 'Daily Gain/Loss (Value)', value: dipsPending ? '\u2014' : `${totalGainLossValue < 0 ? '-' : '+'}UGX ${fmt(Math.abs(totalGainLossValue))}`, color: totalGainLossValue >= 0 ? '#22c55e' : '#ef4444' },
                ].map(row => (
                  <div key={row.label} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>{row.label}</span>
                    <span className="text-sm font-bold font-mono-nums" style={{ color: row.color }}>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
                <Icon name="ChartBarIcon" size={16} style={{ color: 'var(--primary)' } as React.CSSProperties} />
                <h2 className="text-sm font-semibold text-foreground">Gain/Loss by Fuel Grade</h2>
              </div>
              <div className="p-5 space-y-4">
                {gradeGainLoss.map(g => {
                  const gradeColor = tanks.find(t => t.grade === g.grade)?.gradeColor || '#22c55e';
                  return (
                    <div key={g.grade} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: `${gradeColor}20`, color: gradeColor }}>{g.grade}</span>
                        <span className="text-sm font-bold font-mono-nums" style={{ color: g.gl >= 0 ? '#22c55e' : '#ef4444' }}>{g.gl >= 0 ? '+' : ''}{fmt(g.gl, 2)} L</span>
                      </div>
                      <div className="flex justify-between text-xs" style={{ color: 'var(--muted-foreground)' }}>
                        <span>Elec: {fmt(g.elecTotal, 1)} L | Dip: {fmt(g.dipConsumed, 1)} L</span>
                        <span style={{ color: g.glValue >= 0 ? '#22c55e' : '#ef4444' }}>{g.glValue >= 0 ? '+' : ''}UGX {fmt(Math.abs(g.glValue))}</span>
                      </div>
                      <div className="w-full h-2 rounded-full" style={{ backgroundColor: 'var(--muted)' }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (g.dipConsumed / (g.elecTotal || 1)) * 100)}%`, backgroundColor: gradeColor }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Printable Statement */}
        <div id="shift-print-area" ref={printRef} className="hidden print:block p-8 bg-white text-black">
          <div className="text-center mb-6 border-b-2 border-black pb-4">
            <h1 className="text-xl font-bold">SHIFT CLOSURE STATEMENT</h1>
            <p className="text-sm">{(isSiteManager && assignedSite) || site} | Date: {shiftDate} | Shift: {shiftLabelCode ? shiftLabelName(shiftLabelCode) : '—'}</p>
          </div>
          <div className="mb-4">
            <h2 className="font-bold text-sm mb-2 border-b">PUMP ATTENDANT ALLOCATION</h2>
            {pumps.map(p => {
              const att = attendants.find(a => a.id === p.attendantId);
              return (
                <div key={p.id} className="flex justify-between text-xs py-0.5">
                  <span>{p.label}</span><span>{att?.name || 'Not assigned'} ({att?.badge || '—'})</span>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-8 mb-4">
            <div>
              <h2 className="font-bold text-sm mb-2 border-b">METER READINGS</h2>
              {allNozzles.map(n => (
                <div key={n.id} className="flex justify-between text-xs py-0.5">
                  <span>{n.pumpLabel} N{n.nozzleNo} ({n.grade})</span><span>{fmt(n.elecSold, 1)} L</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-bold border-t mt-1 pt-1">
                <span>TOTAL</span><span>{fmt(totalElecSold, 1)} L</span>
              </div>
            </div>
            <div>
              <h2 className="font-bold text-sm mb-2 border-b">DIPPING RECORDS</h2>
              {tankTotals.map(t => (
                <div key={t.id} className="flex justify-between text-xs py-0.5">
                  <span>{t.label}</span><span>{fmt(t.consumed, 1)} L</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-bold border-t mt-1 pt-1">
                <span>TOTAL</span><span>{fmt(totalDipConsumed, 1)} L</span>
              </div>
            </div>
          </div>
          <div className="mb-4">
            <h2 className="font-bold text-sm mb-2 border-b">SALES & PAYMENTS</h2>
            <div className="grid grid-cols-2 gap-4">
              {[['Physical Cash', cashPhysical], ['Actual Counted', actualCashCounted], ['MTN MM', mtnMM], ['Airtel Money', airtelMM], ['M-Pesa', mpesaMM], ['Visa/Card', visaAmount], ['Credit Sales', creditSales]].map(([l, v]) => (
                <div key={String(l)} className="flex justify-between text-xs py-0.5"><span>{l}</span><span>UGX {fmt(Number(v))}</span></div>
              ))}
              <div className="flex justify-between text-sm font-bold border-t pt-1 col-span-2"><span>TOTAL SALES</span><span>UGX {fmt(totalSales)}</span></div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-8 mb-4">
            <div>
              <h2 className="font-bold text-sm mb-2 border-b">EXPENSES</h2>
              {expenses.map(e => <div key={e.id} className="flex justify-between text-xs py-0.5"><span>{e.description}</span><span>UGX {fmt(e.amount)}</span></div>)}
              <div className="flex justify-between text-sm font-bold border-t mt-1 pt-1"><span>TOTAL</span><span>UGX {fmt(totalExpenses)}</span></div>
            </div>
            <div>
              <h2 className="font-bold text-sm mb-2 border-b">GAIN / LOSS</h2>
              {gradeGainLoss.map(g => <div key={g.grade} className="flex justify-between text-xs py-0.5"><span>{g.grade}</span><span>{g.gl >= 0 ? '+' : ''}{fmt(g.gl, 2)} L</span></div>)}
              <div className="flex justify-between text-xs py-0.5"><span>Cash Short</span><span>UGX {fmt(cashShort)}</span></div>
            </div>
          </div>
          <div className="mt-8 grid grid-cols-3 gap-8 text-xs">
            <div className="border-t border-black pt-2 text-center">Attendant Signature</div>
            <div className="border-t border-black pt-2 text-center">Supervisor Signature</div>
            <div className="border-t border-black pt-2 text-center">Manager Signature</div>
          </div>
        </div>
      </div>
    </>
      <PartialLoadNotice missing={partial} />
    </>
  );
}
