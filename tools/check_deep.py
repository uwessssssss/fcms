#!/usr/bin/env python3
"""
FCMS deep migration check - column-level structural validation.

Written after three consecutive live-run failures that the other checkers could
not see:

  * a function whose ownership went to a role created two files later
  * a LANGUAGE sql body reading a table created two files later
  * non-ASCII comment characters that psql on Windows could not decode

Each was a different shape of the same mistake: something referenced before it
existed. This walks the migrations in run order and validates, at COLUMN level,
that every foreign key, index, enum label, trigger function and function body
refers to something that already exists at that point.

It is still static. It cannot catch a wrong expression, a trigger that fires in
the wrong order, or arithmetic that does not balance - only db/test/integrity.sql
run against a live database does that.
"""
import re, pathlib, collections, sys
def migration_order():
    """
    The run order, read from migrate.sh rather than hardcoded here.

    Both this file and check_schema.py carried their own copy of the list, and
    both silently stopped checking at 080 while three later migrations were
    added -- so the tables in them were never validated at all. One source of
    truth, and it is the file that actually runs them.
    """
    runner = (pathlib.Path(__file__).parent.parent / "db" / "migrate.sh").read_text(
        encoding="utf-8")
    return re.findall(r"^\s{2}(\d{3}_\w+\.sql)", runner, re.M)


ORDER = migration_order()
M = pathlib.Path(__file__).parent.parent / 'db' / 'migrations'
issues = []
tables = {}          # table -> set(columns)
enums  = {}          # enum  -> set(labels)
funcs, views = set(), set()

def strip(s):
    s = re.sub(r"--[^\n]*", "", s)
    return re.sub(r"/\*.*?\*/", "", s, flags=re.S)

for fn in ORDER:
    raw = (M/fn).read_text(encoding="utf-8")
    src = strip(raw)

    for m in re.finditer(r"CREATE TYPE (\w+) AS ENUM\s*\((.*?)\)\s*;", src, re.S|re.I):
        enums[m.group(1).lower()] = {x.strip().strip("'") for x in
                                     re.findall(r"'([^']+)'", m.group(2))}

    for m in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)\s*;", src, re.S|re.I):
        t = m.group(1).lower(); cols=set()
        depth=0; cur=""
        for line in m.group(2).split("\n"):
            ls=line.strip()
            cm = re.match(r"(\w+)\s+[a-z]", ls, re.I)
            if cm and cm.group(1).upper() not in ("PRIMARY","UNIQUE","CHECK","FOREIGN","CONSTRAINT","EXCLUDE"):
                cols.add(cm.group(1).lower())
        tables[t]=cols

    for m in re.finditer(r"ALTER TABLE (?:IF EXISTS )?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)", src, re.I):
        tables.setdefault(m.group(1).lower(), set()).add(m.group(2).lower())
    for m in re.finditer(r"CREATE (?:OR REPLACE )?VIEW (\w+)", src, re.I): views.add(m.group(1).lower())
    for m in re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION (\w+)", src, re.I): funcs.add(m.group(1).lower())

    # --- ALTER TABLE ... ADD CONSTRAINT: does the named FK column exist?
    for m in re.finditer(r"ALTER TABLE (\w+)[^;]*?FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)", src, re.I|re.S):
        t, cols, ref = m.group(1).lower(), m.group(2), m.group(3).lower()
        for c in [x.strip().lower() for x in cols.split(",")]:
            if t in tables and c not in tables[t]:
                issues.append(f"{fn}: {t}.{c} in FOREIGN KEY does not exist")
        if ref not in tables:
            issues.append(f"{fn}: FK references table {ref}, not defined")

    # --- CREATE INDEX ON t (cols)
    for m in re.finditer(r"CREATE (?:UNIQUE )?INDEX(?: \w+)? ON (\w+)\s*\(([^)]+)\)", src, re.I):
        t = m.group(1).lower()
        if t not in tables: continue
        for c in re.findall(r"\b([a-z_][a-z0-9_]*)\b", m.group(2).lower()):
            if c in ("desc","asc","nulls","first","last","text_pattern_ops","gist","btree"): continue
            if c not in tables[t] and not c.startswith("fn_"):
                issues.append(f"{fn}: index on {t}({c}) - no such column")

    # --- enum labels used in casts / comparisons
    for m in re.finditer(r"'([A-Z_]+)'::(\w+)", raw):
        lbl, ty = m.group(1), m.group(2).lower()
        if ty in enums and lbl not in enums[ty]:
            issues.append(f"{fn}: '{lbl}' is not a label of enum {ty}")

    # --- trigger functions referenced by CREATE TRIGGER
    for m in re.finditer(r"EXECUTE FUNCTION (\w+)\(", src, re.I):
        if m.group(1).lower() not in funcs:
            issues.append(f"{fn}: trigger uses {m.group(1)}(), not defined yet")

    # --- plpgsql bodies: tables referenced that never exist anywhere
    for m in re.finditer(r"\$(\w*)\$(.*?)\$\1\$", raw, re.S):
        # Strip single-quoted strings as well as comments. An error message
        # reading "cannot move fuel from a % tank" contains the word FROM
        # followed by a word, and reads as a table reference otherwise.
        # STRINGS FIRST, THEN COMMENTS -- that order is the whole point.
        # strip() removes everything after a `--` to end of line. Our error
        # messages use `--` as a dash INSIDE the text: "...head office -- '".
        # Stripping comments first ate the closing quote, unbalanced every
        # literal after it, and exposed the prose: "from inside the
        # application" was then read as a FROM clause naming a table called
        # `inside`. A `--` inside a string is not a comment.
        body = strip(re.sub(r"'(?:[^']|'')*'", "''", m.group(2)))
        # `a IS [NOT] DISTINCT FROM b` is a comparison, not a FROM clause. It
        # passed until now only because every right-hand side was a string or
        # OLD.x; `shift_id IS DISTINCT FROM p_shift_id` read as a table.
        body = re.sub(r"\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\s+", "IS DISTINCT_FROM ", body, flags=re.I)
        # Names the body defines itself (WITH x AS (...), y AS (...)) are
        # relations of that body, not tables that must exist (620).
        ctes = {c.group(1).lower() for c in re.finditer(r"(?:\bWITH|,)\s*(\w+)\s+AS\s*\(", body, re.I)}
        for t in re.finditer(r"(?<![@\w])(?:FROM|JOIN|INSERT INTO|UPDATE)\s+(\w+)", body, re.I):
            r = t.group(1).lower()
            if r in ctes:
                continue
            # A set-returning function is a legitimate relation source in FROM.
            # fn_customer_headroom(...) returns TABLE(...) and reads exactly
            # like a table there.
            if (r in tables or r in views or r.startswith("pg_") or r.startswith("v_")
                or r.startswith("fn_")
                or r in ("lateral","set","only","new","old","generate_series","jsonb_array_elements",
                         "information_schema","unnest")):
                continue
            issues.append(f"{fn}: function body references '{r}' - unknown relation")

# --- SECURITY DEFINER functions: does the OWNER have table privileges?
#
# BYPASSRLS lets a role past row-level policies. It does NOT grant access to
# the table at all - those are separate mechanisms. Confusing them meant
# fn_auth_lookup (SECURITY DEFINER, owned by fcms_auth) failed with
# "permission denied for table staff" on the very first login.
allsql = "\n".join(strip((M/f).read_text(encoding="utf-8")) for f in ORDER)
for m in re.finditer(r"CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(\w+)(.*?)\$(\w*)\$(.*?)\$\3\$",
                     allsql, re.S | re.I):
    name, sig, body = m.group(1), m.group(2), m.group(4)
    if "SECURITY DEFINER" not in sig.upper():
        continue
    own = re.search(rf"ALTER FUNCTION {re.escape(name)}\([^)]*\)\s+OWNER TO (\w+)",
                    allsql, re.I)
    if not own:
        continue
    owner = own.group(1)
    for t in re.finditer(r"\b(?:FROM|JOIN|UPDATE|INSERT INTO)\s+(\w+)", body, re.I):
        rel = t.group(1).lower()
        if rel not in tables:
            continue
        granted = re.search(
            rf"GRANT[^;]*\bON\b[^;]*\b{rel}\b[^;]*TO[^;]*\b{owner}\b", allsql, re.I | re.S)
        allrel = re.search(rf"GRANT[^;]*ON ALL TABLES IN SCHEMA public TO[^;]*\b{owner}\b",
                           allsql, re.I)
        if not granted and not allrel:
            issues.append(
                f"{name}() is SECURITY DEFINER owned by {owner}, reads '{rel}', "
                f"but {owner} has no GRANT on it")

# --- ON CONFLICT on a table carrying rules
#
# Postgres refuses "INSERT ... ON CONFLICT" on any table with an INSERT or
# UPDATE rule. The ledgers all carry DO INSTEAD NOTHING rules to make them
# append-only, so an idempotency guard that works everywhere else fails
# precisely on the tables that matter most.
ruled = set(re.findall(r"CREATE RULE \w+ AS ON (?:INSERT|UPDATE) TO (\w+)", allsql, re.I))
for extra in list(pathlib.Path(M.parent / "seed").glob("*.sql")) + \
             list(pathlib.Path(M.parent / "test").glob("*.sql")):
    src = strip(extra.read_text(encoding="utf-8"))
    for m in re.finditer(r"INSERT INTO (\w+)[^;]*?ON CONFLICT[^;]*?;", src, re.S):
        if m.group(1).lower() in {r.lower() for r in ruled}:
            issues.append(
                f"{extra.name}: ON CONFLICT on '{m.group(1)}', which carries a rule - "
                f"Postgres rejects this")

# --- index expressions must be IMMUTABLE
#
# Postgres refuses a STABLE function in an index expression, and the refusal is
# correct: `loaded_at::date` depends on the TimeZone setting, so the same row
# could sort into different days on different connections and the index would
# be quietly wrong.
#
# It also refuses at CREATE time, which means a migration that has passed every
# structural check still dies on the machine it is deployed to.
NOT_IMMUTABLE = ("::date", "::time", "::timestamp", "now()", "current_date",
                 "date_trunc", "to_char", "age(")
for fname in ORDER:
    src = strip((M / fname).read_text(encoding="utf-8"))
    for m in re.finditer(r"CREATE (?:UNIQUE )?INDEX[^;]*?;", src, re.S):
        body = m.group(0)
        if "(" not in body:
            continue
        # only the indexed expression, not a WHERE clause on a partial index
        expr = body[body.index("("):]
        expr = expr.split(" WHERE ")[0]
        for hazard in NOT_IMMUTABLE:
            if hazard in expr:
                issues.append(
                    f"{fname}: index expression contains '{hazard}', which is not "
                    f"IMMUTABLE - Postgres rejects this at CREATE time")


# --- a policy test placed where it cannot be true
#
# The integrity suite runs as postgres, and a SUPERUSER BYPASSES RLS ENTIRELY.
# Any test asserting that a row-level policy refuses something must sit after
# `SET LOCAL ROLE fcms_app`, or it proves nothing -- and worse, a test that
# expects a refusal will FAIL, sending somebody hunting a schema bug that is
# not there.
#
# This has now happened twice in this project: once with the tenant-isolation
# tests, and again with the delete-policy tests, which I wrote after adding the
# comment warning about it.
suite = M.parent / "test" / "integrity.sql"
if suite.exists():
    text = suite.read_text(encoding="utf-8")
    switch = text.find("SET LOCAL ROLE fcms_app")
    if switch >= 0:
        for m in re.finditer(r"SELECT test_(?:refuses|allows)\('([^']*)'", text[:switch]):
            # Only the test's own $sql$ body. Anything wider picks up prose
            # from the NEXT section's comment header -- the word "policy" in a
            # comment three lines below flagged a function-behaviour test.
            body_end = text.find("$sql$,", m.end())
            if body_end < 0:
                continue
            window = text[m.end(): body_end]
            if re.search(r"policy|RESTRICTIVE|row.level|DELETE FROM|RLS", window, re.I):
                line = text[: m.start()].count("\n") + 1
                issues.append(
                    f"integrity.sql:{line}: '{m.group(1)}' tests a row-level policy "
                    f"but runs before SET LOCAL ROLE fcms_app - as superuser the "
                    f"policy is bypassed and the test proves nothing")


# --- a trigger shared by tables reads a field one of them lacks
#
# Found by the first real run, not by any check: 370's trigger served both
# credit_sale and bulk_sale and wrote
#     TG_TABLE_NAME = 'bulk_sale' AND NEW.payment_terms ...
# trusting the AND to skip the second half for credit_sale. PL/pgSQL resolves
# NEW.payment_terms anyway and fails -- every pump credit sale was refused.
# A field one table lacks may be read only INSIDE an `IF TG_TABLE_NAME = 'x'`
# block for a table that has it.
def _shared_trigger_fields():
    found = []
    allsql = "\n".join(re.sub(r"--[^\n]*", "", f.read_text(encoding="utf-8")) for f in sorted(M.glob("*.sql")))
    cols = {}
    for m in re.finditer(r"CREATE TABLE (\w+)\s*\((.*?)\n\);", allsql, re.S):
        cols[m.group(1)] = {l.strip().split()[0] for l in m.group(2).split("\n") if re.match(r"\s+[a-z_]+\s+\w", l)}
    for m in re.finditer(r"ALTER TABLE (\w+)\s+(ADD COLUMN[^;]*);", allsql):
        for c in re.finditer(r"ADD COLUMN (?:IF NOT EXISTS )?(\w+)", m.group(2)):
            cols.setdefault(m.group(1), set()).add(c.group(1))
    uses = {}
    # [^;]*? -- within ONE statement. A dynamic "ON %I" (530) matches no
    # table, and .*? then ran on into later statements and took the first
    # "ON n" of a "JOIN nozzle n ON n.id" for the trigger's table.
    for m in re.finditer(r"CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+\w+[^;]*?\s+ON\s+(\w+)[^;]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)\(", allsql):
        uses.setdefault(m.group(2), set()).add(m.group(1))
    bodies = {}
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\(\)\s*RETURNS trigger.*?\$\$(.*?)\$\$", allsql, re.S):
        bodies[m.group(1)] = m.group(2)                   # the last definition is the live one
    for fn, tables in uses.items():
        if len(tables) < 2 or fn not in bodies:
            continue
        body = bodies[fn]
        if re.search(r"TG_TABLE_NAME\s*=\s*'\w+'\s+AND\s+(?:NEW|OLD)\.", body, re.I):
            found.append(f"{fn}: tests TG_TABLE_NAME and reads a field in ONE expression - PL/pgSQL "
                         f"does not skip the second half; nest the read inside IF TG_TABLE_NAME = ...")
        guarded = []
        for g in re.finditer(r"IF\s+TG_TABLE_NAME\s*=\s*'(\w+)'\s+THEN", body, re.I):
            depth, i = 1, g.end()
            while depth and i < len(body):
                nxt = re.search(r"\bEND\s+IF\b|\bIF\b", body[i:], re.I)
                if not nxt:
                    break
                depth += -1 if nxt.group(0).upper().startswith("END") else 1
                i += nxt.end()
            guarded.append((g.group(1), g.start(), i))
        for r in re.finditer(r"\b(?:NEW|OLD)\.(\w+)", body):
            lacking = [t for t in tables if r.group(1) not in cols.get(t, set())]
            if lacking and not any(lo <= r.start() < hi and r.group(1) in cols.get(tbl, set())
                                   for tbl, lo, hi in guarded):
                found.append(f"{fn}: reads {r.group(0)} but {', '.join(sorted(lacking))} has no such "
                             f"field and the read is not inside an IF TG_TABLE_NAME branch")
    return found

issues.extend(_shared_trigger_fields())

print("="*66)
print("DEEP MIGRATION CHECK")
print("="*66)
print(f"tables {len(tables)}  enums {len(enums)}  functions {len(funcs)}  views {len(views)}")
print()
seen=set(); out=[i for i in issues if not (i in seen or seen.add(i))]
if out:
    print(f"FINDINGS ({len(out)})")
    for i in out: print("  X", i)
else:
    print("No structural problems found.")
sys.exit(1 if out else 0)
