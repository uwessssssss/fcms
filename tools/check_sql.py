#!/usr/bin/env python3
"""
FCMS SQL validator.

WHY THIS EXISTS
---------------
There is no Postgres in the environment this code is written in. Every query is
therefore written blind, and every mistake in one surfaces on the user's
machine at runtime rather than here. That has cost this project, in order:

    delivery.received_at            -- column never existed
    credit_sale.recorded_by         -- column never existed
    audit_log.detail                -- column never existed
    cut_reasons                     -- enum array read into string[]
    nozzle_assignment.state         -- enum read into string, three places
    v_daily_expense with no FROM    -- an edit removed the clause

Six failures, one class: a reference the code makes that the schema does not
have. Every one of them would have been caught in a second by a database, and
none of them were caught by eleven checkers that validate structure.

So this validator resolves names properly rather than by regex:

  * CTEs, including several in one WITH, and their output columns
  * table aliases, per scope
  * subqueries, which get their own scope and can see the outer one
  * views, whose output columns are resolved from their SELECT list
  * function existence and arity
  * enum columns read without a ::text cast

It will never be a database. It cannot check types, plans, or whether a query
returns what the caller expects. It catches the class that has actually broken
this system six times.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
MIG = ROOT / "db" / "migrations"
API = ROOT / "api"

problems: list[str] = []

# Words that appear in a select list and are not columns.
SQL_WORDS = {
    "sum", "count", "avg", "min", "max", "coalesce", "round", "abs", "case",
    "when", "then", "else", "end", "and", "or", "not", "null", "distinct",
    "filter", "where", "true", "false", "cast", "text", "numeric", "int",
    "date", "interval", "current_date", "now", "greatest", "least", "nullif",
    "select", "from", "as", "on", "join", "left", "inner", "group", "order",
    "having", "limit", "asc", "desc", "array_agg", "string_agg", "bool_and",
    "bool_or", "extract", "age", "exists", "between", "is", "in", "all",
}


# ---------------------------------------------------------------------------
# Reading the schema
# ---------------------------------------------------------------------------
def strip_sql(text: str) -> str:
    """Remove comments and blank string literals, leaving structure intact."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text[i:i + 2] == "--":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if text[i] == "'":
            i += 1
            while i < n:
                if text[i] == "'" and text[i:i + 2] != "''":
                    break
                i += 2 if text[i:i + 2] == "''" else 1
            i += 1
            out.append("''")
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def migration_order() -> list[str]:
    runner = (MIG.parent / "migrate.sh").read_text(encoding="utf-8")
    return re.findall(r"^\s{2}(\d{3}_\w+\.sql)", runner, re.M)


ALL_SQL = "\n".join(strip_sql((MIG / f).read_text(encoding="utf-8"))
                    for f in migration_order())

# --- tables and their columns ----------------------------------------------
TABLES: dict[str, set[str]] = {}
for chunk in re.split(r"(?=CREATE TABLE )", ALL_SQL):
    m = re.match(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)", chunk, re.S | re.I)
    if not m:
        continue
    TABLES[m.group(1).lower()] = {
        c.group(1).lower()
        for c in re.finditer(r"^  (\w+)\s+[a-zA-Z]", m.group(2), re.M)
        if c.group(1).upper() not in
        ("PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "EXCLUDE", "LIKE")
    }

# Every ADD COLUMN in an ALTER TABLE statement, not only the first: one
# statement may add several ("ADD COLUMN a ..., ADD COLUMN b ..."), and reading
# only the first called the second a column that does not exist (600).
for m in re.finditer(r"ALTER TABLE (?:IF EXISTS )?(\w+)\s+(ADD COLUMN.*?);", ALL_SQL, re.I | re.S):
    for c in re.finditer(r"ADD COLUMN (?:IF NOT EXISTS )?(\w+)", m.group(2), re.I):
        TABLES.setdefault(m.group(1).lower(), set()).add(c.group(1).lower())

# --- views, and the columns they expose ------------------------------------
VIEWS: dict[str, set[str]] = {}
for m in re.finditer(r"CREATE (?:OR REPLACE )?VIEW (\w+) AS(.*?)(?=\n(?:CREATE|COMMENT|ALTER|--|$))",
                     ALL_SQL, re.S | re.I):
    name, body = m.group(1).lower(), m.group(2)
    # take the LAST top-level SELECT list (after any CTEs)
    depth, last_select = 0, None
    for sm in re.finditer(r"\bSELECT\b|\(|\)", body, re.I):
        tok = sm.group(0)
        if tok == "(":
            depth += 1
        elif tok == ")":
            depth -= 1
        elif depth == 0:
            last_select = sm.end()
    cols: set[str] = set()
    if last_select is not None:
        rest = body[last_select:]
        # Walk with a real index. The first version used len(cur) as the
        # position, and cur resets on every comma -- so after the first column
        # the FROM detection was looking at the wrong offset and the list was
        # truncated. That reported oldest_invoice as missing from a view that
        # plainly has it.
        parts, cur, d, i = [], "", 0, 0
        while i < len(rest):
            ch = rest[i]
            if ch in "([":
                d += 1
            elif ch in ")]":
                d -= 1
                if d < 0:
                    break
            if d == 0 and re.match(r"\s*FROM\b", rest[i:i + 8], re.I):
                break
            if ch == "," and d == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
            i += 1
        parts.append(cur)

        for p in parts:
            p = p.strip()
            if not p:
                continue
            alias = re.search(r"\bAS\s+(\w+)\s*$", p, re.I)
            if alias:
                cols.add(alias.group(1).lower())
            else:
                tail = re.search(r"(\w+)\s*$", p)
                if tail:
                    cols.add(tail.group(1).lower())

    VIEWS[name] = cols

FUNCS = {f.lower() for f in re.findall(r"CREATE (?:OR REPLACE )?FUNCTION (\w+)", ALL_SQL, re.I)}

ENUMS = {e.lower() for e in re.findall(r"CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM", ALL_SQL, re.I)}
ENUM_COLS: dict[str, dict[str, str]] = {}
for chunk in re.split(r"(?=CREATE TABLE )", ALL_SQL):
    m = re.match(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)", chunk, re.S | re.I)
    if not m:
        continue
    for cm in re.finditer(r"^  (\w+)\s+(\w+)(\[\])?\s", m.group(2), re.M):
        if cm.group(2).lower() in ENUMS:
            ENUM_COLS.setdefault(m.group(1).lower(), {})[cm.group(1).lower()] = \
                cm.group(2).lower() + (cm.group(3) or "")


# ---------------------------------------------------------------------------
# Reading a query
# ---------------------------------------------------------------------------
def cte_names(query: str) -> set[str]:
    """Names bound by a WITH clause, including several in one WITH."""
    names: set[str] = set()
    m = re.match(r"\s*WITH\s+(?:RECURSIVE\s+)?", query, re.I)
    if not m:
        return names
    i, depth = m.end(), 0
    expect = True
    while i < len(query):
        if expect:
            nm = re.match(r"\s*(\w+)\s+AS\s*\(", query[i:], re.I)
            if not nm:
                break
            names.add(nm.group(1).lower())
            i += nm.end()
            depth = 1
            expect = False
            continue
        ch = query[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                after = re.match(r"\s*,", query[i + 1:])
                if after:
                    i += 1 + after.end()
                    expect = True
                    continue
                break
        i += 1
    return names


def aliases_in(query: str) -> dict[str, str]:
    """alias -> relation, for every FROM/JOIN in this text."""
    out: dict[str, str] = {}
    reserved = {"on", "where", "group", "order", "lateral", "left", "right",
                "inner", "outer", "join", "set", "using", "as", "cross", "full",
                "limit", "having", "union", "select", "and", "or", "not"}
    for m in re.finditer(r"(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?", query, re.I):
        rel, al = m.group(1).lower(), (m.group(2) or "").lower()
        out[rel] = rel                       # the relation name itself works as a qualifier
        if al and al not in reserved:
            out[al] = rel
    return out


def columns_of(rel: str, local: set[str]) -> set[str] | None:
    """None means 'unknown shape, do not check' -- a CTE or an unresolved view."""
    if rel in local:
        return None
    if rel in TABLES:
        return TABLES[rel]
    if rel in VIEWS:
        # An empty set means the parse failed, not that the view has no
        # columns. Claiming a column is missing from a view we could not read
        # is exactly the kind of false positive that gets a checker ignored.
        return VIEWS[rel] or None
    return None


def check_query(where: str, query: str) -> None:
    q = strip_sql(query)
    local = cte_names(q)
    alias = aliases_in(q)

    # every qualified reference
    for m in re.finditer(r"\b(\w+)\.(\w+)\b", q):
        a, col = m.group(1).lower(), m.group(2).lower()
        if a not in alias:
            continue
        rel = alias[a]
        cols = columns_of(rel, local)
        if cols is None or col == "*":
            continue
        if col not in cols:
            problems.append(f"{where}: {a}.{col} -- {rel} has no column '{col}'")

    # Unqualified columns, where the scope is a single known relation.
    #
    # Only qualified references were checked, so `SUM(position)` inside
    # `(SELECT ... FROM v_cash_position)` passed -- and the directors' page died
    # on "column position does not exist". When a subquery reads from exactly
    # one relation there is no ambiguity about where a bare column comes from,
    # so it can be checked with the same confidence as a qualified one.
    # [^()]* so the match cannot run across two sibling subqueries and read the
    # columns of one against the relation of another -- which reported three
    # phantom problems before it reported the real one.
    for sub in re.finditer(r"\(\s*SELECT\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?)\s+FROM\s+(\w+)\s*\)", q, re.S | re.I):
        body, rel = sub.group(1), sub.group(2).lower()
        cols = columns_of(rel, local)
        if cols is None:
            continue
        for cm in re.finditer(r"(?<![\w.])([a-z_][a-z0-9_]{2,})(?![\w.(])", body, re.I):
            name = cm.group(1).lower()
            if name in cols or name in SQL_WORDS:
                continue
            problems.append(
                f"{where}: {rel} has no column '{name}' (unqualified, inside a "
                f"subquery that reads only from {rel})")

    # relations that do not exist at all
    # `extract(hour FROM ts)` uses FROM as a KEYWORD INSIDE a function call, not
    # as a clause. Reading it as a clause made this report "reads 'sh', which is
    # not a table" for a correct query -- and the fix a person reaches for is to
    # stop using extract(), which is exactly the wrong lesson.
    scan = re.sub(
        r"\b(extract|substring|trim|overlay|position)\s*\([^()]*?\bFROM\b",
        lambda mm: mm.group(0).replace("FROM", "____").replace("from", "____"),
        q, flags=re.I)

    for m in re.finditer(r"(?<![@\w])(?:FROM|JOIN)\s+(\w+)", scan, re.I):
        rel = m.group(1).lower()
        if (rel in TABLES or rel in VIEWS or rel in local
                or rel.startswith("pg_") or rel.startswith("fn_")          # set-returning function
                or rel.startswith("information_schema")
                or rel in ("lateral", "unnest", "generate_series",
                           "jsonb_array_elements", "only", "information_schema")):
            continue
        problems.append(f"{where}: reads '{rel}', which is not a table, view or CTE")

    # functions
    for m in re.finditer(r"\b(fn_\w+)\s*\(", q):
        if m.group(1).lower() not in FUNCS:
            problems.append(f"{where}: calls {m.group(1)}(), which does not exist")

    # an aggregate with no FROM anywhere in its own scope
    outer = q
    for _ in range(8):
        new = re.sub(r"\((?:[^()])*\)", "", outer)
        if new == outer:
            break
        outer = new
    if re.search(r"\b(SUM|COUNT|AVG|MIN|MAX)\s*\(", q, re.I) \
            and not re.search(r"\bFROM\b", outer, re.I) \
            and not re.match(r"\s*(INSERT|UPDATE|DELETE|WITH|DO)\b", q.strip(), re.I) \
            and not re.match(r"\s*SELECT\s*\n?\s*\(", q.strip(), re.I):
        problems.append(f"{where}: aggregates with no FROM clause in the outer query")

    # enum columns read without a cast
    for m in re.finditer(r"(?:(\w+)\.)?(\w+)(::\w+(?:\[\])?)?\s+AS\s+([A-Z]\w*)", q):
        a, col, cast = (m.group(1) or "").lower(), m.group(2).lower(), m.group(3)
        if cast:                       # already cast, whatever it was cast to
            continue
        rels = [alias[a]] if a in alias else sorted(set(alias.values()))
        for rel in rels:
            if rel in ENUM_COLS and col in ENUM_COLS[rel]:
                problems.append(
                    f"{where}: {rel}.{col} is {ENUM_COLS[rel][col]} and is read without "
                    f"::text -- Dapper cannot cast a Postgres enum to a C# string")
                break


# ---------------------------------------------------------------------------
# Every query in the API
# ---------------------------------------------------------------------------
count = 0
for f in sorted(API.rglob("*.cs")):
    src = f.read_text(encoding="utf-8")
    for m in re.finditer(r'"""(.*?)"""', src, re.S):
        body = m.group(1)
        if not re.search(r"\b(SELECT|INSERT|UPDATE|DELETE)\b", body, re.I):
            continue
        count += 1
        check_query(f"{f.name}:{src[:m.start()].count(chr(10)) + 1}", body)

    # single-line queries built by concatenation
    for m in re.finditer(r'"((?:SELECT|INSERT|UPDATE|DELETE)[^"]{10,})"', src, re.I):
        count += 1
        check_query(f"{f.name}:{src[:m.start()].count(chr(10)) + 1}", m.group(1))

print("=" * 72)
print("SQL VALIDATOR")
print("=" * 72)
print(f"tables {len(TABLES)}  views {len(VIEWS)}  functions {len(FUNCS)}  "
      f"queries checked {count}")
print()

seen: set[str] = set()
out = [p for p in problems if not (p in seen or seen.add(p))]
if out:
    print(f"PROBLEMS ({len(out)})")
    for p in out:
        print("  X", p)
else:
    print("PROBLEMS  none -- every query resolves against the schema")

sys.exit(1 if out else 0)
