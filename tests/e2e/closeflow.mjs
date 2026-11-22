// =============================================================================
// A shift opened, handed over and closed THROUGH THE SCREENS, as a supervisor.
//
// Shift Operations: open with no totals typed (both meters carried), hand a
// nozzle over on both meters. Shift Closure: both closing meters, the dips,
// "check with the server", hand in exactly the cash each statement expects,
// close. Then the database must hold a balanced close.
//
//   BASE=... API=... PASSWORD=... PGDATABASE=fcms node closeflow.mjs
// Run after e2e.mjs and values.mjs (it closes a shift in the demo).
// =============================================================================
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'Demo-2026!';
const OUT = path.resolve(process.env.OUT || 'out');
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  close screen: ${name}${detail ? ' -- ' + detail : ''}`);
};
const sql = (q) => execFileSync('psql', ['-d', process.env.PGDATABASE || 'fcms', '-X', '-At', '-F', '|', '-c', q],
  { encoding: 'utf8', env: { ...process.env, PGTZ: 'Africa/Kampala' } }).trim();
const num = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.50.0.1' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const settle = async () => { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* polls */ } await page.waitForTimeout(700); };
const shot = (n) => page.screenshot({ path: path.join(OUT, `shots/close-flow-${n}.png`), fullPage: true }).catch(() => {});
const toast = async (re) => { try { await page.getByText(re).first().waitFor({ timeout: 15000 }); return true; } catch { return false; } };

try {
  await page.goto(BASE + '/sign-up-login-screen', { waitUntil: 'domcontentloaded' });
  await page.fill('#email', 'SUP01'); await page.fill('#password', PASSWORD); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-up-login-screen'), { timeout: 20000 });

  const site = sql(`SELECT site_id FROM staff WHERE employee_no = 'SUP01'`);
  const tanks = sql(`SELECT id || '|' || code FROM tank WHERE site_id = '${site}' AND is_active ORDER BY code`).split('\n').map((l) => l.split('|'));
  const lastDip = (t) => Number(sql(`SELECT round(product_litres, 1) FROM dip_reading WHERE tank_id = '${t}' AND context = 'SHIFT_CLOSE' ORDER BY captured_at DESC, id DESC LIMIT 1`));
  const atts = sql(`SELECT id FROM staff WHERE site_id = '${site}' AND role = 'ATTENDANT' AND is_active ORDER BY employee_no LIMIT 3`).split('\n');

  // ---- open -------------------------------------------------------------------
  await page.goto(BASE + '/shift-operations', { waitUntil: 'domcontentloaded' }); await settle();
  check('Shift Operations offers to open a shift', await page.getByText('Open a shift', { exact: true }).count() > 0);
  await page.getByLabel('Which shift').selectOption('NIGHT');
  for (const [id, code] of tanks) {
    // What is in the ground: the tank's last closing dip, as a supervisor dips it.
    await page.locator('label', { hasText: code }).locator('input[type="number"]').first().fill(String(lastDip(id)));
  }
  const rosterSelects = page.locator('select', { has: page.locator('option', { hasText: 'Nobody' }) });
  await rosterSelects.nth(0).selectOption(atts[0]);
  await rosterSelects.nth(1).selectOption(atts[1]);
  await shot('1-open-filled');
  await page.getByRole('button', { name: 'Open the shift' }).click();
  check('the shift opens with no meter totals typed', await toast(/shift open since/i), errors.slice(-1)[0] || '');
  await settle(); await shot('2-opened');
  const shiftId = sql(`SELECT id FROM shift WHERE site_id = '${site}' AND state = 'OPEN'`);
  check('both meters were carried into the opening', sql(`SELECT count(*) FROM meter_reading WHERE shift_id = '${shiftId}' AND is_opening AND electronic_totalizer IS NULL`) === '0');

  // ---- hand over --------------------------------------------------------------
  const [asgA, openManual, openElec, nzA] = sql(`SELECT na.id || '|' || mr.volume_totalizer || '|' || mr.electronic_totalizer || '|' || na.nozzle_id
      FROM nozzle_assignment na JOIN meter_reading mr ON mr.assignment_id = na.id AND mr.is_opening
      JOIN nozzle n ON n.id = na.nozzle_id WHERE na.shift_id = '${shiftId}' ORDER BY n.code LIMIT 1`).split('|');
  await page.locator('select', { has: page.locator('option', { hasText: 'Who is handing over...' }) }).selectOption(asgA);
  await page.locator('select', { has: page.locator('option', { hasText: 'Taking over...' }) }).selectOption(atts[2]);
  await page.getByPlaceholder('Manual meter at handover').fill((Number(openManual) + 15).toFixed(1));
  await page.getByPlaceholder('Electronic meter at handover').fill((Number(openElec) + 15.2).toFixed(2));   // as typed off the head: two places
  await shot('3-handover-filled');
  const handReply = page.waitForResponse((r) => r.url().includes('/api/forecourt/handover'), { timeout: 15000 })
    .then(async (r) => `${r.status()} ${(await r.text()).slice(0, 200)}`).catch(() => 'no request was sent');
  await page.getByRole('button', { name: 'Record handover' }).click();
  const handOk = await toast(/Handover recorded/i);
  await shot('3b-handover-result');
  check('the handover is recorded on both meters', handOk, handOk ? '' : await handReply);
  await settle();

  // ---- close: meters ----------------------------------------------------------
  await page.goto(BASE + '/shift-closure', { waitUntil: 'domcontentloaded' }); await settle();
  const rows = page.locator('main table tbody tr', { has: page.locator('input[type="number"]') });
  const nRows = await rows.count();
  check('the close lists every nozzle held now', nRows === 2, `${nRows} rows`);
  for (let i = 0; i < nRows; i++) {
    const cells = rows.nth(i).locator('td');
    const oe = num(await cells.nth(3).innerText()), om = num(await cells.nth(6).innerText());
    await cells.nth(4).locator('input').fill(String(Math.round((oe + 15.3) * 100) / 100));
    await cells.nth(7).locator('input').fill(String(om + 15));
  }
  await page.waitForTimeout(300);
  const badges = await rows.locator('td').nth(9).allInnerTexts().catch(() => []);
  const firstBadge = nRows ? await rows.nth(0).locator('td').nth(9).innerText() : '';
  check('the meter difference shows on screen, inside 1 L', /\+0\.30\s*L/.test(firstBadge), firstBadge || badges.join(','));
  await shot('4-meters');

  // ---- close: dips --------------------------------------------------------------
  await page.getByRole('button', { name: 'Dippings' }).click(); await settle();
  for (const [id, code] of tanks) {
    const out = Number(sql(`SELECT COALESCE(SUM(15), 0) FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
                              WHERE na.shift_id = '${shiftId}' AND n.tank_id = '${id}'`));   // 15 L per holding
    const dip = Math.round((lastDip(id) - out) * 10) / 10;   // the ground, less what the meters let out
    await page.locator('main tr', { hasText: code }).locator('input[type="number"]').first().fill(String(dip));
  }
  await shot('5-dips');

  // ---- close: cash --------------------------------------------------------------
  await page.getByRole('button', { name: 'Sales & Payments' }).click(); await settle();
  const names = sql(`SELECT string_agg(full_name, '|' ORDER BY full_name) FROM staff WHERE id IN ('${atts.join("','")}')`).split('|');
  const card = (name) => page.locator('main div.rounded-lg.border.p-3', { hasText: name }).first();
  for (const nm of names) await card(nm).getByLabel(/Cash still held/).fill('0');
  await page.getByRole('button', { name: 'Check the numbers with the server' }).click(); await settle();
  const expected = {};
  for (const nm of names) {
    const st = card(nm).locator('[data-statement]');
    const line = st.locator('div', { hasText: '= cash expected now' }).last();
    expected[nm] = (await line.count()) ? num((await line.innerText()).split('now')[1]) : NaN;
  }
  check('each attendant\'s statement shows the cash expected', names.every((n) => Number.isFinite(expected[n]) && expected[n] > 0),
    names.map((n) => `${n}: ${expected[n]}`).join('; '));
  check('handing in nothing reads as short, not balanced', await page.locator('main [data-statement]', { hasText: 'Short' }).count() === names.length);
  await shot('6-statements-short');
  for (const nm of names) await card(nm).getByLabel(/Cash still held/).fill(String(expected[nm]));
  await page.getByRole('button', { name: 'Check the numbers with the server' }).click(); await settle();
  const balanced = await page.locator('main [data-statement]', { hasText: 'Balances' }).count();
  check('handing in exactly the expected cash balances every attendant', balanced === names.length, `${balanced} of ${names.length}`);
  await shot('7-statements-balanced');

  // ---- close ----------------------------------------------------------------------
  await page.getByRole('button', { name: 'Close Shift' }).first().click();
  await page.waitForTimeout(500);
  const confirm = page.getByRole('button', { name: 'Close Shift' }).last();
  await confirm.click();
  await page.waitForTimeout(4000); await settle(); await shot('8-closed');
  const state = sql(`SELECT state FROM shift WHERE id = '${shiftId}'`);
  check('the shift closes from the screen', state === 'DECLARED', state);
  check('nobody is short or over', sql(`SELECT count(*) FROM money_movement WHERE shift_id = '${shiftId}' AND settlement IN ('SHORTAGE','OVERAGE')`) === '0');
  const div = sql(`SELECT string_agg(divergence_litres::text, ',' ORDER BY id) FROM meter_event WHERE shift_id = '${shiftId}'`);
  check('every holding records both meters, within 1 L', div.split(',').length === 3 && div.split(',').every((x) => Math.abs(Number(x)) <= 1), div);
  check('no screen crashed on the way', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('the close flow ran to the end', false, e.message.split('\n')[0]);
  await shot('9-stopped');
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'CLOSEFLOW.json'), JSON.stringify(results, null, 2));
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} close-screen checks pass`);
process.exit(failed ? 1 : 0);
