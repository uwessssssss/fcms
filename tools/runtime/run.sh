#!/usr/bin/env bash
# Runtime checks: things RUN, not read. See each script's header.
set -u; cd "$(dirname "$0")"; fail=0
export ROUTES_JSON="$(mktemp)"
python3 - "$ROUTES_JSON" <<'PY'
import re, pathlib, json, sys
root = pathlib.Path('../../api'); routes = []
for f in root.rglob('*.cs'):
    if 'bin' in f.parts or 'obj' in f.parts: continue
    src = re.sub(r"//[^\n]*", "", f.read_text(encoding='utf-8'))
    g = {m.group(1): m.group(2) for m in re.finditer(r'var\s+(\w+)\s*=\s*app\.MapGroup\("([^"]+)"\)', src)}
    for m in re.finditer(r'\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*"([^"]*)"', src):
        h, meth, tpl = m.groups(); pre = g.get(h, "" if h == "app" else None)
        if pre is None: continue
        routes.append([meth.upper(), re.sub(r'\{[^}]*\}', ':p', (pre+tpl).replace('//','/')).rstrip('/') or '/'])
json.dump(routes, open(sys.argv[1], 'w'))
PY
echo "-- calls, parsed by the TypeScript compiler --"; node calls.js || fail=1
echo "-- blank boxes posted as zero --";              node blank_numbers.js || fail=1
echo "-- every button and link does something --";   node buttons.js || fail=1
echo "-- stale values in hooks --";                  node deps.js || fail=1
echo "-- used before declared, during render --";    node render_order.js || fail=1
echo "-- rules of hooks --";                           node hooks.js | tee /dev/stderr | grep -q "violations: 0" || fail=1
# Its own exit code: piped straight into grep, a failing check here was
# grep's success, and "a real 401 still ends the session" failed unseen.
echo "-- the key-per-save client, executed --";        out=$(node runapi.js) || fail=1; printf '%s\n' "$out" | grep -v "^\[FCMS\]"
echo "-- the shift report mapping, executed --";       node mapping.js || fail=1
echo "-- C# lexed --";                                 python3 cslex.py ../../api | tee /dev/stderr | grep -q "broken: 0" || fail=1
echo "-- cash and variance logic, executed --";        python3 logic_sqlite.py || fail=1
echo "-- moving average cost, executed --";          python3 moving_average.py || fail=1
echo "-- per-shift variance, executed --";           python3 close_variance.py || fail=1
echo "-- business dates, executed in Kampala time --"; TZ=Africa/Kampala node dates.js || fail=1
rm -f "$ROUTES_JSON"
[ $fail = 0 ] && echo "All runtime checks passed." || { echo "RUNTIME CHECKS FAILED."; exit 1; }
