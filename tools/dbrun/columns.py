import re, pathlib, subprocess, sys
"""
columns -- every query returns exactly the columns the C# class it fills expects.

Dapper matches columns to properties by name. A misnamed column is not an
error: the property is left empty and a screen shows a blank or a 0. The real
database describes each query's result (\\gdesc, nothing is run), and that is
compared with the class or record. Usage: python3 tools/dbrun/columns.py <db>
"""
import os
HERE = pathlib.Path(__file__).resolve()
ROOT = HERE.parents[2] / 'api'
DB = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('PGDATABASE', 'fcms')
sys.path.insert(0, str(HERE.parents[1]))
from check_dapper_params import balanced, top_args, sql_of   # the same parsers
src = {f: f.read_text(encoding='utf-8') for f in ROOT.rglob('*.cs') if 'bin' not in f.parts and 'obj' not in f.parts}
alltext = "\n".join(src.values())
def shape(t):
    m = re.search(rf"\b(?:class|record)\s+{t}\b\s*(\(([^)]*)\))?[^{{;]*([{{;])", alltext)
    if not m: return None, None
    if m.group(1):                                   # positional record: ctor params
        return 'ctor', {re.split(r"\s+", a.strip())[-1].lower() for a in top_args(m.group(2)) if a.strip()}
    i = m.end() - 1; j = balanced(alltext, i, '{', '}')
    body = alltext[i:j]
    props = {p.lower() for p in re.findall(r"public\s+[\w<>\[\]?,. ]+?\s+(\w+)\s*\{\s*get;", body)}
    return 'props', props
PRIM = {'int','long','decimal','string','Guid','bool','DateTime','DateOnly','double','object','dynamic','short'}
rep = 0; n = 0; undesc = 0
for f, s in src.items():
    for m in re.finditer(r"\.Query(?:Single|First)?(?:OrDefault)?Async<\s*([\w.?]+)\s*>\(\s*new CommandDefinition\(", s):
        t = m.group(1).rstrip('?').split('.')[-1]
        if t in PRIM or t.startswith('('): continue
        kind, members = shape(t)
        if not members: continue
        end = balanced(s, m.end() - 1); args = top_args(s[m.end():end])
        sql = sql_of(args[0]) if args else None
        if not sql: continue
        def typed(mm):
            n = mm.group(0)[1:].lower()
            if n in ('days', 'limit', 'n', 'top'): return '7'
            if n in ('from', 'to', 'on', 'date', 'day', 'since', 'until', 'businessdate'): return 'CURRENT_DATE'
            return 'NULL'
        # Comments are left in: PostgreSQL ignores them, and stripping '--' broke
        # a string literal holding ' -- '.
        q = re.sub(r"(?<![@\w:])@\w+", typed, sql).strip().rstrip(';')
        r = subprocess.run(["psql", "-d", DB, "-X", "-q", "-A", "-F", "|", "-t"],
                           input=q + "\n\\gdesc\n", capture_output=True, text=True)
        rows = [l.split('|')[0] for l in r.stdout.splitlines() if '|' in l]
        if r.returncode != 0 or not rows:
            undesc += 1
            if '--undesc' in sys.argv: print(f"  ~ {f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1} -> {t}: {(r.stderr.strip().splitlines() or ['?'])[0][:110]}")
            continue
        n += 1
        cols = {c.lower() for c in rows}
        where = f"{f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1} -> {t}"
        if kind == 'ctor':
            missing = sorted(members - cols); extra = sorted(cols - members)
            if missing or extra:
                rep += 1; print(f"  X {where}: record constructor does not match the columns  missing={missing} extra={extra}")
        else:
            unfilled = sorted(members - cols); dropped = sorted(cols - members)
            if unfilled or dropped:
                rep += 1; print(f"  ? {where}: never filled={unfilled}  columns with no property={dropped}")
print(f"queries described by the database: {n} | could not describe: {undesc} | mismatches: {rep}")
sys.exit(1 if rep or undesc else 0)
