// =============================================================================
// FCMS end-to-end: the real web app against the real API and database.
//
//   BASE=http://localhost:3000 API=http://localhost:5000 PASSWORD=... node e2e.mjs
//
// 1. The API on its own: health, sign-in required, wrong password, attendants
//    have no sign-in, a good sign-in, the token works.
// 2. The browser: signed out is sent to sign-in; a wrong password says so; then
//    every role signs in and opens every screen its sidebar offers (head office
//    opens every screen there is, and every tab). On each screen it records
//    crashes, console errors, failed API calls and error messages on the page,
//    and takes a screenshot.
// 3. Sign-out, and a password change end to end (change, sign out, sign in
//    with the new one).
//
// Writes out/report.json, out/REPORT.md and out/shots/*.png. Exits 1 if any
// screen crashed, any API call failed with 5xx or an unexpected 401, or a check
// in 1 or 3 failed. A 403 is recorded (the role may not do that), not failed.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'Demo-2026!';
const NEW_PASSWORD = process.env.NEW_PASSWORD || 'Changed-2026!x';
const SKIP_API = process.env.SKIP_API === '1';          // dry runs against a mock
const OUT = path.resolve(process.env.OUT || 'out');
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const USERS = (process.env.USERS || 'HO01,SYSADMIN,DIR01,AUD01,MGR01,SUP01,ACC01,DEP01').split(',');
const CHANGE_PW_USER = process.env.CHANGE_PW_USER || 'SUP02';
const ALL_ROUTES = fs.readFileSync(new URL('./routes.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const TABS = {   // screen -> tab labels, opened by head office
  '/books': ['Bank & mobile money', 'Receivables', 'Trial balance', 'Profit & loss', 'Balance sheet', 'Journals', 'Account ledger'],
  '/shift-closure': ['Attendants', 'Dippings', 'Sales & Payments', 'Expenses & Discounts', 'Gain / Loss'],
  '/shift-closure/reports': ['Gain / Loss', 'Sales & Payments', 'Variances', 'Statement'],
  '/administration': ['Payment channels', 'Tank calibration', 'Depot'],
  '/management-reports': ['Loss trend', 'Attendants', 'Stock card', 'Depot vs station', 'Duty periods', 'By shift'],
  '/credit-customers': ['Transactions'],
  '/stock-counts': ['Shop and lubricants', 'Adjustments'],
  '/payments': ['Provider Summary'],
  '/losses': ['Meter divergence'],
  '/full-reports': ['Daily Statement', 'Weekly Summary', 'Monthly Report', 'Shift Reports', 'Gain / Loss', 'Stock Movement',
    'Dipping Report', 'Expenses Report', 'Credit Statement', 'Payments Breakdown', 'Variances Report', 'Pump Performance'],
};
const ERROR_TEXT = /Something went wrong|Application error|Unhandled Runtime Error|Cannot read properties|is not a function|undefined is not|NaN|Invalid Date|\[object Object\]/;

// What each screen expects of each call (contracts.cjs). A field a screen
// reads that the API does not send is a blank or broken field on screen.
const CONTRACTS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.env.CONTRACTS || 'contracts.json'), 'utf8')).map((c) => ({
      ...c, re: new RegExp('^' + c.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/(\{\})+/g, '[^/]+') + '$'),
      lit: c.path.replace(/\{\}/g, '').length,
    }));
  } catch { return []; }
})();
const contractFaults = new Map();   // key -> { call, file, type, missing }
function checkContract(apiPath, body) {
  for (const c of CONTRACTS) {
    if (!c.re.test(apiPath)) continue;
    const rows = c.array ? (Array.isArray(body) ? body.slice(0, 5) : null) : [body];
    if (!rows) { contractFaults.set(`${apiPath}|${c.file}|shape`, { call: apiPath, file: c.file, type: c.type, missing: ['(expected a list)'] }); continue; }
    const missing = new Set();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      for (const k of c.required) if (!(k in r)) missing.add(k);
      for (const [k, sub] of Object.entries(c.nested || {})) for (const e of (Array.isArray(r[k]) ? r[k].slice(0, 5) : [])) {
        if (e && typeof e === 'object') for (const kk of sub.required) if (!(kk in e)) missing.add(`${k}[].${kk}`);
      }
    }
    if (missing.size) contractFaults.set(`${c.re}|${c.file}`, { call: c.path, file: c.file, type: c.type, missing: [...missing].sort() });
  }
}

const checks = [];      // { area, name, ok, detail }
const pages = [];       // { user, route, tab, ok, issues[], forbidden[], shot }
const check = (area, name, ok, detail = '') => { checks.push({ area, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${area}: ${name}${detail ? ' -- ' + detail : ''}`); };

// ---- 1. the API on its own --------------------------------------------------
// Sign-in is limited to 10 tries per 5 minutes per address. The API runs here
// with Proxy__TrustForwardedFor=true (as behind Caddy), so each simulated person
// comes from an address of their own; the limit itself is checked on purpose.
let ipSeq = 10;
const nextIp = () => `10.20.0.${ipSeq++}`;

async function apiChecks() {
  let ip = nextIp();
  const j = async (method, p, body, token) => {
    const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch { /* empty */ }
    return { status: r.status, data };
  };
  let r = await j('GET', '/health');
  check('api', 'GET /health answers 200', r.status === 200, String(r.status));
  r = await j('GET', '/api/auth/me');
  check('api', 'who am I, signed out: 401', r.status === 401, String(r.status));
  r = await j('GET', '/api/books/controls');
  check('api', 'the books, signed out: 401', r.status === 401, String(r.status));
  r = await j('GET', '/api/v1/dashboard/overview');
  check('api', 'the dashboard, signed out: 401', r.status === 401, String(r.status));
  r = await j('POST', '/api/auth/login', { employeeNo: 'HO01', password: 'wrong-password' });
  check('api', 'wrong password: 401 INVALID_CREDENTIALS', r.status === 401 && JSON.stringify(r.data).includes('INVALID_CREDENTIALS'), `${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  r = await j('POST', '/api/auth/login', { employeeNo: 'NOBODY99', password: PASSWORD });
  check('api', 'unknown employee: the same 401 (no enumeration)', r.status === 401 && JSON.stringify(r.data).includes('INVALID_CREDENTIALS'), String(r.status));
  r = await j('POST', '/api/auth/login', { employeeNo: 'ATT01', password: PASSWORD });
  check('api', 'an attendant has no sign-in', r.status === 401, String(r.status));
  r = await j('POST', '/api/auth/login', { employeeNo: 'HO01', password: PASSWORD });
  const token = r.data?.token;
  check('api', 'head office signs in', r.status === 200 && !!token, String(r.status));
  if (token) {
    r = await j('GET', '/api/auth/me', null, token);
    check('api', 'the token works: role HEAD_OFFICE', r.status === 200 && r.data?.role === 'HEAD_OFFICE', `${r.status} ${r.data?.role}`);
    r = await j('GET', '/api/auth/me', null, token.slice(0, -4) + 'AAAA');
    check('api', 'a tampered token is refused', r.status === 401, String(r.status));
  }
  ip = nextIp();
  r = await j('POST', '/api/auth/login', { employeeNo: 'SUP01', password: PASSWORD });
  if (r.data?.token) {
    const b = await j('GET', '/api/books/controls', null, r.data.token);
    check('api', 'a supervisor is refused the books (403)', b.status === 403, String(b.status));
  }
  // The limit: from one address, the 11th try in five minutes is refused.
  ip = nextIp();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await j('POST', '/api/auth/login', { employeeNo: 'NOBODY99', password: 'x' })).status);
  check('api', 'sign-in is rate-limited: the 11th try from one address gets 429', codes[10] === 429 && codes.slice(0, 10).every((c) => c === 401), codes.join(','));
  // ...and another address is not held up by it.
  ip = nextIp();
  r = await j('POST', '/api/auth/login', { employeeNo: 'HO01', password: PASSWORD });
  check('api', 'another address still signs in', r.status === 200, String(r.status));
}

// ---- 2. the browser -----------------------------------------------------------
async function watch(page) {
  const log = { errors: [], api: [], failed: [] };
  page.on('pageerror', (e) => log.errors.push('crash: ' + e.message.split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url || '';
    // A refused API call is judged by its status below (403 is a role's
    // limit, not a fault); the browser's own echo of it is not counted twice.
    if (/Failed to load resource/.test(m.text()) && where.startsWith(API)) return;
    log.errors.push('console: ' + m.text().slice(0, 200) + (where ? ` @ ${where.replace(API, '').replace(BASE, '')}` : ''));
  });
  page.on('requestfailed', (q) => {
    // ERR_ABORTED: the test moved on to the next screen mid-request.
    if (q.url().startsWith(API) && q.failure()?.errorText !== 'net::ERR_ABORTED') log.failed.push(`${q.method()} ${q.url().replace(API, '')} ${q.failure()?.errorText}`);
  });
  page.on('response', async (res) => {
    if (!res.url().startsWith(API)) return;
    if (res.status() < 300 && res.request().method() === 'GET') {
      try { checkContract(new URL(res.url()).pathname, await res.json()); } catch { /* not JSON */ }
      return;
    }
    if (res.status() < 400) return;
    let body = ''; try { body = (await res.text()).slice(0, 160); } catch { /* gone */ }
    log.api.push({ status: res.status(), call: `${res.request().method()} ${res.url().replace(API, '').split('?')[0]}`, body });
  });
  return log;
}
const safe = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'home';

async function settle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* long polls */ }
  await page.waitForTimeout(800);
}

async function signIn(page, user, password = PASSWORD) {
  await page.goto(BASE + '/sign-up-login-screen', { waitUntil: 'domcontentloaded' });
  await page.fill('#email', user);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-up-login-screen'), { timeout: 20000 });
  await settle(page);
  return new URL(page.url()).pathname.replace(/\/$/, '') || '/';
}

async function visit(page, log, user, route, tab) {
  const start = { e: log.errors.length, a: log.api.length, f: log.failed.length };
  if (!tab) await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  else {
    const inMain = page.locator('main').getByText(tab, { exact: true });
    const target = (await inMain.count()) ? inMain.first() : page.getByText(tab, { exact: true }).first();
    try { await target.click({ timeout: 5000 }); } catch { log.errors.push(`tab "${tab}" not found or not clickable`); }
  }
  await settle(page);
  const text = await page.locator('body').innerText().catch(() => '');
  const issues = [...log.errors.slice(start.e), ...log.failed.slice(start.f)];
  const m = text.match(ERROR_TEXT); if (m) issues.push(`on screen: "${m[0]}" near "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"`);
  const forbidden = [];
  for (const a of log.api.slice(start.a)) {
    if (a.status === 403) forbidden.push(`${a.call} 403`);
    else if (a.status === 404 && /UNKNOWN|NOT_FOUND|No such/i.test(a.body)) forbidden.push(`${a.call} 404 (nothing there)`);
    else issues.push(`${a.call} ${a.status} ${a.body}`);
  }
  const landed = new URL(page.url()).pathname;
  if (!tab && landed.startsWith('/sign-up-login-screen')) issues.push('sent back to sign-in');
  const shot = `shots/${safe(user)}__${safe(route)}${tab ? '__' + safe(tab) : ''}.png`;
  await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
  pages.push({ user, route, tab: tab || '', ok: issues.length === 0, issues, forbidden, shot });
  console.log(`${issues.length ? 'ISSUE' : 'ok   '} ${user} ${route}${tab ? ' > ' + tab : ''}${issues.length ? ' :: ' + issues.slice(0, 2).join(' | ') : ''}${forbidden.length ? ' [refused: ' + [...new Set(forbidden)].join(', ') + ']' : ''}`);
}

async function browserChecks(browser) {
  // Signed out
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': nextIp() } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await settle(page);
    check('browser', 'signed out, the dashboard sends you to sign-in', new URL(page.url()).pathname.startsWith('/sign-up-login-screen'), page.url());
    await page.screenshot({ path: path.join(OUT, 'shots/00-signed-out.png'), fullPage: true });
    await page.goto(BASE + '/sign-up-login-screen', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', 'HO01');
    await page.fill('#password', 'wrong-password');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
    const t = await page.locator('body').innerText();
    check('browser', 'a wrong password says so, and stays on sign-in', /do not match/i.test(t) && new URL(page.url()).pathname.startsWith('/sign-up-login-screen'), t.match(/[^\n]*(match|wrong|invalid)[^\n]*/i)?.[0] || '');
    await page.screenshot({ path: path.join(OUT, 'shots/01-wrong-password.png'), fullPage: true });
    await ctx.close();
  }

  for (const user of USERS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': nextIp() } });
    const page = await ctx.newPage();
    const log = await watch(page);
    let landed;
    try { landed = await signIn(page, user); }
    catch (e) {
      const said = (await page.locator('body').innerText().catch(() => '')).match(/[^\n]*(not right|do not match|locked|too many|wait|error|refused|change)[^\n]*/i)?.[0] || '';
      await page.screenshot({ path: path.join(OUT, `shots/signin-failed-${safe(user)}.png`), fullPage: true }).catch(() => {});
      check('browser', `${user} signs in`, false, `${e.message.split('\n')[0]} | at ${new URL(page.url()).pathname} | screen says: ${said}`);
      await ctx.close(); continue;
    }
    // The demo turns "change it at first sign-in" off; a fresh install sends
    // the person to /change-password first, which has no sidebar.
    // Company roles land on the dashboard; a station's people on their site.
    const home = ['HO01', 'SYSADMIN', 'DIR01', 'AUD01'].includes(user) ? '/' : '/site-operations-detail';
    check('browser', `${user} signs in and lands on ${home}`, landed === home, landed);
    if (landed !== home) { await page.goto(BASE + home, { waitUntil: 'domcontentloaded' }); await settle(page); }
    // The screens this role's sidebar offers; head office opens them all.
    const offered = await page.$$eval('aside a[href^="/"], nav a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
    const routes = user === 'HO01' ? [...new Set([...offered, ...ALL_ROUTES])] : offered;
    check('browser', `${user}'s sidebar offers screens`, offered.length > 0, `${offered.length}: ${offered.join(' ')}`);
    for (const route of routes) {
      if (route.startsWith('/sign-up-login-screen') || route === '/change-password') continue;
      await visit(page, log, user, route);
      if (user === 'HO01' && TABS[route]) {
        // No tab at all is the screen having nothing to show (Shift Closure
        // with no open shift at head office); some missing is a fault.
        const present = [];
        for (const t of TABS[route]) if (await page.locator('main').getByText(t, { exact: true }).count()) present.push(t);
        if (!present.length) { console.log(`note  ${user} ${route}: no tabs shown (nothing open here)`); continue; }
        for (const tab of TABS[route]) await visit(page, log, user, route, tab);
      }
    }
    // Sign out
    // On a phone, Sign out is in the drawer: open the menu first.
    const menu = page.getByLabel('Open the menu');
    if (await menu.isVisible().catch(() => false)) { await menu.click(); await page.waitForTimeout(400); }
    const out = page.getByText('Sign out', { exact: true }).first();
    if (await out.count()) {
      await out.click();
      await settle(page);
      const back = new URL(page.url()).pathname.startsWith('/sign-up-login-screen');
      await page.goto(BASE + '/books', { waitUntil: 'domcontentloaded' });
      await settle(page);
      check('browser', `${user} signs out, and the books then send to sign-in`, back && new URL(page.url()).pathname.startsWith('/sign-up-login-screen'), page.url());
    } else check('browser', `${user} has a Sign out button`, false);
    await ctx.close();
  }
}

// ---- 3. a password change, end to end ------------------------------------------
async function passwordChange(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': nextIp() } });
  const page = await ctx.newPage();
  try {
    await signIn(page, CHANGE_PW_USER);
    await page.goto(BASE + '/change-password', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const inputs = page.locator('input[type="password"]');
    const n = await inputs.count();
    if (n < 2) throw new Error(`the change-password screen has ${n} password boxes`);
    if (n >= 3) { await inputs.nth(0).fill(PASSWORD); await inputs.nth(1).fill(NEW_PASSWORD); await inputs.nth(2).fill(NEW_PASSWORD); }
    else { await inputs.nth(0).fill(NEW_PASSWORD); await inputs.nth(1).fill(NEW_PASSWORD); }
    await page.screenshot({ path: path.join(OUT, 'shots/02-change-password-filled.png'), fullPage: true });
    await page.getByRole('button', { name: 'Set my password' }).click();
    await page.waitForTimeout(3000);
    const after = new URL(page.url()).pathname.replace(/\/$/, '') || '/';
    const msg = (await page.locator('body').innerText()).match(/[^\n]*(password|characters|same)[^\n]*/i)?.[0] || '';
    // A supervisor's home is their site; head office's the dashboard.
    check('password', 'Set my password goes on to the home screen', ['/', '/site-operations-detail'].includes(after), `${after} ${msg}`);
    await page.screenshot({ path: path.join(OUT, 'shots/03-change-password-done.png'), fullPage: true });
    if (!SKIP_API) {
      const pip = nextIp();
      const oldR = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': pip },
        body: JSON.stringify({ employeeNo: CHANGE_PW_USER, password: PASSWORD }) });
      const newR = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': pip },
        body: JSON.stringify({ employeeNo: CHANGE_PW_USER, password: NEW_PASSWORD }) });
      check('password', 'after a change the old password is refused', oldR.status === 401, String(oldR.status));
      check('password', 'and the new one signs in', newR.status === 200, String(newR.status));
    }
  } catch (e) { check('password', 'change password end to end', false, e.message.split('\n')[0]); }
  await ctx.close();
}

// ---- run ---------------------------------------------------------------------
// Local dry runs against the mock screens: MOCK_ROLE makes the mock sign in
// as a station role; VIEWPORT=390x844 checks phone width.
const [VW, VH] = (process.env.VIEWPORT || '1440x900').split('x').map(Number);
const browser0 = await chromium.launch();
const browser = {
  newContext: async (o = {}) => {
    const ctx = await browser0.newContext({ ...o, viewport: { width: VW, height: VH } });
    if (process.env.MOCK_ROLE) await ctx.addInitScript((r) => { try { localStorage.setItem('mock_role', r); } catch { /* none */ } }, process.env.MOCK_ROLE);
    return ctx;
  },
  close: () => browser0.close(),
};
if (!SKIP_API) await apiChecks();
await browserChecks(browser);
await passwordChange(browser);
await browser.close();

const faults = [...contractFaults.values()];
check('fields', `every response has the fields its screen reads (${CONTRACTS.length} contracts)`, CONTRACTS.length > 0 && faults.length === 0,
  faults.length ? `${faults.length} mismatch(es)` : '');
for (const f of faults) console.log(`FIELDS ${f.call} -> ${f.type} (${f.file}): missing ${f.missing.join(', ')}`);
const badPages = pages.filter((p) => !p.ok);
const badChecks = checks.filter((c) => !c.ok);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, pages }, null, 1));
const md = [
  '# FCMS end-to-end', '',
  `${checks.length - badChecks.length} of ${checks.length} checks pass; ${pages.length - badPages.length} of ${pages.length} screens clean.`, '',
  '## Checks', '', '| | Area | Check | Detail |', '|---|---|---|---|',
  ...checks.map((c) => `| ${c.ok ? 'PASS' : '**FAIL**'} | ${c.area} | ${c.name} | ${String(c.detail).replace(/\|/g, '/').slice(0, 160)} |`), '',
  '## Fields a screen reads that the API does not send', '',
  ...(faults.length ? faults.map((f) => `- \`${f.call}\` -> ${f.type} (${f.file}): **${f.missing.join(', ')}**`) : ['None.']), '',
  '## Screens with issues', '',
  ...(badPages.length ? badPages.map((p) => `- **${p.user} ${p.route}${p.tab ? ' > ' + p.tab : ''}**: ${p.issues.map((i) => i.replace(/\|/g, '/')).join('; ')}`) : ['None.']), '',
  '## Refused by role (403), for information', '',
  ...[...new Set(pages.flatMap((p) => p.forbidden.map((f) => `${p.user}: ${f}`)))].map((f) => `- ${f}`), '',
  '## Every screen', '', '| User | Screen | Result |', '|---|---|---|',
  ...pages.map((p) => `| ${p.user} | ${p.route}${p.tab ? ' > ' + p.tab : ''} | ${p.ok ? 'clean' : 'ISSUES'} |`),
].join('\n');
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
console.log(`\n${checks.length - badChecks.length}/${checks.length} checks, ${pages.length - badPages.length}/${pages.length} screens clean`);
process.exit(badChecks.length || badPages.length ? 1 : 0);
