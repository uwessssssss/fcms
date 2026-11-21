import re, pathlib
R = pathlib.Path(__file__).resolve().parents[2]
def strip(s): return re.sub(r"--[^\n]*", "", s)
def split_args(s, i):
    """args of the call whose '(' is at s[i]; returns (list, end)"""
    depth, j, cur, out, q = 0, i, '', [], None
    while j < len(s):
        ch = s[j]
        if q:
            cur += ch
            if ch == q: q = None
        elif ch == "'": q = "'"; cur += ch
        elif ch == '(':
            depth += 1
            if depth > 1: cur += ch
        elif ch == ')':
            depth -= 1
            if depth == 0:
                if cur.strip(): out.append(cur.strip())
                return out, j
            cur += ch
        elif ch == ',' and depth == 1: out.append(cur.strip()); cur = ''
        else: cur += ch
        j += 1
    return None, j
sigs = {}
mig = [(f.name, strip(f.read_text(encoding='utf-8'))) for f in sorted((R / 'db' / 'migrations').glob('*.sql'))]
for name, s in mig:
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\(", s):
        args, _ = split_args(s, m.end() - 1)
        if args is None: continue
        total = len(args); req = sum(1 for a in args if not re.search(r"\bDEFAULT\b|=", a, re.I))
        sigs.setdefault(m.group(1), set()).add((req, total))
# live bodies only, plus everything outside function bodies, plus C# and seeds
live = {}
srcs = []
for name, s in mig:
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\((.*?)\$\$(.*?)\$\$", s, re.S): live[m.group(1)] = (name, m.group(3))
    srcs.append((name, re.sub(r"CREATE OR REPLACE FUNCTION .*?\$\$.*?\$\$", "", s, flags=re.S)))
srcs += [(f"{n}:{fn}", b) for fn, (n, b) in live.items()]
srcs += [(f.name, f.read_text(encoding='utf-8')) for f in (R / 'api').rglob('*.cs') if 'bin' not in f.parts]
srcs += [('seed/' + f.name, strip(f.read_text(encoding='utf-8'))) for f in sorted((R / 'db' / 'seed').glob('*.sql'))]
srcs += [('test/integrity.sql', strip((R / 'db' / 'test' / 'integrity.sql').read_text(encoding='utf-8')))]
bad = checked = 0
for name, s in srcs:
    for m in re.finditer(r"(?<![\w.])(fn_\w+)\(", s):
        fn = m.group(1)
        if fn not in sigs: continue
        pre = s[max(0, m.start() - 40):m.start()]
        if re.search(r"(FUNCTION|PROCEDURE)\s+$", pre, re.I): continue
        args, _ = split_args(s, m.end() - 1)
        if args is None: continue
        checked += 1
        n = len(args)
        if not any(req <= n <= total for req, total in sigs[fn]):
            bad += 1
            print(f"  X {name}:{s[:m.start()].count(chr(10))+1}  {fn}() called with {n} argument(s); takes " +
                  " or ".join(f"{r}" if r == t else f"{r}-{t}" for r, t in sorted(sigs[fn])))
print(f"calls to the project's own SQL functions checked: {checked} | wrong argument count: {bad}")
import sys; sys.exit(1 if bad else 0)
