// Every button and link does something. Found by inventorying all of them:
// buttons with no handler (Export, Order Delivery), handlers that only said why
// they would not act (Acknowledge), a Save that saved nothing, a bell that rang
// nowhere, a search box that ignored typing, links to pages that do not exist.
const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found'); })();
const SRC = path.join(REPO, 'web', 'src');
const files = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) w(p); else if (/\.tsx$/.test(e.name)) files.push(p); } })(SRC);
// routes that exist
const routes = new Set(); (function w(d, base) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.isDirectory()) w(path.join(d, e.name), base + '/' + e.name);
  else if (e.name === 'page.tsx') routes.add(base || '/'); } })(path.join(SRC, 'app'), '');
const EFFECT = /(history\??\.back|router\??\.(push|replace|back)|downloadCsv|revoke\w*\(|accessAction|\bapi\.|run\(|void run|set[A-Z]\w*\(|router\.(push|replace|back)|window\.(print|open|location)|navigator\.|URL\.createObjectURL|\.click\(\)|logout|signOut|login|download|export\w*\(|handle\w+\(|on[A-Z]\w*\(|refresh|reload|load\w*\(|submit|save\w*\(|approve|close\w*\(|open\w*\(|toggle|remove|delete|add\w*\(|confirm\w*\(|apply\w*\(|take\w*\(|record\w*\(|bank\w*\(|execute\w*\(|preview|tryForm|gate|flagProblem|copy|print)/;
const stats = { buttons: 0, links: 0 }; const out = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.relative(SRC, file);
  const fnBodies = new Map();
  (function c(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init = n.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback' && init.arguments[0]) init = init.arguments[0];
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fnBodies.set(n.name.text, init.body.getText(sf));
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body) fnBodies.set(n.name.text, n.body.getText(sf));
    ts.forEachChild(n, c);
  })(sf);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const attrs = (el) => { const m = {}; for (const a of el.attributes.properties) if (ts.isJsxAttribute(a)) m[a.name.getText(sf)] = a.initializer; return m; };
  (function visit(n) {
    const el = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (el) {
      const tag = el.tagName.getText(sf); const A = attrs(el);
      const label = ts.isJsxElement(n) ? n.children.map((ch) => ch.getText(sf)).join(' ').replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (tag === 'button') {
        stats.buttons++;
        const type = A.type ? A.type.getText(sf).replace(/["{}']/g, '') : '';
        let inForm = false; for (let p = n.parent; p; p = p.parent) { const pe = ts.isJsxElement(p) ? p.openingElement : null; if (pe && pe.tagName.getText(sf) === 'form') { inForm = true; break; } }
        if (!A.onClick) {
          if (!(type === 'submit' && inForm)) out.push(`DEAD        ${rel}:${line(n)} "${label}" - no onClick${type === 'submit' ? ' (submit, but no form)' : ''}`);
        } else {
          const expr = A.onClick.expression; let body = expr ? expr.getText(sf) : '';
          if (expr && ts.isPropertyAccessExpression(expr)) body = '<<passed in>>';
          if (expr && ts.isIdentifier(expr)) body = fnBodies.get(expr.text) ?? `<<${expr.text}: prop or import>>`;
          const call = body.match(/^\(\)\s*=>\s*(?:void\s+)?(\w+)\(/);
          if (call && fnBodies.has(call[1])) body = body + ' ' + fnBodies.get(call[1]);
          const stripped = body.replace(/\s+/g, '');
          if (/^\(\w*\)=>\{\}$|^\(\)=>undefined$|^\(\)=>null$/.test(stripped)) out.push(`EMPTY       ${rel}:${line(n)} "${label}"`);
          else if (!EFFECT.test(body) && !body.startsWith('<<')) out.push(`NO-EFFECT   ${rel}:${line(n)} "${label}"  onClick: ${body.replace(/\s+/g, ' ').slice(0, 70)}`);
          else if (/coming soon|not (yet )?implemented|TODO|placeholder/i.test(body)) out.push(`PLACEHOLDER ${rel}:${line(n)} "${label}"  ${body.replace(/\s+/g, ' ').slice(0, 70)}`);
        }
        if (A.disabled && /^\{?\s*true\s*\}?$/.test(A.disabled.getText(sf))) out.push(`DISABLED    ${rel}:${line(n)} "${label}" - disabled={true}`);
      }
      if (tag === 'Link' || tag === 'a') {
        stats.links++;
        const h = A.href ? A.href.getText(sf) : '';
        const lit = h.match(/^["'{`]*\s*['"`]?(\/[^"'`}$]*)['"`]?\s*}?$/);
        if (h === '"#"' || h === "'#'" || h === "{'#'}") out.push(`HREF-#      ${rel}:${line(n)} "${label}"`);
        else if (lit) { const r = lit[1].split(/[?#]/)[0].replace(/\/$/, '') || '/'; if (!routes.has(r) && !r.startsWith('/api')) out.push(`NO-ROUTE    ${rel}:${line(n)} ${tag} -> ${r}`); }
      }
    }
    if (ts.isCallExpression(n) && /router\.(push|replace)$/.test(n.expression.getText(sf)) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const r = n.arguments[0].text.split(/[?#]/)[0].replace(/\/$/, '') || '/';
      if (!routes.has(r)) out.push(`NO-ROUTE    ${rel}:${line(n)} router -> ${r}`);
    }
    ts.forEachChild(n, visit);
  })(sf);
}
console.log(`routes ${routes.size} | buttons ${stats.buttons} | links ${stats.links} | findings ${out.length}`);
out.sort().forEach((x) => console.log('  X ' + x));
process.exit(out.length ? 1 : 0);
