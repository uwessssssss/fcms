#!/usr/bin/env python3
"""
check_seed.py -- do the seed files agree with the schema?

Nothing checked them. Every other layer had a checker: the migrations, the C#
queries, the contract between API and client, the TypeScript. The seeds -- the
thing you run on a fresh database before anything else -- were validated by
running them and reading the errors.

That matters more than it sounds. A seed runs as ONE transaction. A single bad
column name in the last statement rolls back the whole thing, and the database
is left EMPTY rather than half-populated. The next thing you see is not the
SQL error you scrolled past, it is "unknown or inactive MGR01" at the login
screen, which looks like a completely different problem.

What this checks, reusing the schema check_sql.py already builds:

  * every table an INSERT or UPDATE names exists
  * every column they name exists on that table
  * every enum literal written against an enum column is one of its values
  * every NOT NULL column with no default is supplied by an INSERT

The last one catches the failure that leaves a fresh database silently empty.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "check_sql", pathlib.Path(__file__).parent / "check_sql.py")
check_sql = importlib.util.module_from_spec(spec)
_stdout = sys.stdout
sys.stdout = open("/dev/null", "w")          # loading it prints its own report
try:
    spec.loader.exec_module(check_sql)
except SystemExit:
    pass
finally:
    sys.stdout.close()
    sys.stdout = _stdout

ROOT = pathlib.Path(__file__).parent.parent
SEED = ROOT / "db" / "seed"
TABLES = check_sql.TABLES
ENUM_COLS = getattr(check_sql, "ENUM_COLS", {})
ENUM_VALUES = getattr(check_sql, "ENUM_VALUES", {})
strip_sql = check_sql.strip_sql

# The types a column can be declared as -- built-ins plus every enum the
# migrations define, so an enum-typed column is recognised too.
BUILTIN_TYPES = [
    "uuid", "text", "boolean", "bool", "date", "time", "timestamptz", "timestamp",
    "numeric", "decimal", "int", "integer", "bigint", "smallint", "serial",
    "bigserial", "jsonb", "json", "bytea", "interval", "char", "varchar",
    "citext", "inet", "money", "real", "double",
]
TYPE_RE = "|".join(sorted(set(BUILTIN_TYPES) | {e for e in check_sql.ENUMS}, key=len, reverse=True))

# Columns a row must carry: NOT NULL, no default, not generated.
REQUIRED: dict[str, set[str]] = {}
ALL_SQL = check_sql.ALL_SQL
for chunk in re.split(r"(?=CREATE TABLE )", ALL_SQL):
    m = re.match(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)", chunk, re.S | re.I)
    if not m:
        continue
    table, body = m.group(1).lower(), m.group(2)
    need = set()
    for line in body.split("\n"):
        line = line.strip().rstrip(",")
        # A column line is `name TYPE ...`. Matching on the TYPE is what makes
        # this safe: the continuation line of a multi-line CHECK constraint
        # reads like `or something NOT NULL`, and a looser pattern reported a
        # required column called "or" in three seed files.
        cm = re.match(rf"(\w+)\s+({TYPE_RE})\b", line, re.I)
        if not cm or cm.group(1).upper() in ("CONSTRAINT", "PRIMARY", "UNIQUE",
                                             "CHECK", "FOREIGN", "EXCLUDE", "LIKE"):
            continue
        col = cm.group(1).lower()
        if "NOT NULL" in line.upper() and "DEFAULT" not in line.upper() \
                and "GENERATED" not in line.upper():
            need.add(col)
    REQUIRED[table] = need

SEED_LOCALS: set[str] = set()   # psql \set variables, not columns
problems: list[str] = []
notes: list[str] = []
statements = 0

for f in sorted(SEED.glob("*.sql")):
    sql = strip_sql(f.read_text(encoding="utf-8"))

    for m in re.finditer(r"INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)", sql, re.I | re.S):
        statements += 1
        table = m.group(1).lower()
        if table not in TABLES:
            problems.append(f"{f.name}: INSERT INTO {table} - no such table")
            continue
        cols = [c.strip().lower() for c in m.group(2).split(",") if c.strip()]
        unknown = [c for c in cols if c not in TABLES[table]]
        if unknown:
            problems.append(
                f"{f.name}: {table} has no column {', '.join(unknown)}")
        missing = sorted(REQUIRED.get(table, set()) - set(cols))
        if missing:
            problems.append(
                f"{f.name}: INSERT INTO {table} leaves out {', '.join(missing)} "
                f"- required, and the whole seed rolls back")

    for m in re.finditer(r"UPDATE\s+(\w+)\s+SET\s+(.*?)(?:\sWHERE\s|;)", sql, re.I | re.S):
        statements += 1
        table = m.group(1).lower()
        if table not in TABLES:
            problems.append(f"{f.name}: UPDATE {table} - no such table")
            continue
        for cm in re.finditer(r"(\w+)\s*=", m.group(2)):
            col = cm.group(1).lower()
            if col not in TABLES[table] and col not in SEED_LOCALS:
                problems.append(f"{f.name}: {table} has no column {col}")

    # Enum literals, where the schema says the column is an enum.
    for table, colmap in ENUM_COLS.items():
        for col, enum in colmap.items():
            values = ENUM_VALUES.get(enum)
            if not values:
                continue
            for m in re.finditer(rf"\b{col}\s*=\s*'([A-Za-z_]+)'", sql):
                if m.group(1) not in values:
                    problems.append(
                        f"{f.name}: {table}.{col} = '{m.group(1)}' is not a "
                        f"{enum} value")

print("=" * 70)
print("SEED vs SCHEMA")
print("  the one layer nothing checked")
print("=" * 70)
print(f"seed files {len(list(SEED.glob('*.sql')))}  statements checked {statements}")
if problems:
    print(f"\nPROBLEMS ({len(problems)})")
    for p in problems:
        print("  X", p)
else:
    print("\nPROBLEMS  none -- every seed statement resolves against the schema")
for n in notes:
    print("  -", n)
sys.exit(1 if problems else 0)
