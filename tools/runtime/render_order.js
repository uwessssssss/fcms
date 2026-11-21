// Used before declared, during render. A useMemo runs its function WHILE the
// component renders; if that function uses a const declared further down the
// component, it reads it before it exists and throws -- on every render. The
// compiler allows it because the use is inside a function. Found when the
// depot checks called fmt() before fmt was declared. Callbacks and effects run
// later, so they are not judged.
const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found'); })();
const ROOT = path.join(REPO, 'web', 'src');
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) w(p); else if (/\.tsx$/.test(e.name)) files.push(p); } })(ROOT);
const out = [];
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const comps = [];
  (function collect(n) {
    let name, body;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.text; body = n.initializer.body; }
    if (name && body && ts.isBlock(body) && /^[A-Z]/.test(name)) comps.push({ name, body });
    ts.forEachChild(n, collect);
  })(sf);
  for (const { name, body } of comps) {
    const declaredAt = new Map();
    body.statements.forEach((st, i) => {
      if (ts.isFunctionDeclaration(st) && st.name) declaredAt.set(st.name.text, -1);   // hoisted
      if (!ts.isVariableStatement(st)) return;
      for (const d of st.declarationList.declarations) {
        const bind = (b) => { if (ts.isIdentifier(b)) declaredAt.set(b.text, i); else if (b.elements) b.elements.forEach((e) => e.name && bind(e.name)); };
        bind(d.name);
      }
    });
    body.statements.forEach((st, i) => {
      const visit = (n) => {
        const now = ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && (n.expression.text === 'useMemo' || n.expression.text === 'useState') && n.arguments[0]
          && (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0]));
        if (now) {
          const seen = new Set();
          (function walk(k) {
            if (ts.isIdentifier(k) && declaredAt.has(k.text) && declaredAt.get(k.text) > i && !seen.has(k.text)) {
              const p = k.parent;
              if (!(p && ts.isPropertyAccessExpression(p) && p.name === k) && !(p && ts.isPropertyAssignment(p) && p.name === k)) {
                seen.add(k.text);
                const { line } = sf.getLineAndCharacterOfPosition(k.getStart(sf));
                out.push(`${path.relative(ROOT, file)}:${line + 1} ${name}: ${n.expression.text} uses ${k.text} before it is declared - throws on every render`);
              }
            }
            ts.forEachChild(k, walk);
          })(n.arguments[0]);
        }
        ts.forEachChild(n, visit);
      };
      visit(st);
    });
  }
}
console.log(`files ${files.length} | used before declared during render: ${out.length}`);
out.forEach((x) => console.log('  X ' + x));
process.exit(out.length ? 1 : 0);
