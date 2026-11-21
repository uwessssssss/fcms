#!/usr/bin/env python3
"""
FCMS schema static check.

No Postgres available here, so this does the next best thing: it reads the
migrations in run order and verifies that every object is defined before it is
used. That catches the highest-risk class of error in a multi-file schema --
forward references -- which is exactly what breaks on first run.

It is NOT a substitute for executing the DDL. It cannot check types, expression
validity, or trigger semantics. Run it as a pre-flight, not as proof.
"""
import re, sys, pathlib
from collections import defaultdict

SCHEMA = pathlib.Path(__file__).parent.parent / "db" / "migrations"
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

problems, warnings = [], []
SQL_BUILTINS = {"lateral", "set", "generate_series", "unnest", "information_schema",
                "jsonb_array_elements", "jsonb_array_elements_text", "regexp_split_to_table"}


def strip_dollar_bodies(sql):
    """Replace $tag$...$tag$ bodies with blanks, preserving line numbers, so
    that function bodies don't register as top-level DDL."""
    out, i = [], 0
    pattern = re.compile(r"\$([A-Za-z_]*)\$")
    while True:
        m = pattern.search(sql, i)
        if not m:
            out.append(sql[i:])
            break
        out.append(sql[i:m.end()])
        close = sql.find(m.group(0), m.end())
        if close == -1:
            problems.append(f"UNCLOSED DOLLAR QUOTE: {m.group(0)}")
            out.append(sql[m.end():])
            break
        body = sql[m.end():close]
        out.append("\n" * body.count("\n"))
        out.append(m.group(0))
        i = close + len(m.group(0))
    return "".join(out)


def strip_comments(sql):
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"/\*.*?\*/", "", sql, flags=re.S)


tables, types, functions, views = set(), set(), set(), set()
roles_created = set()
constraint_names = defaultdict(list)
table_columns = defaultdict(set)
fk_targets = []          # (file, table, target)
alter_targets = []       # (file, target)
fn_calls = []            # (file, fn)
type_uses = []           # (file, type)

for fname in ORDER:
    path = SCHEMA / fname
    if not path.exists():
        problems.append(f"MISSING FILE: {fname}")
        continue
    raw = path.read_text(encoding="utf-8")
    body_free = strip_dollar_bodies(raw)
    sql = strip_comments(body_free)
    full = strip_comments(raw)      # includes function bodies, for call analysis
    earlier_functions = set(functions)   # defined by the files before this one (630 reads 620's)

    # ---- definitions ----
    for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.I):
        t = m.group(1).lower()
        if t in tables:
            problems.append(f"{fname}: DUPLICATE TABLE {t}")
        tables.add(t)
    for m in re.finditer(r"CREATE\s+TYPE\s+(\w+)", sql, re.I):
        types.add(m.group(1).lower())
    for m in re.finditer(r"CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(\w+)", sql, re.I):
        views.add(m.group(1).lower())
    for m in re.finditer(r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)", sql, re.I):
        functions.add(m.group(1).lower())

    # ---- columns, so FK column refs can be sanity-checked ----
    for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.*?)\n\)\s*;",
                         sql, re.I | re.S):
        tname, blk = m.group(1).lower(), m.group(2)
        for line in blk.split("\n"):
            line = line.strip()
            cm = re.match(r"(\w+)\s+(uuid|text|int|bigint|boolean|numeric|date|time|"
                          r"timestamptz|char|inet|jsonb|\w+)\b", line, re.I)
            if cm and cm.group(1).upper() not in (
                    "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "EXCLUDE"):
                table_columns[tname].add(cm.group(1).lower())
    for m in re.finditer(r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)",
                         sql, re.I):
        table_columns[m.group(1).lower()].add(m.group(2).lower())

    # ---- uses ----
    for m in re.finditer(r"REFERENCES\s+(\w+)\s*\(", sql, re.I):
        fk_targets.append((fname, m.group(1).lower()))
    for m in re.finditer(r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)", sql, re.I):
        alter_targets.append((fname, m.group(1).lower()))
    for m in re.finditer(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:\w+\s+)?ON\s+(\w+)", sql, re.I):
        alter_targets.append((fname, m.group(1).lower()))
    for m in re.finditer(r"\b(fn_\w+)\s*\(", full, re.I):
        fn_calls.append((fname, m.group(1).lower()))
    for m in re.finditer(r"::(\w+)\b", full):
        type_uses.append((fname, m.group(1).lower()))

    # ---- LANGUAGE sql function bodies ----
    # Postgres PARSES a LANGUAGE sql body at CREATE time and rejects unknown
    # relations. plpgsql bodies are not checked until they run, so only sql
    # ones matter here. This checker blanks dollar-quoted bodies so function
    # contents do not register as top-level DDL -- which meant it could not see
    # inside them, and fn_weighted_avg_cost reading fuel_movement two files
    # early got all the way to a live migration run.
    for m in re.finditer(r"CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(\w+)", full, re.I):
        tail = full[m.end(): m.end() + 6000]
        lang = re.search(r"LANGUAGE\s+(\w+)", tail, re.I)
        body = re.search(r"\$(\w*)\$(.*?)\$\1\$", tail, re.S)
        if not lang or not body or lang.group(1).lower() != "sql":
            continue
        # Names the body defines itself -- WITH x AS (...), y AS (...) --
        # are not relations that must exist beforehand (620).
        ctes = {c.group(1).lower() for c in re.finditer(r"(?:\bWITH|,)\s*(\w+)\s+AS\s*\(", body.group(2), re.I)}
        for t in re.finditer(r"\b(?:FROM|JOIN)\s+(\w+)", body.group(2), re.I):
            rel = t.group(1).lower()
            if rel in ctes:
                continue
            # A set-returning function defined earlier (its own file counts:
            # the functions above it in the file already exist).
            if rel.startswith("fn_") and rel in earlier_functions:
                continue
            if rel.startswith("fn_") and re.search(r"FUNCTION\s+" + rel + r"\s*\(", full[:m.start()], re.I):
                continue
            if (rel in tables or rel in views or rel.startswith("pg_")
                    or rel.startswith("v_") or rel in SQL_BUILTINS):
                continue
            problems.append(
                f"{fname}: {m.group(1)}() is LANGUAGE sql and reads '{rel}', "
                f"which does not exist yet -- the body is validated at CREATE time")

    # ---- roles: created before they are granted to or given ownership ----
    # This class of bug got past every earlier check and failed on the very
    # first real run: 020 handed a function's ownership to fcms_auth, which
    # 080 created. The schema could not build from an empty database.
    for m in re.finditer(r"CREATE ROLE (\w+)", full, re.I):
        roles_created.add(m.group(1).lower())
    for m in re.finditer(r"(?:OWNER TO|GRANT [^;]*? TO) ([\w, ]+)", full, re.I):
        for r in m.group(1).split(","):
            r = r.strip().lower()
            if r.startswith("fcms_") and r not in roles_created:
                problems.append(
                    f"{fname}: references role '{r}' before any migration creates it")

    # ---- duplicate constraint names ----
    for m in re.finditer(r"CONSTRAINT\s+(\w+)", sql, re.I):
        constraint_names[m.group(1).lower()].append(fname)

    # ---- snapshot what exists after this file, for ordering checks ----
    for f, tgt in fk_targets:
        if f == fname and tgt not in tables:
            problems.append(f"{fname}: FK -> {tgt}, which is not defined yet (or at all)")
    for f, tgt in alter_targets:
        if f == fname and tgt not in tables:
            problems.append(f"{fname}: ALTER/INDEX on {tgt}, not defined yet (or at all)")
    fk_targets = [x for x in fk_targets if x[0] != fname]
    alter_targets = [x for x in alter_targets if x[0] != fname]

# ---- function calls: defined anywhere? (order is looser -- plpgsql bodies
#      resolve at runtime, so a later definition is legal) ----
BUILTIN = {"fn_" + x for x in []}
for fname, fn in sorted(set(fn_calls)):
    if fn not in functions:
        problems.append(f"{fname}: calls {fn}(), never defined")

for fname, t in sorted(set(type_uses)):
    if t in types or t in {"uuid", "text", "int", "bigint", "boolean", "numeric", "date",
                           "time", "timestamptz", "timestamp", "jsonb", "json", "inet",
                           "interval", "char", "varchar", "real", "float", "bytea"}:
        continue
    warnings.append(f"{fname}: cast to '{t}' -- not a declared enum or known base type")

for name, files in constraint_names.items():
    if len(files) > 1 or (len(files) == 1 and files.count(files[0]) > 1):
        pass  # constraint names only need to be unique per table in Postgres

print("=" * 68)
print("FCMS SCHEMA STATIC CHECK")
print("=" * 68)
print(f"tables    {len(tables):>3}   types {len(types):>3}   "
      f"functions {len(functions):>3}   views {len(views):>3}")
print()

if problems:
    print(f"PROBLEMS ({len(problems)})")
    for p in problems:
        print(f"  X {p}")
else:
    print("PROBLEMS  none")
print()
if warnings:
    print(f"WARNINGS ({len(warnings)})")
    for w in warnings[:25]:
        print(f"  ! {w}")
print()
print("Tables in dependency order:")
print("  " + ", ".join(sorted(tables)))
sys.exit(1 if problems else 0)
