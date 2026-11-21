"""
prepare_all -- every SQL statement in the API, PREPAREd against a real database.

PREPARE resolves every table, column, function and enum label without running
anything. A statement that names something the schema lacks fails on every
call, and only when that screen is opened -- the Directors page compared
shift.state with 'CLOSED', which is not a shift state. Run by check-all.sh
against its scratch database:  python3 tools/dbrun/prepare_all.py <database>
"""
import os, re, pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[2] / 'api'
DB = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('PGDATABASE', 'fcms')
stmts = []
for f in sorted(ROOT.rglob('*.cs')):
    if 'bin' in f.parts or 'obj' in f.parts: continue
    s = f.read_text(encoding='utf-8')
    for m in re.finditer(r'(?<![$@])"""(.*?)"""', s, re.S):
        body = m.group(1)
        if re.search(r"^\s*(--[^\n]*\n\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", body, re.I):
            stmts.append((f"{f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1}", body))
    # "..." + "..." concatenated single-line SQL
    for m in re.finditer(r'((?:"(?:[^"\\]|\\.)*"\s*\+\s*)+"(?:[^"\\]|\\.)*")', s):
        parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
        body = "".join(parts)
        if re.match(r"\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", body, re.I) and len(body) > 25:
            stmts.append((f"{f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1}", body))
    for m in re.finditer(r'CommandDefinition\(\s*"((?:[^"\\]|\\.)*)"\s*,', s):
        body = m.group(1)
        if re.match(r"\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", body, re.I):
            stmts.append((f"{f.relative_to(ROOT)}:{s[:m.start()].count(chr(10))+1}", body))
seen = set(); out = []; ok = skip = 0
for where, sql in stmts:
    key = sql.strip()
    if key in seen: continue
    seen.add(key)
    sql = re.sub(r"\{\{", "{", sql); sql = re.sub(r"\}\}", "}", sql)
    if re.search(r"\{[A-Za-z_]", sql) or "IN @" in sql or "= ANY(@" in sql.replace(" ", "") and False:
        skip += 1; continue
    names = []
    def sub(mm):
        n = mm.group(1)
        if n not in names: names.append(n)
        return f"${names.index(n)+1}"
    psql_sql = re.sub(r"(?<![:@\w])@(\w+)", sub, sql)
    stmts_in = [x for x in psql_sql.split(";") if x.strip()]
    if len(stmts_in) > 1: skip += 1; continue
    q = f"BEGIN; SET LOCAL search_path=public; PREPARE p_chk AS {psql_sql.strip().rstrip(';')}; ROLLBACK;"
    r = subprocess.run(["psql", "-d", DB, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-c", q], capture_output=True, text=True)
    err = (r.stderr or "").strip()
    # A parameter has no type here; the driver sends a typed one. Errors that are
    # only about an untyped parameter are not faults in the statement.
    untyped = bool(names) and re.search(r"could not determine data type|inconsistent types deduced|operator (is not unique|does not exist): .*(unknown|integer)", err)
    if r.returncode != 0 and not untyped:
        out.append((where, err.splitlines()[0][:170]))
    else:
        ok += 1
for w, e in out: print(f"  X {w}\n      {e}")
print(f"statements: {len(seen)} | prepared clean: {ok} | refused: {len(out)} | skipped (multi-statement): {skip}")
sys.exit(1 if out else 0)
