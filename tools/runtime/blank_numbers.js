// A number posted straight from a form field with no guard in its own handler.
// Number('') is 0: a blank box went out as a real zero -- a 0 L dip, a 0 L pump
// test. The guard is looked for in the handler and the function around it --
// NOT the whole component, which let a check in the DISPLAY code pass for one.
const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found'); })();
const ROOT = path.join(REPO, 'web', 'src', 'app');
let hits = 0;
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) w(p); else if (/\.tsx$/.test(e.name)) files.push(p); } })(ROOT);
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
        && n.expression.expression.text === 'api' && ['post', 'put'].includes(n.expression.name.text)) {
      const body = n.arguments[1];
      const scan = (o) => { if (!o || !ts.isObjectLiteralExpression(o)) return;
        for (const pr of o.properties) {
          if (!ts.isPropertyAssignment(pr)) continue;
          const v = pr.initializer;
          if (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === 'Number') {
            // the enclosing handler's text, to look for a guard on the same field
            let f = n; while (f && !ts.isArrowFunction(f) && !ts.isFunctionExpression(f) && !ts.isFunctionDeclaration(f)) f = f.parent;
            let outer = f; for (let k = 0; k < 1 && outer && outer.parent; k++) { let g = outer.parent; while (g && !ts.isArrowFunction(g) && !ts.isFunctionExpression(g) && !ts.isFunctionDeclaration(g)) g = g.parent; if (g) outer = g; }
            const arg = v.arguments[0].getText(sf);
            const handler = outer ? outer.getText(sf) : '';
            const esc = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const guarded = new RegExp(`Number\\(${esc}\\)\\s*>\\s*0|given\\(${esc}\\)|${esc}\\s*===\\s*''|!\\(Number\\(${esc}\\)\\s*>|${esc}\\.trim\\(\\)`).test(handler);
            // Or guarded by the shared checker: the save is gated on hasErrors(...),
            // AND this exact value goes through c.number(...), which treats blank
            // as missing. Both, not either: a gate alone proves nothing about
            // which fields it covers.
            // A gate may be a helper -- gate('xfer'), gateClose() -- that calls
            // hasErrors itself. Find the file's helpers that do, and accept a call.
            const gates = [...src.matchAll(/const (\w+) = \([^)]*\)[^=]*=>\s*\{([\s\S]*?)\n  \};/g)]
              .filter((g) => /hasErrors\(/.test(g[2])).map((g) => g[1]);
            const viaChecker = (/hasErrors\(/.test(handler) || gates.some((g) => new RegExp(`\\b${g}\\(`).test(handler)))
              && new RegExp(`\\.number\\([^,]+,\\s*${esc}\\s*,`).test(src);
            if (!guarded && !viaChecker) {
              const { line } = sf.getLineAndCharacterOfPosition(pr.getStart(sf));
              hits++; console.log(`  X ${path.relative(ROOT, file).split('/components')[0]}:${line + 1}  ${pr.name.getText(sf)}: Number(${arg}) - a blank box goes out as 0`);
            }
          }
          if (ts.isArrayLiteralExpression(v)) v.elements.forEach(scan);
          if (ts.isObjectLiteralExpression(v)) scan(v);
        } };
      scan(body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

console.log(`unguarded numbers posted from forms: ${hits}`);
process.exit(hits ? 1 : 0);
