import re, json, pathlib
S = json.load(open(str(pathlib.Path(__file__).with_name('.schema.json')))); T = S['tables']
R = pathlib.Path(__file__).resolve().parents[2]
def strip(s): return re.sub(r"--[^\n]*", "", s)
srcs = []
# C#: whole files (SQL lives in raw strings)
for f in (R / 'api').rglob('*.cs'):
    if 'bin' in f.parts or 'obj' in f.parts: continue
    srcs.append((f.name, f.read_text(encoding='utf-8')))
# migrations: only the LIVE body of each function, plus top-level statements
live = {}
for f in sorted((R / 'db' / 'migrations').glob('*.sql')):
    s = strip(f.read_text(encoding='utf-8'))
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\((.*?)\$\$(.*?)\$\$", s, re.S):
        live[m.group(1)] = (f.name, m.group(3))
    top = re.sub(r"CREATE OR REPLACE FUNCTION .*?\$\$.*?\$\$", "", s, flags=re.S)
    srcs.append((f.name + ' (top level)', top))
for fn, (fname, body) in live.items(): srcs.append((f"{fname}:{fn}", body))
for f in sorted((R / 'db' / 'seed').glob('*.sql')): srcs.append(('seed/' + f.name, strip(f.read_text(encoding='utf-8'))))
problems = 0; checked = 0
for name, s in srcs:
    for m in re.finditer(r"INSERT INTO (\w+)\s*\(([^)]*)\)", s):
        t = m.group(1)
        if t not in T: continue
        given = {c.strip() for c in m.group(2).split(',') if c.strip()}
        if any(not re.match(r"^\w+$", c) for c in given): continue
        checked += 1
        missing = sorted(c for c, d in T[t].items() if d['notnull'] and not d['default'] and c not in given)
        unknown = sorted(c for c in given if c not in T[t])
        if missing or unknown:
            problems += 1
            line = s[:m.start()].count('\n') + 1
            print(f"  X {name}:{line} INSERT INTO {t}" + (f"  missing required: {', '.join(missing)}" if missing else "") + (f"  unknown: {', '.join(unknown)}" if unknown else ""))
# UPDATE ... SET a = .., b = ..: every column set must exist on the table. Only
# inserts were checked, and the depot close set a close_note that shift lacks.
def top_split(x):
    out, d, cur, q = [], 0, '', False
    for ch in x:
        if ch == "'": q = not q
        if not q and ch == '(': d += 1
        if not q and ch == ')': d -= 1
        if ch == ',' and d == 0 and not q: out.append(cur); cur = ''
        else: cur += ch
    out.append(cur); return out
ucheck = 0
for name, s in srcs:
    for m in re.finditer(r"UPDATE (\w+)(?:\s+(?!SET\b)\w+)?\s+SET\s+(.*?)(?:\s+WHERE\b|\s+FROM\b|\s+RETURNING\b|;|\"\"\"|\"\s*[,+)])", s, re.S):
        tname = m.group(1)
        if tname not in T: continue
        ucheck += 1
        for part in top_split(m.group(2)):
            cm = re.match(r"\s*(\w+)\s*=", part)
            if cm and cm.group(1) not in T[tname]:
                problems += 1
                print(f"  X {name}:{s[:m.start()].count(chr(10))+1} UPDATE {tname} SET {cm.group(1)}  - no such column")
print(f"inserts checked: {checked} | updates checked: {ucheck} | problems: {problems}")
import sys; sys.exit(1 if problems else 0)
