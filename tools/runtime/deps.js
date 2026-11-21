// Stale values: a hook's callback uses a component value its dependency list
// does not name, so it keeps the value from when it was created. The React
// linter's exhaustive-deps rule, rebuilt on the TypeScript parser because the
// linter is not installable here.
const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found'); })();
const ROOT = path.join(REPO, 'web', 'src');
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) w(p); else if (/\.tsx$/.test(e.name)) files.push(p); } })(ROOT);
const HOOKS = new Set(['useEffect', 'useCallback', 'useMemo', 'useLayoutEffect']);
const out = [];
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.relative(ROOT, file);
  const comps = [];
  const collect = (n) => {
    let name, body;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.text; body = n.initializer.body; }
    if (name && body && ts.isBlock(body) && /^[A-Z]/.test(name)) comps.push({ name, body });
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const { name, body } of comps) {
    // Names declared directly in the component body, and which of them are stable.
    const scope = new Set(), stable = new Set();
    for (const st of body.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) scope.add(st.name.text);
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        const init = d.initializer; const call = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : '';
        if (ts.isIdentifier(d.name)) { scope.add(d.name.text); if (call === 'useRef') stable.add(d.name.text); }
        if (ts.isArrayBindingPattern(d.name)) d.name.elements.forEach((e, i) => { if (ts.isBindingElement(e) && ts.isIdentifier(e.name)) {
          scope.add(e.name.text); if ((call === 'useState' || call === 'useReducer') && i === 1) stable.add(e.name.text); } });
        if (ts.isObjectBindingPattern(d.name)) d.name.elements.forEach((e) => { if (ts.isIdentifier(e.name)) scope.add(e.name.text); });
      }
    }
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HOOKS.has(n.expression.text) && n.arguments.length >= 2) {
        const fn = n.arguments[0], deps = n.arguments[1];
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isArrayLiteralExpression(deps)) {
          const listed = new Set(deps.elements.map((e) => e.getText(sf).split(/[.?[]/)[0]));
          const locals = new Set(), used = new Map();
          const walk = (k) => {
            if (ts.isParameter(k) && ts.isIdentifier(k.name)) locals.add(k.name.text);
            if (ts.isVariableDeclaration(k)) {
              const bind = (b) => { if (ts.isIdentifier(b)) locals.add(b.text); else if (b.elements) b.elements.forEach((e) => e.name && bind(e.name)); };
              bind(k.name);
            }
            if (ts.isIdentifier(k)) {
              const p = k.parent;
              const isProp = p && ((ts.isPropertyAccessExpression(p) && p.name === k) || (ts.isPropertyAssignment(p) && p.name === k)
                || (ts.isJsxAttribute && ts.isJsxAttribute(p)));
              if (!isProp && scope.has(k.text) && !stable.has(k.text) && !used.has(k.text)) used.set(k.text, k);
            }
            ts.forEachChild(k, walk);
          };
          walk(fn);
          const missing = [...used.keys()].filter((x) => !locals.has(x) && !listed.has(x));
          if (missing.length) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            out.push(`${rel}:${line + 1} ${name}: ${n.expression.text} uses ${missing.join(', ')} but does not list ${missing.length > 1 ? 'them' : 'it'}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  }
}
console.log(`files ${files.length} | hooks with values missing from their dependencies: ${out.length}`);
out.forEach((x) => console.log('  ' + x));
process.exit(out.length ? 1 : 0);
