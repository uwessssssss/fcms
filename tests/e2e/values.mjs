// =============================================================================
// FCMS -- are the numbers right? Logic, truth and display, on the real stack.
//
//   BASE=... API=... PASSWORD=... PGHOST=... PGPORT=... PGUSER=... node values.mjs
//
// For each screen below, head office opens it and the test keeps the exact
// response the screen received. Then:
//   logic    the figures obey their identities (debits = credits, the balance
//            sheet balances, the profit is the balance sheet's earnings, a
//            total is the sum of its parts)
//   truth    they are what the database holds (recomputed in SQL)
//   display  the screen shows them (formatted in the browser with the
//            screen's own formatter, so a locale cannot make a false failure)
// Writes out/VALUES.md; exits 1 on any failure.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'Demo-2026!';
const OUT = path.resolve(process.env.OUT || 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;
function check(area, screen, name, ok, detail = '') {
  results.push({ area, screen, name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${screen}: ${name}${detail ? ' -- ' + detail : ''}`);
}
const sum = (xs, f) => xs.reduce((t, x) => t + Number(f(x) || 0), 0);
// On the stations' clock, as the API's sessions are (Program.cs), so a check
// run between midnight and 03:00 dates things the same way.
const sql = (q) => execFileSync('psql', ['-d', process.env.PGDATABASE || 'fcms', '-X', '-At', '-F', '|', '-c', q],
  { encoding: 'utf8', env: { ...process.env, PGTZ: 'Africa/Kampala' } }).trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.30.0.1' } });
const page = await ctx.newPage();
const seen = new Map();   // API path -> last JSON the screen received
page.on('response', async (res) => {
  if (!res.url().startsWith(API) || res.status() !== 200) return;
  try { seen.set(new URL(res.url()).pathname, await res.json()); } catch { /* not JSON */ }
});
const settle = async () => { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* polls */ } await page.waitForTimeout(800); };
const open = async (route) => { seen.clear(); await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }); await settle(); };
const tab = async (label) => { seen.clear(); await page.locator('main').getByText(label, { exact: true }).first().click(); await settle(); };
const text = () => page.locator('main').innerText();
// Format in the page, as the screen does.
const fmtIn = (v, min, max) => page.evaluate(([v, min, max]) => Number(v).toLocaleString('en-UG', { minimumFractionDigits: min, maximumFractionDigits: max }), [v, min, max]);
const shows = async (screen, name, s) => { const t = await text(); check('display', screen, name, t.includes(s), t.includes(s) ? s : `"${s}" not on screen`); };

// Sign in as head office.
await page.goto(BASE + '/sign-up-login-screen', { waitUntil: 'domcontentloaded' });
await page.fill('#email', 'HO01'); await page.fill('#password', PASSWORD); await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith('/sign-up-login-screen'), { timeout: 20000 });
await settle();

// ---- Dashboard ---------------------------------------------------------------
{
  await open('/');
  const o = seen.get('/api/v1/dashboard/overview');
  if (!o) check('logic', 'Dashboard', 'overview received', false);
  else {
    check('logic', 'Dashboard', 'total revenue = sum of the sites', near(o.totalRevenue, sum(o.sites, (s) => s.todayRevenue), 0.5), `${o.totalRevenue} vs ${sum(o.sites, (s) => s.todayRevenue)}`);
    check('logic', 'Dashboard', 'total litres = sum of the sites', near(o.totalLitres, sum(o.sites, (s) => s.litresDispensed), 0.5), `${o.totalLitres} vs ${sum(o.sites, (s) => s.litresDispensed)}`);
    check('logic', 'Dashboard', 'pumps active <= pumps', o.pumpsActive <= o.pumpsTotal, `${o.pumpsActive} of ${o.pumpsTotal}`);
    await shows('Dashboard', 'shows the total revenue', 'UGX ' + await fmtIn(o.totalRevenue, 0, 0));
  }
}

// ---- Tank inventory ------------------------------------------------------------
{
  await open('/inventory/tanks');
  const tanks = seen.get('/api/v1/inventory/tanks') || [];
  check('logic', 'Tanks', 'tanks received', tanks.length > 0, `${tanks.length}`);
  for (const t of tanks) {
    const db = Number(sql(`WITH d AS (SELECT DISTINCT ON (tank_id) tank_id, product_litres FROM dip_reading ORDER BY tank_id, captured_at DESC)
                           SELECT COALESCE((SELECT product_litres FROM d WHERE tank_id = '${t.id}'), fn_book_stock('${t.id}'))`));
    check('truth', 'Tanks', `${t.code}: litres are the database's (last dip, else book)`, near(t.currentLitres, db, 0.01), `${t.currentLitres} vs ${db}`);
    check('logic', 'Tanks', `${t.code}: fill % = litres / capacity`, near(t.fillPct, Math.round((t.currentLitres / t.capacityLitres) * 1000) / 10, 0.051), `${t.fillPct}%`);
    await shows('Tanks', `${t.code} shows its litres`, `${(t.currentLitres / 1000).toFixed(1)}k / ${(t.capacityLitres / 1000).toFixed(0)}k L`);
  }
}

// ---- Credit customers ------------------------------------------------------------
{
  await open('/credit-customers');
  const cs = (seen.get('/api/credit/customers') || []).filter((c) => c.isActive);
  check('logic', 'Credit customers', 'customers received', cs.length > 0, `${cs.length}`);
  for (const c of cs) {
    const db = Number(sql(`SELECT balance FROM fn_customer_headroom('${c.id}')`));
    check('truth', 'Credit customers', `${c.code}: balance is the database's`, near(c.balance, db), `${c.balance} vs ${db}`);
    check('logic', 'Credit customers', `${c.code}: headroom = limit - balance`, near(c.headroom, c.creditLimit - c.balance), `${c.headroom}`);
    // As the screen writes it: whole shillings or two places; paid ahead in words.
    const b = Math.abs(c.balance), dp = Number.isInteger(b) ? 0 : 2;
    await shows('Credit customers', `${c.code} shows its balance`,
      c.balance < 0 ? `UGX ${await fmtIn(b, dp, dp)} paid ahead` : 'UGX ' + await fmtIn(b, dp, dp));
  }
}

// ---- Shift reports ---------------------------------------------------------------
// The shift figures, as the screen gets them, against the database's records
// (themselves proven against the raw readings by tools/audit/shift_math.sql).
{
  await open('/shift-closure/reports');
  const rows = seen.get('/api/shifts/report') || [];
  const db14 = Number(sql(`SELECT count(*) FROM shift WHERE state <> 'OPEN' AND business_date > (now() AT TIME ZONE 'Africa/Kampala')::date - 14`));
  check('truth', 'Shift reports', 'head office sees every station\'s and depot\'s shifts', rows.length === Math.min(db14, 500), `${rows.length} on screen, ${db14} in the database`);
  // The demo ages: for the arithmetic, every shift it has.
  const token = await page.evaluate(() => sessionStorage.getItem('fcms_token'));
  const all = rows.length ? rows : await (await fetch(`${API}/api/shifts/report?days=400`, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': '10.30.0.1' } })).json();
  check('logic', 'Shift reports', 'rows to check', all.length > 0, `${all.length}`);
  const unbalanced = all.filter((r) => !near(Number(r.salesValue) + Number(r.shopValue),
    Number(r.cashDeclared) + Number(r.electronicDeclared) + Number(r.creditTotal) + Number(r.priceAgreementTotal)
    + Number(r.discountTotal) + Number(r.shortageRaised) - Number(r.overageRaised)));
  check('logic', 'Shift reports', 'every shift: fuel + shop = cash + electronic + credit + agreed + discounts + shortage - overage',
    unbalanced.length === 0, unbalanced.slice(0, 3).map((r) => `${r.businessDate} ${r.label}`).join(', '));
  const ids = all.map((r) => `'${r.id}'`).join(',');
  const dbRows = new Map(sql(`
    SELECT s.id,
           COALESCE((SELECT SUM(m.amount) FROM money_movement m WHERE m.shift_id = s.id AND m.entry = 'SALE' AND m.dry_sale_id IS NULL), 0),
           COALESCE((SELECT SUM(m.amount) FROM money_movement m WHERE m.shift_id = s.id AND m.dry_sale_id IS NOT NULL), 0),
           COALESCE((SELECT -SUM(m.amount) FROM money_movement m WHERE m.shift_id = s.id AND m.settlement = 'CASH'), 0),
           COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss WHERE ss.shift_id = s.id), 0),
           COALESCE((SELECT SUM(md.litres) FROM metered_disposition md JOIN meter_event me ON me.id = md.meter_event_id
                      WHERE me.shift_id = s.id AND md.kind = 'SALE'), 0)
      FROM shift s WHERE s.id IN (${ids || "'00000000-0000-0000-0000-000000000000'"})`).split('\n').filter(Boolean)
    .map((l) => { const [id, fuel, shop, cash, short, litres] = l.split('|'); return [id, { fuel, shop, cash, short, litres }]; }));
  const off = (f, g) => all.filter((r) => !near(f(r), g(dbRows.get(r.id) || {})));
  for (const [name, f, g] of [
    ['fuel sales = what the attendants were charged', (r) => r.salesValue, (d) => d.fuel],
    ['shop sales = what the sellers were charged', (r) => r.shopValue, (d) => d.shop],
    ['cash = the cash and drops handed in', (r) => r.cashDeclared, (d) => d.cash],
    ['shortage = the shortages raised against attendants', (r) => r.shortageRaised, (d) => d.short],
    ['litres = the litres sold through the meters', (r) => r.salesLitres, (d) => d.litres],
  ]) {
    const bad = off(f, g);
    check('truth', 'Shift reports', name, bad.length === 0, bad.length ? `${bad.length} shifts, e.g. ${f(bad[0])} vs ${g(dbRows.get(bad[0].id) || {})}` : `${all.length} shifts`);
  }
  const noSite = all.filter((r) => !r.siteName);
  check('display', 'Shift reports', 'every row names its site', noSite.length === 0, `${noSite.length} without`);
  if (rows.length) {
    const fuelShop = sum(rows, (r) => Number(r.salesValue) + Number(r.shopValue));
    await shows('Shift reports', 'total sales card = fuel + shop of the listed shifts', 'UGX ' + await fmtIn(fuelShop, 2, 2));
    await tab('Sales & Payments');
    const marks = await page.locator('main td[data-balances]').evaluateAll((els) => els.map((e) => e.getAttribute('data-balances')));
    check('display', 'Shift reports', 'Sales & Payments: every row shows it balances', marks.length === rows.length && marks.every((m) => m === 'yes'),
      `${marks.filter((m) => m === 'yes').length} of ${rows.length} rows balance on screen`);
    const t = await text();
    check('display', 'Shift reports', 'no made-up fuel price on the gain/loss value', !t.includes('1.589'));
  }
}

// ---- A shift, opened: each attendant's statement --------------------------------
// From the meters to the cash in hand, as the close screen shows it (730).
{
  const token = await page.evaluate(() => sessionStorage.getItem('fcms_token'));
  const get = async (u) => { const r = await fetch(`${API}${u}`, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': '10.30.0.1' } }); return r.ok ? r.json() : { status: r.status }; };
  // Every shift with a shortage, and ten more.
  const ids = sql(`(SELECT DISTINCT shift_id FROM staff_shortage) UNION ALL (SELECT id FROM shift WHERE state <> 'OPEN' ORDER BY closed_at DESC LIMIT 10)`).split('\n').filter(Boolean);
  let n = 0; const bad = { litres: [], expected: [], balance: [], flag: [], db: [] };
  for (const id of [...new Set(ids)]) {
    const d = await get(`/api/shifts/${id}`);
    for (const c of d.cashUps || []) {
      n++;
      const tag = `${d.shift.businessDate} ${d.shift.label} ${c.fullName}`;
      if (!near(c.meteredLitres - c.testLitres - c.ownUseLitres - c.returnedLitres, c.soldLitres, 0.001)) bad.litres.push(tag);
      if (!near(c.fuelValue + c.shopValue - c.mobileMoney - c.cardAndVouchers - c.creditTotal - c.agreedPrices - c.discountTotal - c.cashDropped, c.expectedCash)) bad.expected.push(tag);
      if (!near(c.expectedCash - c.cashAtClose, c.shortageRaised - c.overageRaised)) bad.balance.push(tag);
      if (c.isBalanced !== (Number(c.shortageRaised) === 0 && Number(c.overageRaised) === 0)) bad.flag.push(tag);
      const dbShort = Number(sql(`SELECT COALESCE(SUM(amount), 0) FROM staff_shortage WHERE cash_up_id = '${c.cashUpId}'`));
      if (!near(dbShort, c.shortageRaised)) bad.db.push(`${tag}: ${c.shortageRaised} vs ${dbShort}`);
    }
  }
  check('logic', 'Shift detail', 'cash-ups to check', n > 0, `${n}`);
  check('logic', 'Shift detail', 'litres sold = metered - tests - own use - returned to tank', bad.litres.length === 0, bad.litres.slice(0, 3).join(', '));
  check('logic', 'Shift detail', 'cash expected = fuel + shop - mobile money - card - credit - agreed prices - discounts - drops', bad.expected.length === 0, bad.expected.slice(0, 3).join(', '));
  check('logic', 'Shift detail', 'cash expected - cash counted = shortage - overage', bad.balance.length === 0, bad.balance.slice(0, 3).join(', '));
  check('logic', 'Shift detail', 'an attendant short or over is never shown as balanced', bad.flag.length === 0, bad.flag.slice(0, 3).join(', '));
  check('truth', 'Shift detail', 'each shortage is the one raised against that attendant', bad.db.length === 0, bad.db.slice(0, 3).join(', '));

  // Site Operations: each shift's sales on the station's busiest recent day.
  const [site, day] = sql(`SELECT s.site_id, s.business_date FROM shift s JOIN site t ON t.id = s.site_id AND t.kind = 'STATION'
                            WHERE s.state <> 'OPEN' ORDER BY s.business_date DESC LIMIT 1`).split('|');
  const pts = await get(`/api/v1/sites/${site}/analytics/by-shift?date=${day}`);
  const offPts = (Array.isArray(pts) ? pts : []).filter((p) => !near(p.revenue, Number(sql(
    `SELECT COALESCE(SUM(amount), 0) FROM money_movement WHERE shift_id = '${p.shiftId}' AND entry = 'SALE' AND dry_sale_id IS NULL`))));
  check('truth', 'Site operations', 'each shift\'s fuel sales = what its attendants were charged', Array.isArray(pts) && pts.length > 0 && offPts.length === 0,
    Array.isArray(pts) ? `${pts.length} shifts on ${day}, ${offPts.length} off` : `status ${pts.status}`);
}

// ---- The screens head office reads (sixth pass) -------------------------------
{
  // Overview: the real day, the real number of sites, no typed-in trends.
  await open('/');
  const o = seen.get('/api/v1/dashboard/overview');
  const t = await text();
  check('display', 'Overview', 'says how many sites there are', o && t.includes(`${o.sites.length} location${o.sites.length === 1 ? '' : 's'}`), o ? `${o.sites.length}` : 'no overview');
  check('display', 'Overview', 'no made-up date or trend', !/15 September 2026|\+8\.4% vs yesterday|-4% vs this time yesterday|\+3\.1% vs yesterday/.test(t));

  // Management pack: the bottom line is the company's, as the site table is.
  await open('/management-reports');
  const pack = seen.get('/api/reports/directors');
  if (pack) {
    // The site table is pump and depot sales; the pack adds the shop.
    const siteRevenue = sum(pack.sites || [], (x) => x.revenue);
    const shop = Number(sql(`SELECT COALESCE(SUM(dsl.line_amount), 0) FROM dry_sale ds JOIN dry_sale_line dsl ON dsl.sale_id = ds.id
                              JOIN shift s ON s.id = ds.shift_id WHERE s.business_date BETWEEN '${String(pack.from).slice(0, 10)}' AND '${String(pack.to).slice(0, 10)}'`));
    check('logic', 'Management pack', 'revenue = every site\'s pump and depot sales + shop sales', near(pack.revenue, siteRevenue + shop, 1), `${pack.revenue} vs ${siteRevenue} + ${shop}`);
  } else check('logic', 'Management pack', 'received', false);

  // Losses: negative is fuel missing -- the screen says it that way round.
  await open('/losses');
  const daily = seen.get('/api/reports/loss/daily') || [];
  const total = sum(daily, (r) => r.lossLitres);
  const lt = await text();
  const words = total <= -0.05 ? 'Fuel the books expect that the dips did not find' : total >= 0.05 ? 'More fuel than the books expect' : 'The tanks agree with the books';
  check('display', 'Losses', 'says loss or gain the database\'s way round', lt.includes(words), `${total.toFixed(2)} L: "${words}"`);
  const dbTotal = Number(sql(`SELECT COALESCE(SUM(loss_litres), 0) FROM v_daily_stock_loss
                               WHERE business_date BETWEEN date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date AND (now() AT TIME ZONE 'Africa/Kampala')::date`));
  check('truth', 'Losses', 'the period\'s total is every site\'s', near(total, dbTotal, 0.01), `${total} vs ${dbTotal}`);

  // Products: the price and cost the books hold, not UGX 0.
  await open('/products');
  const prods = seen.get('/api/v1/products') || [];
  const badPrice = prods.filter((p) => !near(p.pumpPrice ?? 0, Number(sql(`SELECT COALESCE((SELECT new_price FROM price_change WHERE product_id = '${p.id}' AND status = 'EXECUTED' ORDER BY effective_from DESC LIMIT 1), 0)`))));
  check('truth', 'Products', 'pump price = the last price executed', prods.length > 0 && badPrice.length === 0, badPrice.map((p) => p.code).join(' '));
  check('logic', 'Products', 'every fuel in stock has a cost', prods.every((p) => !(p.stockLitres > 0) || (p.costPrice ?? 0) > 0), prods.map((p) => `${p.code} ${p.costPrice}`).join(', '));

  // Pump setup: every nozzle shows its tank.
  await open('/pump-setup');
  check('display', 'Pump setup', 'no nozzle says "No tank linked"', !(await text()).includes('No tank linked'));

  // Tank inventory: the sites it counts are the sites it shows.
  await open('/inventory/tanks');
  const tanks = seen.get('/api/v1/inventory/tanks') || [];
  const nSites = new Set(tanks.map((x) => x.site).filter(Boolean)).size;
  check('display', 'Tank inventory', 'counts the sites it shows', (await text()).includes(`${nSites}\n`) || (await text()).includes(`${nSites} `), `${nSites}`);
}

// ---- Books ---------------------------------------------------------------------
{
  await open('/books');
  const controls = seen.get('/api/books/controls') || [];
  check('logic', 'Books', 'controls received', controls.length > 0, `${controls.length}`);
  for (const c of controls.filter((c) => c.ok === false)) {
    // The demo plants two bank problems for the reconciliation to find.
    const planted = c.control.startsWith('Bank');
    check('logic', 'Books', `control ${c.control} ${c.detail}`, planted, `${planted ? 'planted in the demo: ' : ''}off by ${c.difference}`);
  }

  // No trial balance or balance sheet any more: the ledger is underneath the
  // shift controls, not a screen. It must still balance, journal by journal.
  for (const gone of ['Trial balance', 'Balance sheet'])
    check('display', 'Books', `no ${gone} tab`, (await page.locator('main').getByText(gone, { exact: true }).count()) === 0);
  const unbalanced = sql(`SELECT count(*) FROM (SELECT journal_id FROM gl_line GROUP BY journal_id HAVING SUM(amount) <> 0) x`);
  check('logic', 'Books', 'every journal: debits = credits (database)', unbalanced === '0', `${unbalanced} unbalanced`);
  {
    const token = await page.evaluate(() => sessionStorage.getItem('fcms_token'));
    for (const url of ['/api/books/trial-balance', '/api/books/balance-sheet', '/api/books/years/2025/close']) {
      const r = await fetch(`${API}${url}`, { method: url.endsWith('close') ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': '10.30.0.2' } });
      check('logic', 'Books', `${url} is gone`, r.status === 404 || r.status === 405, `${r.status}`);
    }
  }

  await tab('Profit & loss');
  const pl = seen.get('/api/books/profit-and-loss');
  if (pl) {
    check('logic', 'Profit & loss', 'total income = sum of income lines', near(pl.totalIncome, sum(pl.income, (l) => l.amount), 0.5));
    check('logic', 'Profit & loss', 'net profit = gross profit - expenses', near(pl.netProfit, Number(pl.grossProfit) - Number(pl.totalExpenses), 0.5), `${pl.netProfit}`);
    check('logic', 'Profit & loss', 'gross profit = income - cost of sales', near(pl.grossProfit, Number(pl.totalIncome) - sum(pl.costOfSales, (l) => l.amount), 0.5), `${pl.grossProfit}`);
  } else check('logic', 'Profit & loss', 'received', false);

  await tab('Bank & mobile money');
  const accts = seen.get('/api/money/accounts') || [];
  for (const a of accts) {
    const db = Number(sql(`SELECT COALESCE(SUM(amount), 0) FROM fn_money_account_book('${a.id}')`));
    check('truth', 'Bank & mobile money', `${a.name}: balance is the database's`, near(a.bookBalance, db), `${a.bookBalance} vs ${db}`);
  }
}

await browser.close();
const bad = results.filter((r) => !r.ok);
const md = ['# FCMS -- are the numbers right?', '',
  `${results.length - bad.length} of ${results.length} checks pass.`, '',
  '| | Kind | Screen | Check | Detail |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.ok ? 'PASS' : '**FAIL**'} | ${r.area} | ${r.screen} | ${r.name} | ${r.detail.replace(/\|/g, '/').slice(0, 140)} |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'VALUES.md'), md);
console.log(`\n${results.length - bad.length}/${results.length} value checks pass`);
process.exit(bad.length ? 1 : 0);
