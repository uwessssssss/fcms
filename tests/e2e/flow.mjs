// =============================================================================
// A shift, through the real API, as the screens drive it (730).
//
// The database tests call the SQL directly; the browser tests never close a
// shift. This runs the C# in between: open with both meters carried, a
// handover checked on both meters, a preview that shows shortages instead of
// refusing them, closes the API must refuse, a close with a reason that goes
// to the manager flagged -- and where an appointed person is placed.
//
//   API=http://localhost:5000 PASSWORD=... PGDATABASE=fcms node flow.mjs
// Run LAST: it leaves a closed shift and new people in the demo.
// =============================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'Demo-2026!';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  flow: ${name}${detail ? ' -- ' + detail : ''}`);
};
const sql = (q) => execFileSync('psql', ['-d', process.env.PGDATABASE || 'fcms', '-X', '-At', '-F', '|', '-c', q],
  { encoding: 'utf8', env: { ...process.env, PGTZ: 'Africa/Kampala' } }).trim();
const near = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) <= t;

let ip = 40;
async function signIn(employeeNo) {
  const xff = `10.40.0.${ip++}`;
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify({ employeeNo, password: PASSWORD }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${employeeNo} could not sign in: ${JSON.stringify(j)}`);
  const call = async (method, url, body) => {
    const res = await fetch(`${API}${url}`, {
      method, headers: { Authorization: 'Bearer ' + j.token, 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, code: data?.code };
  };
  return { ...j, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}) };
}

const sup = await signIn('SUP01');
const site = sup.siteId;
const tanks = sql(`SELECT id FROM tank WHERE site_id = '${site}' AND is_active ORDER BY code`).split('\n');
const [nzA, nzB] = sql(`SELECT n.id FROM nozzle n JOIN tank t ON t.id = n.tank_id
                         WHERE n.site_id = '${site}' AND n.is_active ORDER BY n.code LIMIT 2`).split('\n');
const [att1, att2, att3] = sql(`SELECT id FROM staff WHERE site_id = '${site}' AND role = 'ATTENDANT' AND is_active
                                 ORDER BY employee_no LIMIT 3`).split('\n');
const book = (t) => Number(sql(`SELECT fn_book_stock('${t}')`));
const lastClose = (nz) => sql(`SELECT volume_totalizer || '|' || electronic_totalizer FROM meter_reading
                                WHERE nozzle_id = '${nz}' AND NOT is_opening ORDER BY captured_at DESC, id DESC LIMIT 1`).split('|').map(Number);

// ---- open: no totals typed, both meters carried -------------------------------
const today = sql(`SELECT (now() AT TIME ZONE 'Africa/Kampala')::date`);
const [aManual, aElec] = lastClose(nzA);
const opened = await sup.post('/api/shifts/open', {
  label: 'MID', businessDate: today,
  openingDips: tanks.map((t) => ({ tankId: t, productLitres: book(t), waterLitres: 0 })),
  roster: [
    { nozzleId: nzA, attendantId: att1, volumeTotalizer: null, electronicTotalizer: null, photoUrl: null },
    { nozzleId: nzB, attendantId: att2, volumeTotalizer: null, electronicTotalizer: null, photoUrl: null },
  ],
});
check('a supervisor opens a shift', opened.status === 200, `${opened.status} ${opened.code ?? ''} ${opened.data?.message ?? ''}`);
const shiftId = opened.data?.shiftId;
if (!shiftId) { fs.writeFileSync('out/FLOW.json', JSON.stringify(results, null, 2)); process.exit(1); }
const openA = sql(`SELECT volume_totalizer || '|' || electronic_totalizer FROM meter_reading mr
                    JOIN nozzle_assignment na ON na.id = mr.assignment_id
                   WHERE na.shift_id = '${shiftId}' AND na.nozzle_id = '${nzA}' AND mr.is_opening`).split('|').map(Number);
check('the opening carries both meters from the last close', near(openA[0], aManual, 0.001) && near(openA[1], aElec, 0.001),
  `manual ${openA[0]} (last close ${aManual}), electronic ${openA[1]} (last close ${aElec})`);

const detail = async () => (await sup.get(`/api/shifts/${shiftId}`)).data;
let d = await detail();
const asgA = d.assignments.find((a) => a.nozzleId === nzA);
check('the shift shows both opening meters', asgA && near(asgA.openingTotalizer, aManual, 0.001) && near(asgA.openingElectronic, aElec, 0.001),
  asgA ? `${asgA.openingTotalizer} / ${asgA.openingElectronic}` : 'no assignment');

// ---- handover: both meters, within 1 L ----------------------------------------
const hand = (extra) => sup.post('/api/forecourt/handover', {
  assignmentId: asgA.id, incomingAttendantId: att3, volumeTotalizer: aManual + 20, photoUrl: null, isRollover: false, ...extra });
let r = await hand({ electronicTotalizer: null });
check('a handover without the electronic meter is refused', r.status === 422 && r.code === 'ELECTRONIC_READING_REQUIRED', `${r.status} ${r.code}`);
r = await hand({ electronicTotalizer: aElec + 22 });
check('a handover with the meters 2 L apart is refused', r.status === 422 && r.code === 'METER_PAIR_DISAGREES', `${r.status} ${r.code}`);
r = await hand({ electronicTotalizer: aElec + 20.4 });
check('a handover with the meters 0.4 L apart goes through', r.status === 200, `${r.status} ${r.code ?? ''} ${r.data?.message ?? ''}`);
d = await detail();
const asgA2 = d.assignments.find((a) => a.nozzleId === nzA && a.state === 'ACTIVE');
const asgB = d.assignments.find((a) => a.nozzleId === nzB && a.state === 'ACTIVE');
check('the incoming attendant opens on both handover readings', asgA2 && near(asgA2.openingTotalizer, aManual + 20, 0.001) && near(asgA2.openingElectronic, aElec + 20.4, 0.001),
  asgA2 ? `${asgA2.openingTotalizer} / ${asgA2.openingElectronic}` : 'none');

// ---- the close: preview, refusals, then a reasoned close ----------------------
// Twenty litres more on each nozzle; nozzle B's electronic head off by `apartB`.
const body = (apartB, reasonB, shortReason) => ({
  reason: 'SCHEDULED',
  readings: [
    { assignmentId: asgA2.id, volumeTotalizer: asgA2.openingTotalizer + 20, electronicTotalizer: asgA2.openingElectronic + 20.2,
      amountTotalizer: null, isRollover: false, photoUrl: null, evidenceReason: null, capturedAt: null, differenceReason: null },
    { assignmentId: asgB.id, volumeTotalizer: asgB.openingTotalizer + 20, electronicTotalizer: asgB.openingElectronic + 20 + apartB,
      amountTotalizer: null, isRollover: false, photoUrl: null, evidenceReason: null, capturedAt: null, differenceReason: reasonB },
  ],
  dips: tanks.map((t) => {
    const out = [nzA, nzB].filter((n) => sql(`SELECT tank_id FROM nozzle WHERE id = '${n}'`) === t).length * 20;
    const extra = sql(`SELECT tank_id FROM nozzle WHERE id = '${nzA}'`) === t ? 20 : 0;   // the first holder's 20 L
    return { tankId: t, productLitres: book(t) - out - extra, waterLitres: 0, dipMm: null, waterDipMm: null, temperatureC: null, photoUrl: null, capturedAt: null };
  }),
  cashUps: [att1, att2, att3].map((a) => ({ attendantId: a, cash: 0, tenders: [], shortageReason: shortReason, notes: null })),
});

r = await sup.post(`/api/shifts/${shiftId}/close-preview`, body(0, null, null));
check('the preview runs with nobody\'s shortage explained', r.status === 200, `${r.status} ${r.code ?? ''} ${r.data?.message ?? ''}`);
const cus = r.data?.cashUps ?? [];
check('the preview shows each attendant short, not balanced', cus.length === 3 && cus.every((c) => !c.isBalanced && c.shortageRaised > 0 && c.unallocated > 0),
  cus.map((c) => `${c.fullName}: short ${c.shortageRaised}, balanced ${c.isBalanced}`).join('; '));
check('each preview statement adds up, meters to cash', cus.length > 0 && cus.every((c) =>
  near(c.meteredLitres - c.testLitres - c.ownUseLitres - c.returnedLitres, c.soldLitres, 0.001)
  && near(c.fuelValue + c.shopValue - c.mobileMoney - c.cardAndVouchers - c.creditTotal - c.agreedPrices - c.discountTotal - c.cashDropped, c.expectedCash)
  && near(c.expectedCash - c.cashAtClose, c.shortageRaised - c.overageRaised)),
  cus.map((c) => `${c.fullName}: ${c.soldLitres} L, expects ${c.expectedCash}`).join('; '));
check('the preview left nothing behind', sql(`SELECT state FROM shift WHERE id = '${shiftId}'`) === 'OPEN');

r = await sup.post(`/api/shifts/${shiftId}/close`, body(0, null, null));
check('a close with shortages unexplained is refused', r.status === 422 && r.code === 'SHORTAGE_NEEDS_REASON', `${r.status} ${r.code}`);
r = await sup.post(`/api/shifts/${shiftId}/close`, body(3, null, 'Flow test: nothing handed in'));
check('a close with the meters 3 L apart and no reason is refused', r.status === 422 && r.code === 'METER_PAIR_DISAGREES', `${r.status} ${r.code}`);
r = await sup.post(`/api/shifts/${shiftId}/close`, body(3, 'Electronic head sticking, technician called', 'Flow test: nothing handed in'));
check('with the reasons given, it closes', r.status === 200, `${r.status} ${r.code ?? ''} ${r.data?.message ?? ''}`);
const flag = sql(`SELECT level || '|' || (detail->>'divergence') || '|' || (detail->>'reason') FROM exception_flag
                   WHERE shift_id = '${shiftId}' AND code = 'METER_DIVERGENCE'`).split('|');
check('the 3 L goes to the manager, CRITICAL, with its reason', flag[0] === 'CRITICAL' && near(flag[1], 3, 0.001) && flag[2]?.startsWith('Electronic head'), flag.join(' / '));
check('each shortage carries its reason',
  sql(`SELECT count(*) FROM staff_shortage WHERE shift_id = '${shiftId}' AND reason = 'Flow test: nothing handed in'`) === '3');

// ---- appointments: where a person is placed -----------------------------------
const ho = await signIn('HO01'); const mgr = await signIn('MGR01'); const adm = await signIn('SYSADMIN');
const depot = sql(`SELECT id FROM site WHERE kind = 'DEPOT' LIMIT 1`);
const headOffice = sql(`SELECT head_office_id FROM tenant LIMIT 1`);
const n = Date.now() % 100000;
const person = (who, role, siteId, no) => who.post('/api/v1/organisation/people',
  { siteId, employeeNo: `FLW${no}${n}`, fullName: `Flow ${role} ${no}`, role, phone: null, hiredOn: null });
const placed = (no) => sql(`SELECT site_id FROM staff WHERE employee_no = 'FLW${no}${n}'`);
r = await person(ho, 'ATTENDANT', null, 1);
check('head office must say which station', r.status === 422 && r.code === 'SITE_REQUIRED', `${r.status} ${r.code}`);
r = await person(ho, 'ATTENDANT', site, 2);
check('head office appoints to the station it names', r.status === 200 && placed(2) === site, `${r.status} ${r.code ?? ''}`);
r = await person(ho, 'AUDITOR', site, 3);
check('an auditor belongs to the head office, whatever is sent', r.status === 200 && placed(3) === headOffice, `${r.status} ${r.code ?? ''}`);
r = await person(mgr, 'ATTENDANT', depot, 4);
check('a station manager cannot appoint at another site', r.status === 403 && r.code === 'OWN_SITE_ONLY', `${r.status} ${r.code}`);
r = await person(mgr, 'ATTENDANT', null, 5);
check('a station manager appoints to their own station', r.status === 200 && placed(5) === site, `${r.status} ${r.code ?? ''}`);
r = await person(ho, 'HEAD_OFFICE', null, 6);
check('head office cannot appoint head office', r.status === 403, `${r.status} ${r.code}`);
r = await person(adm, 'HEAD_OFFICE', null, 7);
check('a system administrator appoints head office, at the head office', r.status === 200 && placed(7) === headOffice, `${r.status} ${r.code ?? ''}`);
r = await person(adm, 'DIRECTOR', site, 8);
check('nobody can appoint a director', r.status === 422 && r.code === 'NO_DIRECTOR', `${r.status} ${r.code}`);

// ---- each site sees only itself ----------------------------------------------
const dep = await signIn('DEP01');
const anyShift = sql(`SELECT s.id FROM shift s JOIN site si ON si.id = s.site_id WHERE si.kind = 'STATION' ORDER BY s.opened_at DESC LIMIT 1`);
r = await dep.get(`/api/shifts/${anyShift}/activity`);
check('a depot manager cannot read a station shift', r.status === 403, `${r.status} ${r.code ?? ''}`);
const year = new Date().getFullYear();
r = await dep.get(`/api/reports/directors?from=${year - 1}-01-01&to=${year}-12-31`);
const depName = sql(`SELECT name FROM site WHERE id = '${depot}'`);
check('the depot manager\'s pack holds only the depot', r.status === 200
  && (r.data.sites ?? []).every((x) => x.siteName === depName)
  && !(r.data.awaiting ?? []).some((x) => x.kind === 'Shortage' && x.description.includes('Nabirye')),
  `${r.status} ${(r.data?.sites ?? []).map((x) => x.siteName).join(', ')}`);
r = await ho.get(`/api/reports/directors?from=${year - 1}-01-01&to=${year}-12-31`);
check('head office\'s pack holds every site', r.status === 200 && (r.data.sites ?? []).length >= 2, `${(r.data?.sites ?? []).length} sites`);

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/FLOW.json', JSON.stringify(results, null, 2));
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} flow checks pass`);
process.exit(failed ? 1 : 0);
