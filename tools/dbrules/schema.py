"""A model of the database built from the migrations, in order."""
import re, pathlib, json
M = pathlib.Path(__file__).resolve().parents[2] / 'db' / 'migrations'

def strip(s): return re.sub(r"--[^\n]*", "", s)

def split_top(body):
    out, depth, cur = [], 0, ''
    for ch in body:
        if ch == '(': depth += 1
        elif ch == ')': depth -= 1
        if ch == ',' and depth == 0: out.append(cur); cur = ''
        else: cur += ch
    out.append(cur); return [x.strip() for x in out if x.strip()]

tables, enums, checks = {}, {}, []
named = {}   # constraint name -> index in checks, so a DROP removes it
for f in sorted(M.glob('*.sql')):
    s = strip(f.read_text(encoding='utf-8'))
    for m in re.finditer(r"CREATE TYPE (\w+) AS ENUM \(([^)]*)\)", s):
        enums[m.group(1)] = re.findall(r"'([^']+)'", m.group(2))
    for m in re.finditer(r"ALTER TYPE (\w+) ADD VALUE (?:IF NOT EXISTS )?'([^']+)'", s):
        enums.setdefault(m.group(1), []).append(m.group(2))
    for m in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\);", s, re.S):
        t = m.group(1); cols = {}
        for part in split_top(m.group(2)):
            low = part.upper()
            if low.startswith(('CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY KEY', 'FOREIGN KEY', 'EXCLUDE')):
                nm = re.match(r"CONSTRAINT\s+(\w+)", part, re.I)
                for c in re.finditer(r"CHECK\s*\((.*)\)", part, re.S):
                    checks.append((t, None, c.group(1)))
                    if nm: named[nm.group(1)] = len(checks) - 1
                continue
            w = part.split()
            if len(w) < 2: continue
            name, typ = w[0], w[1].rstrip(',')
            cols[name] = dict(type=typ.lower(),
                notnull=('NOT NULL' in low or 'PRIMARY KEY' in low),
                default=('DEFAULT' in low or 'GENERATED' in low or typ.lower() in ('serial', 'bigserial')),
                file=f.name)
            for c in re.finditer(r"CHECK\s*\((.*)\)", part, re.S): checks.append((t, name, c.group(1)))
        tables[t] = cols
    for m in re.finditer(r"ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(\w+)\s+(.*?);", s, re.S):
        t, rest = m.group(1), m.group(2)
        for a in split_top(rest):
            am = re.match(r"ADD COLUMN (?:IF NOT EXISTS )?(\w+)\s+(\w+)(.*)", a, re.S | re.I)
            if am and t in tables:
                low = am.group(3).upper()
                tables[t][am.group(1)] = dict(type=am.group(2).lower(), notnull='NOT NULL' in low,
                                             default='DEFAULT' in low or 'GENERATED' in low, file=f.name)
                for c in re.finditer(r"CHECK\s*\((.*)\)", am.group(3), re.S): checks.append((t, am.group(1), c.group(1)))
            am = re.match(r"ALTER COLUMN (\w+) (SET DEFAULT|DROP NOT NULL|SET NOT NULL|DROP DEFAULT)", a, re.I)
            if am and t in tables and am.group(1) in tables[t]:
                op = am.group(2).upper(); c = tables[t][am.group(1)]
                if op == 'SET DEFAULT': c['default'] = True
                if op == 'DROP DEFAULT': c['default'] = False
                if op == 'DROP NOT NULL': c['notnull'] = False
                if op == 'SET NOT NULL': c['notnull'] = True
            am = re.match(r"ADD (?:CONSTRAINT (\w+) )?CHECK\s*\((.*)\)", a, re.S | re.I)
            if am and t in tables:
                checks.append((t, None, am.group(2)))
                if am.group(1): named[am.group(1)] = len(checks) - 1
            am = re.match(r"DROP CONSTRAINT (?:IF EXISTS )?(\w+)", a, re.I)
            if am and am.group(1) in named:
                checks[named.pop(am.group(1))] = None
checks = [c for c in checks if c]
json.dump(dict(tables=tables, enums=enums, checks=checks), open(str(pathlib.Path(__file__).with_name('.schema.json')), 'w'))
req = sum(1 for t in tables.values() for c in t.values() if c['notnull'] and not c['default'])
print(f"tables {len(tables)} | columns {sum(len(t) for t in tables.values())} | required without default {req} | enums {len(enums)} | CHECKs {len(checks)}")
