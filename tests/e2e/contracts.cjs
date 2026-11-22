// =============================================================================
// What the screens expect from each API call: for every api.get<T>(...) in
// the web app, the fields T says the response has.
//
//   node contracts.cjs <path-to-web> > contracts.json
//
// e2e.mjs records every real response during its run and compares: a field a
// screen expects that the API does not send is a field shown blank, "undefined"
// or NaN -- the commonest bug this project has had (a screen reading `site`
// while the API sends `siteName`). Needs TypeScript (web/node_modules).
// =============================================================================
const path = require('path');
const WEB = path.resolve(process.argv[2] || '../../web');
const ts = require(require.resolve('typescript', { paths: [WEB, __dirname] }));

const cfg = ts.getParsedCommandLineOfConfigFile(path.join(WEB, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const prog = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true, skipLibCheck: true });
const tc = prog.getTypeChecker();

// The fields of an object type: required and optional, one level, plus the
// element fields of array-valued fields (rows inside a summary).
function shape(type, depth = 0) {
  if (!type || depth > 2) return null;
  if (type.isUnion()) {
    const real = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    return real.length === 1 ? shape(real[0], depth) : null;
  }
  if (tc.isArrayType(type)) {
    const el = shape(tc.getTypeArguments(type)[0], depth + 1);
    return el ? { array: true, ...el } : null;
  }
  if (!(type.flags & ts.TypeFlags.Object) || tc.getSignaturesOfType(type, ts.SignatureKind.Call).length) return null;
  const props = tc.getPropertiesOfType(type);
  if (!props.length) return null;
  const req = [], opt = [], nested = {};
  for (const p of props) {
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    if (!decl) continue;
    const pt = tc.getTypeOfSymbolAtLocation(p, decl);
    const nullable = pt.isUnion() && pt.types.some((t) => t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
    // Optional or nullable: the screen copes when it is absent. Otherwise the
    // screen reads it as present.
    ((p.flags & ts.SymbolFlags.Optional) || nullable ? opt : req).push(p.name);
    if (tc.isArrayType(pt)) { const s = shape(tc.getTypeArguments(pt)[0], depth + 1); if (s && !s.array) nested[p.name] = s; }
  }
  return { required: req.sort(), optional: opt.sort(), nested, type: type.aliasSymbol?.name || type.symbol?.name || '' };
}

const out = [];
for (const sf of prog.getSourceFiles()) {
  if (!sf.fileName.startsWith(path.join(WEB, 'src')) || sf.fileName.endsWith('lib/api.ts')) continue;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === 'api'
        && n.expression.name.text === 'get' && n.arguments.length && n.typeArguments?.length) {
      const a = n.arguments[0];
      let tpl = null;
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) tpl = a.text;
      else if (ts.isTemplateExpression(a)) tpl = a.head.text + a.templateSpans.map((s) => '{}' + s.literal.text).join('');
      const s = tpl && shape(tc.getTypeFromTypeNode(n.typeArguments[0]));
      if (s) out.push({ path: tpl.split('?')[0], file: path.relative(WEB, sf.fileName), ...s });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
process.stdout.write(JSON.stringify(out, null, 1));
console.error(`${out.length} typed API calls`);
