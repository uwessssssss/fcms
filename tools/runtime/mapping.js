const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found: run npm install in web/'); })();
const file = path.join(REPO, 'web', 'src', 'app', 'shift-closure', 'reports', 'components', 'ShiftReportsContent.tsx');
const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let fn = null;
ts.forEachChild(sf, n => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'toShiftRecord') fn = n.getText(sf); });
// The mapping calls the real shiftLabelName (lib/shiftLabel.ts); load it too,
// so the check runs the code the screen runs rather than a stand-in.
const labelSrc = fs.readFileSync(path.join(REPO, 'web', 'src', 'lib', 'shiftLabel.ts'), 'utf8').replace(/^export /gm, '');
const js = ts.transpileModule(labelSrc + '\n' + fn + '\nmodule.exports = toShiftRecord;', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const m = { exports: {} }; new Function('module', 'exports', js)(m, m.exports);
const toShiftRecord = m.exports;
let ok = 0, bad = 0;
const check = (n, got, want) => { const g = got === want; g ? ok++ : bad++; console.log(`  ${g ? 'PASS' : 'FAIL'}  ${n}: got ${got}, expected ${want}`); };
const base = { id: 's', businessDate: '2026-09-28', label: 'DAY', state: 'APPROVED', openedByName: 'Sup', siteName: 'Kiboga',
  salesValue: 9_900_000, shopValue: 100_000, salesLitres: 2_000, openExceptions: 0, cashDeclared: 6e6, electronicDeclared: 3e6,
  creditTotal: 7e5, priceAgreementTotal: 1e5, discountTotal: 2e5, shortageRaised: 50_000, overageRaised: 50_000,
  varianceLitres: -50, varianceValue: -250_000 };
const r = toShiftRecord(base);
check('50 L missing shows as a loss (negative)', r.gainLoss, -50);
check('the dips say 2,050 L left the tank', r.dipConsumed, 2_050);
check('litres sold on the meters', r.elecSales, 2_000);
check('approved shift reads as closed', r.status, 'closed');
check('declared-not-approved reads as pending', toShiftRecord({ ...base, state: 'DECLARED' }).status, 'pending');
check('open exceptions override: flagged', toShiftRecord({ ...base, state: 'DECLARED', openExceptions: 2 }).status, 'flagged');
check('night shift label', toShiftRecord({ ...base, label: 'NIGHT' }).shift, 'Night');
check('mid shift label (570)', toShiftRecord({ ...base, label: 'MID' }).shift, 'Mid');
check('a gain is positive', toShiftRecord({ ...base, varianceLitres: 30 }).gainLoss, 30);
// Sales are fuel + shop; settled by cash, electronic, credit, agreed prices,
// discounts and shortages, less any overage.
const settled = r.cashSales + r.electronic + r.credit + r.agreed + r.discounts + r.short - r.over;
check('sales = fuel + shop', r.totalSales, 10_000_000);
check('every term of the takings is carried, and they balance', settled, r.totalSales);
check('the row names its site', r.site, 'Kiboga');
check('the gain/loss carries its value at cost', r.gainLossValue, -250_000);
console.log(`\n${ok} passed, ${bad} failed`);

process.exit(bad ? 1 : 0);
