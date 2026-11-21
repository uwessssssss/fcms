const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found: run npm install in web/'); })();
const ROOT = path.join(REPO, 'web', 'src');
const routes = new Set(JSON.parse(fs.readFileSync(process.env.ROUTES_JSON, 'utf8')).map(([m, p]) => `${m} ${p}`));
const VERB = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE' };
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } })(ROOT);

const out = [], syntax = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // The parser RECOVERS from syntax errors and still builds a tree, so every
  // other check here passed on a file that did not compile. Its own
  // diagnostics say so; a broken file fails the run.
  for (const d of sf.parseDiagnostics || []) {
    const { line: l } = sf.getLineAndCharacterOfPosition(d.start || 0);
    syntax.push(`${path.relative(ROOT, file)}:${l + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'api'
        && VERB[n.expression.name.text]) {
      const verb = VERB[n.expression.name.text];
      const a0 = n.arguments[0];
      let p = null;
      if (a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))) p = a0.text;
      else if (a0 && ts.isTemplateExpression(a0)) p = a0.head.text + a0.templateSpans.map(s => ':p' + s.literal.text).join('');
      const norm = p === null ? null : (p.split('?')[0].replace(/(:p)+/g, ':p').replace(/\/$/, '') || '/');
      const optIdx = verb === 'POST' || verb === 'PUT' ? 2 : 1;
      const opt = n.arguments[optIdx];
      const keys = opt && ts.isObjectLiteralExpression(opt) ? opt.properties.map(x => x.name && x.name.getText(sf)) : [];
      // is the promise handled at all?
      let up = n; while (up.parent && (ts.isPropertyAccessExpression(up.parent) || (ts.isCallExpression(up.parent) && up.parent.expression === up) || ts.isParenthesizedExpression(up.parent) || ts.isAsExpression(up.parent))) up = up.parent;
      const par = up.parent;
      const handled = par && (ts.isAwaitExpression(par) || ts.isReturnStatement(par) || ts.isVoidExpression(par)
        || ts.isArrowFunction(par) || ts.isArrayLiteralExpression(par) || ts.isVariableDeclaration(par)
        || ts.isCallExpression(par) || ts.isConditionalExpression(par) || ts.isBinaryExpression(par));
      const chainText = up.getText(sf);
      const hasCatch = /\.catch\(/.test(chainText) || /\.then\([^]*,/.test(chainText);
      // is a failure caught?
      let caught = hasCatch, a = n;
      while (a.parent && !caught) {
        const p2 = a.parent;
        if (ts.isTryStatement(p2) && p2.tryBlock === a) caught = true;
        if (ts.isCallExpression(p2) && p2.arguments.includes(a) && ts.isIdentifier(p2.expression) && ['run'].includes(p2.expression.text)) caught = true;
        if (ts.isCallExpression(p2) && ts.isPropertyAccessExpression(p2.expression) && p2.expression.name.text === 'all'
            && /\.catch\(/.test(p2.parent && p2.parent.getText ? p2.parent.getText(sf) : '')) caught = true;
        a = p2;
      }
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      out.push({ file: path.relative(ROOT, file), line: line + 1, verb, path: norm, raw: p, keys,
                 known: norm !== null && routes.has(`${verb} ${norm}`), handled: !!handled, caught });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
fs.writeFileSync(path.join(require('os').tmpdir(), 'fcms-calls.json'), JSON.stringify(out, null, 1));
const bad = out.filter(c => !c.known), dyn = out.filter(c => c.path === null);
console.log(`files ${files.length} | api calls found by the parser: ${out.length}`);
console.log(`  path not a literal or template (unverifiable): ${dyn.length}`);
dyn.forEach(c => console.log(`     ${c.file}:${c.line} ${c.verb}`));
console.log(`  path does not match any route: ${bad.length - dyn.length}`);
bad.filter(c => c.path !== null).forEach(c => console.log(`     ${c.file}:${c.line} ${c.verb} ${c.path}`));
const floating = out.filter(c => !c.handled && !c.caught);
console.log(`  promise not awaited, returned or chained (floating): ${floating.length}`);
floating.forEach(c => console.log(`     ${c.file}:${c.line} ${c.verb} ${c.path}`));
const writes = out.filter(c => c.verb !== 'GET' && !c.caught);
console.log(`  writes whose failure nothing catches: ${writes.length}`);
writes.forEach(c => console.log(`     ${c.file}:${c.line} ${c.verb} ${c.path}`));

console.log(`  files that do not parse: ${new Set(syntax.map(x => x.split(':')[0])).size}`);
syntax.slice(0, 5).forEach(x => console.log('     ' + x));
process.exit((bad.length || floating.length || writes.length || syntax.length) ? 1 : 0);
