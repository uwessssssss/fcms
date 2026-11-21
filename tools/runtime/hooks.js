const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found: run npm install in web/'); })();
const ROOT = path.join(REPO, 'web', 'src');
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) w(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } })(ROOT);
const isHook = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text);
const problems = [];
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.relative(ROOT, file);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  // components and custom hooks: capitalised functions, or use* functions
  const bodies = [];
  const collect = (n) => {
    let name = null, body = null;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      name = n.name.text; body = n.initializer.body; }
    if (name && body && ts.isBlock(body) && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))) bodies.push({ name, body });
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const { name, body } of bodies) {
    let returned = null;
    for (const st of body.statements) {
      // any hook in this top-level statement, not inside a nested function
      const hooksHere = [];
      const scan = (n, depth, cond) => {
        if (ts.isFunctionLike(n) && n !== st) return;              // callbacks: checked below
        if (isHook(n)) hooksHere.push({ n, cond });
        const c = cond || ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
          || ts.isWhileStatement(n) || (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind));
        ts.forEachChild(n, (k) => scan(k, depth + 1, c));
      };
      scan(st, 0, false);
      for (const h of hooksHere) {
        if (returned) problems.push(`${rel}:${line(h.n)} ${name}: ${h.n.expression.text}() after the early return on line ${returned} - crashes when that return stops firing`);
        else if (h.cond) problems.push(`${rel}:${line(h.n)} ${name}: ${h.n.expression.text}() inside a condition or loop`);
      }
      const hasReturn = (n) => ts.isReturnStatement(n) || (!ts.isFunctionLike(n) && ts.forEachChild(n, hasReturn));
      if (!returned && ts.isIfStatement(st) && hasReturn(st)) returned = line(st);
    }
    // hooks called inside callbacks within the component
    const inner = (n, inFn) => {
      if (isHook(n) && inFn) problems.push(`${rel}:${line(n)} ${name}: ${n.expression.text}() inside a callback`);
      ts.forEachChild(n, (k) => inner(k, inFn || (ts.isFunctionLike(k) && k !== body.parent)));
    };
    inner(body, false);
  }
}
console.log(`files ${files.length} | rules-of-hooks violations: ${problems.length}`);
problems.forEach(p => console.log('  ' + p));

process.exit(problems.length ? 1 : 0);
