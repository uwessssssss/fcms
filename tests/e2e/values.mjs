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
const sql = (q) => execFileSync('psql', ['-d', process.env.PGDATABASE || 'fcms', '-X', '-At', '-F', '|', '-c', q], { encoding: 'utf8' }).trim();

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
    await shows('Credit customers', `${c.code} shows its balance`, 'UGX ' + await fmtIn(c.balance, 0, 3));
  }
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

  await tab('Trial balance');
  const tb = seen.get('/api/books/trial-balance') || [];
  check('logic', 'Trial balance', 'rows received', tb.length > 0, `${tb.length}`);
  check('logic', 'Trial balance', 'debits = credits', near(sum(tb, (r) => r.debits), sum(tb, (r) => r.credits)), `${sum(tb, (r) => r.debits).toFixed(2)} / ${sum(tb, (r) => r.credits).toFixed(2)}`);
  check('logic', 'Trial balance', 'closing balances net to zero', near(sum(tb, (r) => r.closing), 0), sum(tb, (r) => r.closing).toFixed(2));
  const bad = tb.filter((r) => !near(Number(r.opening) + Number(r.debits) - Number(r.credits), r.closing));
  check('logic', 'Trial balance', 'every row: opening + debits - credits = closing', bad.length === 0, bad.map((r) => r.code).join(' '));
  for (const r of tb.slice(0, 6)) await shows('Trial balance', `${r.code} shows its debits`, await fmtIn(r.debits, 2, 2));
  await shows('Trial balance', 'says debits equal credits', 'debits equal credits');

  await tab('Profit & loss');
  const pl = seen.get('/api/books/profit-and-loss');
  await tab('Balance sheet');
  const bs = seen.get('/api/books/balance-sheet');
  if (bs) {
    check('logic', 'Balance sheet', 'total assets = sum of asset lines', near(bs.totalAssets, sum(bs.assets, (l) => l.amount), 0.5), `${bs.totalAssets}`);
    check('logic', 'Balance sheet', 'total liabilities = sum of their lines', near(bs.totalLiabilities, sum(bs.liabilities, (l) => l.amount), 0.5));
    check('logic', 'Balance sheet', 'equity = its lines + earnings to date', near(bs.totalEquity, sum(bs.equity, (l) => l.amount) + Number(bs.earningsToDate), 0.5));
    check('logic', 'Balance sheet', 'assets = liabilities + equity', near(bs.totalAssets, Number(bs.totalLiabilities) + Number(bs.totalEquity), 0.5), `difference ${bs.difference}`);
    await shows('Balance sheet', 'shows total assets', await fmtIn(bs.totalAssets, 0, 0));
  } else check('logic', 'Balance sheet', 'received', false);
  if (pl) {
    check('logic', 'Profit & loss', 'total income = sum of income lines', near(pl.totalIncome, sum(pl.income, (l) => l.amount), 0.5));
    check('logic', 'Profit & loss', 'net profit = gross profit - expenses', near(pl.netProfit, Number(pl.grossProfit) - Number(pl.totalExpenses), 0.5), `${pl.netProfit}`);
    // The P&L on screen covers its own period; the balance sheet's earnings run
    // from the start. Same period from the API, to compare like with like.
    const token = await page.evaluate(() => sessionStorage.getItem('fcms_token'));
    const all = await (await fetch(`${API}/api/books/profit-and-loss?from=2000-01-01&to=${bs?.asOf?.slice(0, 10)}`, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': '10.30.0.2' } })).json();
    if (bs) check('logic', 'Books', 'profit since the start = the balance sheet\'s earnings to date', near(all.netProfit, bs.earningsToDate, 0.5), `${all.netProfit} vs ${bs.earningsToDate}`);
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
