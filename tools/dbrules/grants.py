"""
grants -- every DELETE the app runs is one fcms_app may run.

fcms_app is granted SELECT, INSERT and UPDATE on every table (080, and by
default privileges for later ones) and DELETE only where a migration says so.
Three features deleted where it had no such grant -- save roster, revoke
access, save calibration -- and failed on first use; PostgreSQL checks the
privilege even when no row matches. The integrity suite runs as the superuser,
so it could not see this. Code run by a SECURITY DEFINER function takes its
owner's rights and is not judged here.
"""
import re, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
strip = lambda s: re.sub(r"--[^\n]*", "", s)
mig = "\n".join(strip(p.read_text(encoding='utf-8')) for p in sorted((ROOT / 'db' / 'migrations').glob('*.sql')))
may = set()
for m in re.finditer(r"GRANT\s+([^;]*?)\s+ON\s+(?:TABLE\s+)?([\w\s,]+?)\s+TO\s+([\w\s,]+);", mig, re.S | re.I):
    if 'fcms_app' in m.group(3) and re.search(r"\bDELETE\b|\bALL\b", m.group(1), re.I):
        may |= {t.strip() for t in m.group(2).split(',')}
live = {}
for f in sorted((ROOT / 'db' / 'migrations').glob('*.sql')):
    s = strip(f.read_text(encoding='utf-8'))
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\((.*?)\$\$(.*?)\$\$", s, re.S):
        live[m.group(1)] = (f.name, m.group(3), 'SECURITY DEFINER' in m.group(2).upper())
srcs = [(str(f.relative_to(ROOT)), strip(f.read_text(encoding='utf-8')) if f.suffix == '.sql' else re.sub(r"//[^\n]*", "", f.read_text(encoding='utf-8')))
        for f in (ROOT / 'api').rglob('*.cs') if 'bin' not in f.parts and 'obj' not in f.parts]
srcs += [(f"{n}:{fn}", b) for fn, (n, b, definer) in live.items() if not definer]
bad = 0; seen = 0
for name, s in srcs:
    for m in re.finditer(r"\bDELETE\s+FROM\s+(\w+)", s, re.I):
        seen += 1
        if m.group(1) not in may:
            bad += 1
            print(f"  X {name}:{s[:m.start()].count(chr(10))+1}  DELETE FROM {m.group(1)} - fcms_app has no DELETE on it; this fails every time")
print(f"deletes checked: {seen} | without the privilege: {bad}")
sys.exit(1 if bad else 0)
