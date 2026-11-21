import re, json, pathlib
R = pathlib.Path(__file__).resolve().parents[2]
S = json.load(open(str(pathlib.Path(__file__).with_name('.schema.json')))); T, E = S['tables'], S['enums']
def strip(s): return re.sub(r"--[^\n]*", "", s)
dom = {}                                            # column name -> set of allowed values (union over tables)
for t, col, expr in S['checks']:
    for m in re.finditer(r"\b(\w+)\s+IN\s*\(([^()]*)\)", expr):
        vals = re.findall(r"'([^']*)'", m.group(2))
        if vals: dom.setdefault(m.group(1), set()).update(vals)
for t, cols in T.items():
    for c, d in cols.items():
        if d['type'] in E: dom.setdefault(c, set()).update(E[d['type']])
# PER TABLE, for writes. The column-name union below let nozzle_assignment's
# 'CLOSED' pass for shift.state -- a value shift_state does not have -- and a
# depot day could never close. A write names its table, so check that table.
tdom = {}
for t, col, expr in S['checks']:
    for m in re.finditer(r"\b(\w+)\s+IN\s*\(([^()]*)\)", expr):
        vals = re.findall(r"'([^']*)'", m.group(2))
        if vals and m.group(1) in T.get(t, {}): tdom.setdefault((t, m.group(1)), set()).update(vals)
for t, cols in T.items():
    for c, d in cols.items():
        if d['type'] in E: tdom.setdefault((t, c), set()).update(E[d['type']])
def tcheck(where, t, col, val):
    if (t, col) in tdom and val not in tdom[(t, col)] and re.fullmatch(r"[A-Z][A-Z0-9_]+", val):
        problems.append(f"  X {where}  {t}.{col} = '{val}'  (allowed: {', '.join(sorted(tdom[(t, col)]))[:90]})")
GENERIC = {'kind', 'status', 'state', 'type', 'source', 'method', 'role', 'context', 'scope', 'reason', 'basis', 'label', 'code', 'level'}
problems = []
def check(where, col, val):
    if col in dom and val not in dom[col] and re.fullmatch(r"[A-Z][A-Z0-9_]+", val):
        problems.append(f"  X {where}  {col} = '{val}'  (allowed: {', '.join(sorted(dom[col]))[:90]})")
# --- SQL: C#, live function bodies, top-level migration SQL, seeds ---
srcs = []
live = {}
for f in sorted((R / 'db' / 'migrations').glob('*.sql')):
    s = strip(f.read_text(encoding='utf-8'))
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\((.*?)\$\$(.*?)\$\$", s, re.S): live[m.group(1)] = (f.name, m.group(3))
    srcs.append((f.name, re.sub(r"CREATE OR REPLACE FUNCTION .*?\$\$.*?\$\$", "", s, flags=re.S)))
srcs += [(f"{n}:{fn}", b) for fn, (n, b) in live.items()]
srcs += [(f.name, f.read_text(encoding='utf-8')) for f in (R / 'api').rglob('*.cs') if 'bin' not in f.parts]
srcs += [('seed/' + f.name, strip(f.read_text(encoding='utf-8'))) for f in sorted((R / 'db' / 'seed').glob('*.sql'))]
for name, s in srcs:
    # Comparisons: resolve an alias (FROM shift s ... s.state = 'X') to its
    # table and check THAT table's values. The column-name union let
    # s.state = 'CLOSED' pass on nozzle_assignment's account, and the Directors
    # page failed on every load.
    aliases = {a: t for t, a in re.findall(r"\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)\b", s, re.I)
               if a.upper() not in ('ON', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'USING', 'GROUP', 'ORDER', 'LIMIT')}
    for m in re.finditer(r"\b(?:(\w+)\.)?(\w+)\s*(?:=|<>|!=)\s*'([A-Z][A-Z0-9_]+)'", s):
        al, col, val = m.groups()
        where = f"{name}:{s[:m.start()].count(chr(10))+1}"
        if al and al in aliases and (aliases[al], col) in tdom:
            tcheck(where, aliases[al], col, val)
        else:
            check(where, col, val)
    for m in re.finditer(r"\b(?:\w+\.)?(\w+)\s+(?:NOT\s+)?IN\s*\(((?:\s*'[^']*'\s*,?)+)\)", s):
        for v in re.findall(r"'([^']*)'", m.group(2)): check(f"{name}:{s[:m.start()].count(chr(10))+1}", m.group(1), v)
    for m in re.finditer(r"INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.*?)\)\s*(?:RETURNING|;|ON|\n\s*\")", s, re.S):
        cols = [c.strip() for c in m.group(2).split(',')]
        vals = re.split(r",(?![^(]*\))", m.group(3))
        if len(cols) == len(vals):
            for c, v in zip(cols, vals):
                lit = re.fullmatch(r"\s*'([^']*)'(?:::\w+)?\s*", v)
                if lit: tcheck(f"{name}:{s[:m.start()].count(chr(10))+1} INSERT", m.group(1), c, lit.group(1))
    for m in re.finditer(r"UPDATE (\w+)(?:\s+\w+)?\s+SET\s+(.*?)(?:\s+WHERE\b|\s+FROM\b|\s+RETURNING\b|;|\"\"\")", s, re.S):
        for c, v in re.findall(r"\b(\w+)\s*=\s*'([A-Z][A-Z0-9_]+)'", m.group(2)):
            tcheck(f"{name}:{s[:m.start()].count(chr(10))+1} UPDATE", m.group(1), c, v)
    for m in re.finditer(r"'([A-Z][A-Z0-9_]+)'::(\w+)", s):
        if m.group(2) in E and m.group(1) not in E[m.group(2)]:
            problems.append(f"  X {name}:{s[:m.start()].count(chr(10))+1}  '{m.group(1)}'::{m.group(2)}  (allowed: {', '.join(E[m.group(2)])[:90]})")
# --- frontend: request-body literals and drop-down options bound to a field ---
snake = lambda k: re.sub(r"(?<!^)([A-Z])", r"_\1", k).lower()
for f in (R / 'web' / 'src' / 'app').rglob('*.tsx'):
    s = f.read_text(encoding='utf-8'); rel = str(f).split('app/')[1].split('/components')[0]
    for m in re.finditer(r"api\s*\.\s*(?:post|put)<[^>]*>\([^;]*?\);", s, re.S):
        for k, v in re.findall(r"\b(\w+):\s*'([A-Z][A-Z0-9_]+)'", m.group(0)):
            check(f"web {rel}:{s[:m.start()].count(chr(10))+1} request", snake(k), v)
    for m in re.finditer(r"<select[^>]*value=\{\w+\.(\w+)\}[^>]*>(.*?)</select>", s, re.S):
        for v in re.findall(r'<option value="([A-Z][A-Z0-9_]+)"', m.group(2)):
            check(f"web {rel}:{s[:m.start()].count(chr(10))+1} option", snake(m.group(1)), v)
for p in sorted(set(problems)): print(p)
print(f"columns with an allowed list: {len(dom)} | values outside it: {len(set(problems))}")
import sys; sys.exit(1 if len(set(problems)) else 0)
