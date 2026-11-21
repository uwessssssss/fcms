import re, json, pathlib
R = pathlib.Path(__file__).resolve().parents[2]
S = json.load(open(str(pathlib.Path(__file__).with_name('.schema.json'))))
def strip(s): return re.sub(r"--[^\n]*", "", s)
rules = []   # (table, col, trigger(v)->bool, desc, required col)
for t, _, expr in S['checks']:
    e = ' '.join(expr.split())
    # The WHOLE constraint, not a prefix: "a <> 'X' OR b IS NOT NULL OR c IS NOT NULL" is a
    # different rule from its first two terms, and reading the prefix invented one.
    for m in re.finditer(r"^\(?\s*(\w+)\s*(<>|=)\s*'(\w+)'\s+OR\s+(\w+)\s+IS NOT NULL\s*\)?$", e):
        col, op, v, req = m.groups()
        trig = (lambda v=v: (lambda x: x == v))() if op == '<>' else (lambda v=v: (lambda x: x != v))()
        rules.append((t, col, trig, f"{col} {'=' if op=='<>' else '<>'} '{v}' needs {req}", req))
    for m in re.finditer(r"^\(?\s*(\w+)\s+NOT IN\s*\(([^)]*)\)\s+OR\s+(\w+)\s+IS NOT NULL\s*\)?$", e):
        col, vals, req = m.group(1), re.findall(r"'(\w+)'", m.group(2)), m.group(3)
        rules.append((t, col, (lambda vs=vals: (lambda x: x in vs))(), f"{col} in {vals} needs {req}", req))
print(f"coupled rules: {len(rules)}")
for t, col, _, d, _ in rules: print(f"   {t}: {d}")
srcs = []
live = {}
for f in sorted((R / 'db' / 'migrations').glob('*.sql')):
    s = strip(f.read_text(encoding='utf-8'))
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\((.*?)\$\$(.*?)\$\$", s, re.S): live[m.group(1)] = (f.name, m.group(3))
srcs += [(f"{n}:{fn}", b) for fn, (n, b) in live.items()]
srcs += [(f.name, f.read_text(encoding='utf-8')) for f in (R / 'api').rglob('*.cs') if 'bin' not in f.parts]
srcs += [('seed/' + f.name, strip(f.read_text(encoding='utf-8'))) for f in sorted((R / 'db' / 'seed').glob('*.sql'))]
# Judged safe, with the reason. A NEW update of this kind still fails.
ACCEPTED = {
  ("fn_receive_delivery", "delivery", "status", "seals_intact"):
      "seals_intact is always set by DeliveryService (a bool, never null) before this runs",
  ("ForecourtService.cs", "nozzle_assignment", "state", "released_at"):
      "released_at was set by the CLOSED step just before, in the same transaction",
}
print("updates that set the trigger without the required column:")
n = 0
for name, s in srcs:
    for m in re.finditer(r"UPDATE (\w+)\s+SET\s+(.*?)(?:\s+WHERE\b|;|\"\"\"|\")", s, re.S):
        t, sets = m.group(1), m.group(2)
        assigned = dict(re.findall(r"\b(\w+)\s*=\s*('?[^,]+?'?)\s*(?:,|$)", sets))
        for rt, col, trig, d, req in rules:
            if rt != t or col not in assigned: continue
            lit = re.fullmatch(r"'(\w+)'(?:::\w+)?", assigned[col].strip())
            if lit and trig(lit.group(1)) and req not in assigned:
                if any(k[0] in name and k[1] == t and k[2] == col and k[3] == req for k in ACCEPTED): continue  # the SPECIFIC rule excused
                n += 1; print(f"  X {name}:{s[:m.start()].count(chr(10))+1}  UPDATE {t} SET {col}='{lit.group(1)}' without {req}   [{d}]")
print(f"updates that would break a two-column rule: {n}")
import sys; sys.exit(1 if n else 0)
