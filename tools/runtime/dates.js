// lib/dates.ts, executed under the station's timezone at the hours that matter.
const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found'); })();
const src = fs.readFileSync(path.join(REPO, 'web', 'src', 'lib', 'dates.ts'), 'utf8');
const m = { exports: {} };
new Function('module', 'exports', ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(m, m.exports);
const { businessToday, localDate, monthStartOf } = m.exports;
if (process.env.TZ !== 'Africa/Kampala') { console.log('  FAIL  run with TZ=Africa/Kampala'); process.exit(1); }
let ok = 0, bad = 0;
const check = (n, got, want) => { const g = got === want; g ? ok++ : bad++; console.log(`  ${g ? 'PASS' : 'FAIL'}  ${n}: got ${got}, expected ${want}`); };
const at = (iso) => new Date(iso);                       // instants given with their +03:00 offset
check('01:00 on the 1st is the 30th\'s business day', businessToday(6, at('2026-10-01T01:00:00+03:00')), '2026-09-30');
check('04:00 on the 1st: still the 30th (UTC got this wrong)', businessToday(6, at('2026-10-01T04:00:00+03:00')), '2026-09-30');
check('07:00 on the 1st is the 1st', businessToday(6, at('2026-10-01T07:00:00+03:00')), '2026-10-01');
check('...where the OLD UTC date said', at('2026-10-01T04:00:00+03:00').toISOString().slice(0, 10), '2026-10-01');
check('a file at 01:00 is named by the calendar', localDate(at('2026-10-01T01:00:00+03:00')), '2026-10-01');
check('a site whose day starts at midnight', businessToday(0, at('2026-10-01T01:00:00+03:00')), '2026-10-01');
check('month start', monthStartOf('2026-09-30'), '2026-09-01');
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
