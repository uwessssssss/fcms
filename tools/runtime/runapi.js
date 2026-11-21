const path = require('path'), fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const ts = (() => { for (const p of [path.join(REPO, 'web', 'node_modules', 'typescript'),
  path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) {
  try { return require(p); } catch {} } throw new Error('TypeScript not found: run npm install in web/'); })();
const src = fs.readFileSync(path.join(REPO, 'web', 'src', 'lib', 'api.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const store = {}; global.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v, removeItem: k => delete store[k] };
global.window = global;

// A server with the REAL middleware's rules: a key is stored only on success;
// same key + same body replays; same key + different body is refused.
const recorded = new Map(), sales = [];
let script = [];                 // queued outcomes: 'ok' | 'net' | 500 | 422 | 'reply-lost'
global.fetch = async (url, init) => {
  const key = init.headers['Idempotency-Key'], body = init.body ?? '';
  const outcome = script.length ? script.shift() : 'ok';
  if (outcome === 'net') throw new TypeError('network down');
  if (key && recorded.has(key)) {
    const r = recorded.get(key);
    if (r.body !== body) return new Response(JSON.stringify({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'x' }), { status: 409 });
    return new Response(JSON.stringify(r.reply), { status: 200 });          // replay
  }
  if (outcome === 'bad-password') return new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'That employee number or password is not right.' }), { status: 401 });
  if (outcome === 'expired') return new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'x' }), { status: 401 });
  if (typeof outcome === 'number') return new Response(JSON.stringify({ code: 'E', message: 'refused' }), { status: outcome });
  sales.push(JSON.parse(body || '{}'));
  const reply = { id: sales.length };
  if (key) recorded.set(key, { body, reply });
  if (outcome === 'reply-lost') throw new TypeError('reply lost');         // saved, but the client never hears
  return new Response(JSON.stringify(reply), { status: 200 });
};
const m = { exports: {} }; new Function('module', 'exports', 'require', 'process', js)(m, m.exports, require, { env: {} });
const { api } = m.exports;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sale = { customer: 'C1', litres: 100 };
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e }; } };

(async () => {
  // 1. The bug that started this: two genuine, identical credit sales.
  await api.post('/s', sale, { submission: 'credit-sale:S1' });
  await api.post('/s', sale, { submission: 'credit-sale:S1' });
  check('two identical sales are two sales', sales.length === 2, `(recorded ${sales.length})`);

  // 2. ...and the OLD way: a key built from the content.
  sales.length = 0;
  await api.post('/s', sale, { idempotencyKey: 'credit-S1-C1-100' });
  await api.post('/s', sale, { idempotencyKey: 'credit-S1-C1-100' });
  check('(old content key) the second sale was dropped - confirming the bug', sales.length === 1, `(recorded ${sales.length})`);

  // 3. Network down: nothing reached the server; the retry must be the SAME save.
  sales.length = 0; script = ['net'];
  const r3 = await attempt(() => api.post('/s', sale, { submission: 'x3' }));
  await api.post('/s', sale, { submission: 'x3' });
  check('a retry after the network failed records once', sales.length === 1, `(recorded ${sales.length})`);
  check('...and says a retry is safe', /safe to try again/.test(r3.err?.message ?? ''));

  // 4. The reply was lost AFTER the server saved: the retry must replay, not re-save.
  sales.length = 0; script = ['reply-lost'];
  await attempt(() => api.post('/s', sale, { submission: 'x4' }));
  const r4 = await api.post('/s', sale, { submission: 'x4' });
  check('a retry after a lost reply does not save twice', sales.length === 1, `(recorded ${sales.length})`);
  check('...and returns the first save\'s answer', r4?.id === 1);

  // 5. Lost reply, then the person EDITS the form before retrying.
  sales.length = 0; script = ['reply-lost'];
  await attempt(() => api.post('/s', sale, { submission: 'x5' }));
  const r5 = await attempt(() => api.post('/s', { ...sale, litres: 120 }, { submission: 'x5' }));
  check('an edited retry after a lost reply is refused, not saved twice', sales.length === 1 && r5.err?.code === 'ALREADY_SAVED', `(recorded ${sales.length}, ${r5.err?.code})`);
  await api.post('/s', { ...sale, litres: 120 }, { submission: 'x5' });
  check('...and the next save after that is a new one', sales.length === 2, `(recorded ${sales.length})`);

  // 6. Server errors keep the key; a validation refusal lets a corrected save through.
  sales.length = 0; script = [500];
  await attempt(() => api.post('/s', sale, { submission: 'x6' }));
  await api.post('/s', sale, { submission: 'x6' });
  check('a retry after a server error records once', sales.length === 1);
  sales.length = 0; script = [422];
  await attempt(() => api.post('/s', { litres: -1 }, { submission: 'x7' }));
  await api.post('/s', { litres: 50 }, { submission: 'x7' });
  check('a corrected save after a refusal goes through', sales.length === 1);

  // 7. Two different saves in flight never share a key.
  sales.length = 0;
  await Promise.all([api.post('/s', sale, { submission: 'dip:S1' }), api.post('/s', sale, { submission: 'pump-test:S1' })]);
  check('different named saves are independent', sales.length === 2);

  // 8. Honest messages when there is no key at all.
  script = ['net'];
  const r8 = await attempt(() => api.post('/s', sale));
  check('with no key, a failure does not claim a retry is safe', /may or may not/.test(r8.err?.message ?? ''));

  // 9. Reads carry no key.
  let hdr; const f0 = global.fetch; global.fetch = async (u, i) => { hdr = i.headers; return new Response('[]', { status: 200 }); };
  await api.get('/r'); global.fetch = f0;
  check('a read sends no idempotency key', !('Idempotency-Key' in hdr));

  // A wrong password is a 401 but not the end of a session.
  const { setToken, getToken } = m.exports;
  setToken('tok-1');
  script = ['bad-password'];
  const bp = await api.post('/api/auth/login', { u: 1 }).catch((err) => ({ err }));
  check('a wrong password says so - not "your session has ended"', bp.err?.code === 'INVALID_CREDENTIALS', `(code ${bp.err?.code})`);
  check('...and does not throw away a session', getToken() === 'tok-1');
  script = ['expired'];
  const ex = await api.get('/api/anything').catch((err) => ({ err }));
  check('a real 401 still ends the session', ex.err?.code === 'SESSION_ENDED' && getToken() === null, `(code ${ex.err?.code})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
