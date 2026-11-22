#!/usr/bin/env python3
"""
FCMS cross-layer sweep.

Checks the seams between C# and SQL that no compiler sees:

  * every C# enum member is a real label of the Postgres enum it maps to,
    and vice versa - a missing label fails at runtime on first use
  * every ::cast in a query names a real type
  * every fn_ called from C# exists in the schema
  * every @parameter in a query has a matching property on the object passed
    with it, and vice versa

Written after five ValueTuple queries were found that Dapper cannot
deserialise at all - the kind of thing that compiles perfectly and throws on
the first request.
"""
import re, pathlib
ROOT = pathlib.Path(__file__).parent.parent
API = ROOT / 'api'; DB = ROOT / 'db'
found = []
cs = {f: f.read_text(encoding="utf-8") for f in API.rglob('*.cs')}
allcs = "\n".join(cs.values())
allsql = "\n".join(re.sub(r"--[^\n]*","",p.read_text(encoding="utf-8")) for p in (DB/'migrations').glob('*.sql'))

BASE = {"uuid","text","int","integer","jsonb","json","date","inet","numeric","timestamptz",
        "timestamp","boolean","bool","bigint","time","interval","char","varchar","bytea",
        "real","float","smallint","money","uuid[]","text[]"}

# --- enums: allow ANY whitespace in the declaration -------------------------
enums = {}
for m in re.finditer(r"CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\((.*?)\)\s*;", allsql, re.S|re.I):
    enums[m.group(1).lower()] = set(re.findall(r"'([A-Za-z_]+)'", m.group(2)))

# Labels added later. An enum grows by ALTER TYPE ... ADD VALUE, and reading
# only CREATE TYPE reports a perfectly good C# member as unknown.
for m in re.finditer(r"ALTER\s+TYPE\s+(\w+)\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'([A-Za-z_]+)'",
                     allsql, re.I):
    enums.setdefault(m.group(1).lower(), set()).add(m.group(2))

for f, src in cs.items():
    for m in re.finditer(r"public enum (\w+)\s*\{([^}]*)\}", src):
        # Strip comments before splitting. An enum body is allowed to explain
        # itself, and reading "// Runs a company" as a label reported three
        # faults in a correct file -- which is how a person learns to stop
        # commenting their enums, the opposite of what anyone wants.
        body = re.sub(r"//[^\n]*", "", m.group(2))
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        members = {x.strip() for x in body.split(",") if x.strip()}
        pg = re.search(rf'MapEnum<{m.group(1)}>\("(\w+)"', allcs)
        if not pg: continue
        labels = enums.get(pg.group(1).lower(), set())
        if not labels:
            found.append(f"MapEnum<{m.group(1)}>(\"{pg.group(1)}\") - no such enum in the schema")
            continue
        for extra in sorted(members - labels):
            found.append(f"C# enum {m.group(1)}.{extra} is not a label of {pg.group(1)}")
        for missing in sorted(labels - members):
            found.append(f"{pg.group(1)} label '{missing}' is missing from C# enum {m.group(1)}")

# --- casts ------------------------------------------------------------------
for f, src in cs.items():
    # `::` in a C# string is not always a Postgres cast: "[::1]" is the IPv6
    # loopback address, and reading it as a cast to a type named "1" reported a
    # fault in correct code -- the sort of false positive that teaches a person
    # to stop reading this output.
    cast_src = re.sub(r"\[?::1\]?", "", src)

    for m in re.finditer(r"::(\w+)\b", cast_src):
        t = m.group(1).lower()
        if t in enums or t in BASE: continue
        found.append(f"{f.name}: cast ::{t} is neither a schema enum nor a base type")

# --- fn_ calls --------------------------------------------------------------
sqlfns = set(x.lower() for x in re.findall(r"CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(fn_\w+)", allsql, re.I))
for f, src in cs.items():
    for m in re.finditer(r"\b(fn_\w+)\s*\(", src):
        if m.group(1).lower() not in sqlfns:
            found.append(f"{f.name}: calls {m.group(1)}() which the schema does not define")

# --- Dapper parameters: brace-match the object that follows the SQL ---------
def match_braces(s, i):
    depth = 0
    for j in range(i, len(s)):
        if s[j] == '{': depth += 1
        elif s[j] == '}':
            depth -= 1
            if depth == 0: return j
    return -1

for f, src in cs.items():
    for m in re.finditer(r'new CommandDefinition\(', src):
        seg = src[m.start(): m.start() + 9000]
        sqlm = re.search(r'"""(.*?)"""', seg, re.S) or re.search(r'"((?:[^"\\]|\\.)*)"', seg)
        if not sqlm: continue
        sql = sqlm.group(1)
        after = seg[sqlm.end():]
        nm = re.search(r'\bnew\s*\{', after)

        if not nm:
            # Dapper will also bind a RECORD passed directly. This check only
            # understands `new { ... }`, so such a call is skipped rather than
            # reported -- I tried to teach it the record's properties and got it
            # half working, which is worse than a known gap.
            #
            # The convention in this codebase is an explicit parameter object
            # at every call site, which keeps the SQL-to-parameter mapping
            # visible and keeps this check meaningful.
            continue
        # the parameter object must come before the next ")," closing the call
        close = match_braces(after, after.index('{', nm.start()))
        if close < 0: continue
        obj = after[after.index('{', nm.start()) + 1: close]
        # Strip // comments. A comment line inside an anonymous object makes the
        # following property look like part of the comment, and the parameter
        # reads as missing when it is right there.
        obj = re.sub(r"//[^\n]*", "", obj)
        # top-level property names only
        depth, cur, props = 0, "", []
        for ch in obj:
            if ch in '{([': depth += 1
            elif ch in '})]': depth -= 1
            if ch == ',' and depth == 0:
                props.append(cur); cur = ""
            else: cur += ch
        props.append(cur)
        names = set()
        for p in props:
            p = p.strip()
            if not p: continue
            eq = re.match(r"@?(\w+)\s*=", p)
            names.add((eq.group(1) if eq else p.split('.')[-1]).lower())
        used = {x.lower() for x in re.findall(r"@(\w+)", sql)}
        for u in sorted(used - names):
            found.append(f"{f.name}: SQL uses @{u} but the parameter object has no '{u}'")

# --- Dapper materialisation targets --------------------------------------
#
# Two rules, both learned from a live failure:
#
#   1. No DateTimeOffset. Npgsql hands back DateTime (Kind=Utc) for
#      timestamptz, so a DateTimeOffset property means Dapper cannot match.
#   2. Targets are classes with settable properties, not positional records.
#      A record forces Dapper to match an entire CONSTRUCTOR signature, so one
#      column of the wrong type fails the whole materialisation with an error
#      naming a signature nobody wrote.
targets = set()
for f, src in cs.items():
    for m in re.finditer(r"Query(?:Single|SingleOrDefault|First|FirstOrDefault)?Async<(\w+)>", src):
        targets.add(m.group(1))
for f, src in cs.items():
    for t in sorted(targets):
        if re.search(rf"record\s+{t}\s*\(", src):
            found.append(f"{f.name}: {t} is a positional record but Dapper materialises it - "
                         f"use a class with settable properties")
    # Strip comments first - the explanation of this very rule contains the
    # word, and a checker that flags its own documentation is noise.
    code = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", src, flags=re.S))
    if "DateTimeOffset" in code:
        found.append(f"{f.name}: uses DateTimeOffset - Npgsql maps timestamptz to DateTime")

# --- a type from another namespace needs a using
#
# This is a compiler's job, and the compiler is not available here. Without it,
# a service that reaches into another feature folder compiles on nobody's
# machine and the failure arrives at deploy time:
#
#   error CS0246: The type or namespace name 'AccountsService' could not be
#   found (are you missing a using directive?)
#
# Which is exactly what happened when the directors' page reused the accounts
# statement rather than reimplementing it -- the right design decision, and it
# would not build.
def strip_cs(src: str) -> str:
    """
    Blank comments and strings in one left-to-right pass.

    Sequential regexes do not work here: strip comments first and a "https://"
    inside a string eats the line; strip strings first and an apostrophe in
    prose runs to the next quote. And scanning declarations WITHOUT stripping
    reads "a record would drift" as a type named `would`, which is what the
    first version of the check below reported five times.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        ch = src[i]
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            end = src.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if ch == '"':
            if src[i:i + 3] == '"""':
                end = src.find('"""', i + 3)
                i = n if end < 0 else end + 3
                out.append('""')
                continue
            i += 1
            while i < n and src[i] != '"':
                i += 2 if src[i] == "\\" else 1
            i += 1
            out.append('""')
            continue

        # Char literals. Trim('"', '\'') contains a double quote INSIDE a char
        # literal -- without this the quote opens a phantom string that
        # swallows the rest of the file, and Program.cs reported unbalanced
        # braces when it was perfectly correct.
        if ch == "'":
            i += 1
            while i < n and src[i] != "'":
                i += 2 if src[i] == "\\" else 1
            i += 1
            out.append("''")
            continue

        # Verbatim strings, where a backslash is not an escape.
        if ch == "@" and i + 1 < n and src[i + 1] == '"':
            i += 2
            while i < n:
                if src[i] == '"' and src[i:i + 2] != '""':
                    break
                i += 2 if src[i:i + 2] == '""' else 1
            i += 1
            out.append('""')
            continue

        out.append(ch)
        i += 1
    return "".join(out)


declared_in = {}
file_ns = {}
for f, src in cs.items():
    m = re.search(r"^namespace\s+([\w.]+)\s*;", src, re.M)
    ns = m.group(1) if m else None
    file_ns[f] = ns
    if not ns:
        continue
    for t in re.findall(r"\b(?:sealed\s+)?(?:class|record|interface|enum)\s+(\w+)", strip_cs(src)):
        declared_in.setdefault(t, set()).add(ns)

for f, src in cs.items():
    ns = file_ns.get(f)
    if not ns:
        continue
    usings = set(re.findall(r"^using\s+([\w.]+)\s*;", src, re.M))
    body = re.sub(r"^using[^\n]*\n", "", strip_cs(src), flags=re.M)

    for t, homes in declared_in.items():
        if ns in homes:
            continue                       # same namespace, nothing needed
        if not re.search(rf"\b{re.escape(t)}\b", body):
            continue                       # not referenced here
        if homes & usings:
            continue                       # a using covers it
        found.append(
            f"{f.name}: uses {t}, which lives in {sorted(homes)[0]} -- "
            f"missing a using directive")



# --- a raw string joined with +
#
# A scripted edit once pasted its OWN join syntax into a C# SQL string:
#     ... JOIN staff op ON op.id = s.opened_by
#     """ + LATERAL + """
#     LEFT JOIN LATERAL ...
# The first """ closed the SQL, `+ LATERAL +` became code naming nothing, the
# next """ opened a new string. It LEXES perfectly -- brackets balance, every
# string terminates -- so a structural check passes it; only name resolution
# fails, and there is no compiler here. This codebase never joins raw strings
# with +, so any """ beside a + is that accident.
for f, src in cs.items():
    for m in re.finditer(r'"""\s*\+|\+\s*\$?"""', src):
        found.append(f"{f.name}:{src[:m.start()].count(chr(10)) + 1}: a raw string joined with + -- "
                     f"almost certainly text pasted into the middle of a SQL string")

# --- an anonymous object with the same key twice
#
#   error CS0833: An anonymous type cannot have multiple properties with the
#   same name
#
# A scripted edit that inserts a property can easily match a block it has
# already changed. Mine did, in DepotService, and the duplicate compiled
# nowhere but looked plausible in a diff.
for f, src in cs.items():
    clean = strip_cs(src)
    for m in re.finditer(r"new\s*\{([^{}]*)\}", clean, re.S):
        # `=(?![=>])`, not `=(?!=)`: a lambda's `p => p.DipMm` is not a key.
        # Two lambdas over `p` in one object read as `p` twice -- a CS0833
        # that would not have happened.
        keys = re.findall(r"(\w+)\s*=(?![=>])", m.group(1))
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            line = clean[: m.start()].count("\n") + 1
            found.append(
                f"{f.name}:{line}: anonymous object repeats {', '.join(dupes)} - "
                f"CS0833, this will not compile")

# --- a record property read in a serialisation block that the record lacks
#
# There is no C# compiler here, so a record renamed in one place and read in
# another reaches the user's build instead of mine. OpeningDip, DepotDip and
# RecordDip all shipped that way: the serialisation was converted to litres and
# the record definitions were not.
#
# Scoped deliberately to `.Select(x => new { ... x.Prop ... })` blocks, where
# the element type is knowable from the request record. A general version needs
# real type inference -- my first attempt bound identifiers to the wrong types
# and reported JsonElement.GetProperty and List.Count as missing properties,
# which is the kind of noise that gets a checker ignored.
for f, src in cs.items():
    clean = strip_cs(src)

    records = {}
    for m in re.finditer(r"public record (\w+)\(([^;]*?)\)\s*;", clean, re.S):
        props = set()
        for part in re.split(r",(?![^<>()]*[>)])", m.group(2)):
            # A parameter may carry a default (string? Reason = null).
            pm = re.match(r"\s*[\w<>\[\],\s?]+?\s+(\w+)\s*(?:=[^,]*)?$", part.strip())
            if pm:
                props.add(pm.group(1))
        if props:
            records[m.group(1)] = props

    # request records naming a list of another record: List<OpeningDip> Dips
    element_of = {}
    for m in re.finditer(r"List<(\w+)>\s+(\w+)", clean):
        if m.group(1) in records:
            element_of[m.group(2)] = m.group(1)

    for m in re.finditer(r"\.(\w+)\.Select\((\w+)\s*=>\s*new\s*\{(.*?)\}\)", clean, re.S):
        listname, var, body = m.group(1), m.group(2), m.group(3)
        rec = element_of.get(listname)
        if not rec:
            continue
        for pm in re.finditer(rf"\b{re.escape(var)}\.([A-Z]\w+)\b", body):
            if pm.group(1) not in records[rec]:
                line = clean[: m.start() + pm.start()].count("\n") + 1
                found.append(
                    f"{f.name}:{line}: serialises {var}.{pm.group(1)}, but {rec} "
                    f"has no such property - this will not compile")

# --- every Dapper target type must actually exist
#
# QuerySingleAsync<DaySpend> compiles only if DaySpend is declared, so this is
# strictly a compiler's job -- but the compiler is not available here, and a
# type that is used and never declared is exactly what a bulk refactor leaves
# behind when an anchor stops matching. Cheap to check, and it caught one.
declared_types = set()
for f, src in cs.items():
    for m in re.finditer(r"\b(?:class|record|interface|enum|struct)\s+(\w+)", strip_cs(src)):
        declared_types.add(m.group(1))

for f, src in cs.items():
    for m in re.finditer(
            r"Query(?:Single|SingleOrDefault|First|FirstOrDefault)?Async<(\w+)>", src):
        t = m.group(1)
        if t in ("Guid", "String", "string", "int", "decimal", "bool", "long",
                 "DateTime", "DateOnly", "Int32", "Decimal"):
            continue
        if t not in declared_types:
            found.append(f"{f.name}: Dapper materialises {t}, which is never declared")

# --- every UI permission gate must be a permission the API issues
#
# A nav item or page guard keyed on a permission no role holds is invisible to
# everyone -- which does not look like a bug, it looks like a missing feature.
# Stock was gated on "dry_stock.receive" when the permission is
# "dry_stock.manage", so the screen existed and nobody could reach it.
access_file = ROOT / "web" / "lib" / "access.ts"
if access_file.exists():
    gates = set(re.findall(r'need: "([^"]+)"', access_file.read_text(encoding="utf-8")))
    for page in (ROOT / "web" / "app").rglob("page.tsx"):
        gates |= set(re.findall(r'need="([^"]+)"', page.read_text(encoding="utf-8")))

    issued = set(re.findall(r'"([a-z_]+\.[a-z_]+)"', allcs))
    for g in sorted(gates - issued):
        found.append(
            f"lib/access.ts: gates on '{g}', which no role is granted - that "
            f"screen is invisible to everyone")

# --- middleware order
#
# Invisible to every other check here, and it broke the shift close. Anything
# that writes to a tenant-scoped table must run INSIDE the transaction, because
# set_config('app.tenant_id', ..., true) is transaction-local: after the commit
# it is gone, app_tenant() returns NULL, and RLS refuses the row with
# "new row violates row-level security policy".
#
# ASP.NET middleware wraps in registration order, so a middleware registered
# AFTER TransactionMiddleware runs inside it. Anything registered before it
# runs outside, and its post-next() work happens after the commit.
prog = (ROOT / "api" / "Program.cs").read_text(encoding="utf-8")
order = re.findall(r"app\.UseMiddleware<(\w+)>\(\)", prog)
if "TransactionMiddleware" in order:
    tx = order.index("TransactionMiddleware")
    for name in order[:tx]:
        # Find the class in ITS OWN file and bound it by brace depth. Searching
        # a concatenation of every .cs file let one class body run into the
        # next, which reported a middleware that writes BEFORE next() as
        # writing after it.
        block = None
        for cs_file in (ROOT / "api").rglob("*.cs"):
            text = cs_file.read_text(encoding="utf-8")
            m = re.search(rf"class {name}\b", text)
            if not m:
                continue
            i = text.find("{", m.end())
            depth, j = 0, i
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            block = text[i:j]
            break
        if not block:
            continue
        after_next = block.split("await _next(ctx)")
        if len(after_next) > 1 and re.search(r"INSERT INTO|UPDATE ", after_next[-1], re.I):
            found.append(
                f"Program.cs: {name} is registered OUTSIDE TransactionMiddleware but "
                f"writes after next() -- that write lands after the commit, when "
                f"app.tenant_id is gone and RLS will refuse it")

# --- RLS: every insert into a tenant-scoped table must supply tenant_id
#
# The policy is WITH CHECK (tenant_id = app_tenant()), so an insert that omits
# the column is refused with "new row violates row-level security policy" --
# which reads like a permissions bug rather than a missing column.
tenant_tables = set()
for m in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)\s*;",
                     allsql, re.S | re.I):
    if re.search(r"^\s*tenant_id\s", m.group(2), re.M):
        tenant_tables.add(m.group(1).lower())

for f, src in cs.items():
    for m in re.finditer(r"INSERT INTO (\w+)\s*\(([^)]*)\)", src, re.S):
        t = m.group(1).lower()
        if t not in tenant_tables:
            continue
        cols = {c.strip().lower() for c in m.group(2).split(",")}
        if "tenant_id" not in cols:
            found.append(f"{f.name}: INSERT INTO {t} omits tenant_id - "
                         f"the RLS policy will refuse it")

# --- a column's SQL type against the C# property it is read into
#
# check_types compares C# to TypeScript and maps Guid -> string, so a Guid
# property matching a TS string looked correct. Nothing compared C# to the
# DATABASE. exception_flag.id is a bigint, it was read into a Guid, and every
# dashboard alert died with "Invalid cast from Int64 to Guid" -- at runtime,
# on the screen the user opens first.
#
# Only plain `alias.column AS Property` is judged. An expression or an explicit
# ::cast is the author saying what they mean, and is left alone.
_COLTYPE: dict[str, dict[str, str]] = {}
for _m in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\)", allsql, re.S | re.I):
    _cols = {}
    for _line in _m.group(2).split("\n"):
        _cm = re.match(r"\s*(\w+)\s+(\w+)", _line)
        if _cm and _cm.group(1).upper() not in ("CONSTRAINT", "PRIMARY", "UNIQUE",
                                                "CHECK", "FOREIGN", "EXCLUDE", "LIKE"):
            _cols[_cm.group(1).lower()] = _cm.group(2).lower()
    _COLTYPE[_m.group(1).lower()] = _cols

# What a column type may NOT be read into.
_FORBIDDEN = {
    "uuid":        {"long", "int", "decimal", "bool", "DateTime", "DateOnly"},
    "bigint":      {"Guid", "bool", "DateTime", "DateOnly"},
    "bigserial":   {"Guid", "bool", "DateTime", "DateOnly"},
    "integer":     {"Guid", "bool", "DateTime", "DateOnly"},
    "int":         {"Guid", "bool", "DateTime", "DateOnly"},
    "numeric":     {"Guid", "bool", "DateTime", "DateOnly"},
    "boolean":     {"Guid", "decimal", "long", "int", "DateTime", "DateOnly"},
    "timestamptz": {"Guid", "bool", "decimal", "long", "int"},
    "date":        {"Guid", "bool", "decimal", "long", "int"},
    "text":        {"Guid", "bool", "decimal", "long", "int", "DateTime", "DateOnly"},
}
TQ = chr(34) * 3   # the SQL delimiter, built rather than typed:
                   # writing it literally closes the string it sits in
# Properties per CLASS, not per file. A first version built one map per file
# and reported three phantom mismatches in AdminService, where `Id` is a long
# on the audit row and a Guid on several others -- the later class silently
# overwrote the earlier. Each query is tied to the type Dapper is told to fill.
_CLASS_PROPS: dict[str, dict[str, str]] = {}
for f, src in cs.items():
    # COMMENTS STRIPPED FIRST, and the declaration anchored to a line.
    # Without that, `class\s+(\w+)` matched the words "class with settable
    # properties" in a Dapper doc comment, and `[^{]*` then ran forward to the
    # next brace -- swallowing every real class declaration in between. The
    # rule registered a class called "with" and missed AlertRow entirely, so
    # the bug it was written for stayed invisible. Same lesson as `--` inside a
    # string and a comment that mentions a variable: a comment is not code.
    # The brace also sits on the NEXT line here, so it must not be required on
    # the same one -- with comments gone, [^{]* is safe again.
    code_only = strip_cs(src)
    for cm in re.finditer(
            r"^[ \t]*(?:public|internal|private|protected)?\s*(?:sealed\s+|static\s+|abstract\s+)*"
            r"class\s+(\w+)[^{]*\{", code_only, re.M):
        src_for_body = code_only
        body_start = cm.end() - 1
        depth, i = 0, body_start
        while i < len(src_for_body):
            if src_for_body[i] == "{":
                depth += 1
            elif src_for_body[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        _CLASS_PROPS[cm.group(1)] = {
            m.group(2): m.group(1).rstrip("?")
            for m in re.finditer(r"public\s+([\w<>?]+)\s+(\w+)\s*\{\s*get;\s*set;",
                                 src_for_body[body_start:i])}

for f, src in cs.items():
    for q in re.finditer(
            r"Query\w*Async<(\w+)>\s*\(\s*new CommandDefinition\(\s*\n?\s*" + TQ + r"(.*?)" + TQ,
            src, re.S):
        target, body = q.group(1), q.group(2)
        props = _CLASS_PROPS.get(target)
        if not props:
            continue
        aliases = {}
        for a in re.finditer(r"\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?", body, re.I):
            tbl, al = a.group(1).lower(), (a.group(2) or a.group(1)).lower()
            if al in ("on", "where", "set", "as", "left", "inner", "join", "group", "order"):
                al = tbl
            aliases[al] = tbl
        for sel in re.finditer(r"(?<![:\w])\b(\w+)\.(\w+)\s+AS\s+(\w+)", body, re.I):
            tbl = aliases.get(sel.group(1).lower())
            col = _COLTYPE.get(tbl or "", {}).get(sel.group(2).lower())
            prop = props.get(sel.group(3))
            if col and prop and prop in _FORBIDDEN.get(col, set()):
                found.append(
                    f"{f.name}: {target}.{sel.group(3)} is {prop} but "
                    f"{tbl}.{sel.group(2)} is {col} - this throws at runtime, not at build")

# --- one <summary> per doc comment, and XML that parses
#
# Two <summary> blocks on one member is not a build error, so it sat in six
# files unnoticed -- but Swagger reads these comments, and it shows whichever
# one it likes. A bare `<` or a loose `&` in the prose IS an error (CS1570).
for f, src in cs.items():
    for m in re.finditer(r"(?:^[ \t]*///[^\n]*\n)+", src, re.M):
        block = m.group(0)
        line = src[:m.start()].count("\n") + 1
        if len(re.findall(r"<summary>", block)) > 1:
            found.append(
                f"{f.name}:{line} has two <summary> blocks on one member "
                f"- Swagger shows whichever it likes")
        text = re.sub(r"</?\w+[^>]*>", "", re.sub(r"^\s*///", "", block, flags=re.M))
        if re.search(r"<(?![a-zA-Z/!])", text) or re.search(r"&(?!amp;|lt;|gt;|quot;|apos;|#)", text):
            found.append(
                f"{f.name}:{line} has a bare < or & in a doc comment "
                f"- CS1570, the build fails")

# --- async with nothing awaited (CS1998, an error here)
#
# The body is whatever follows the signature up to the next member, which
# covers BOTH styles. A first attempt looked for the next `{` and flagged an
# expression-bodied method that awaited perfectly well -- the brace it found
# belonged to the method after it.
for f, src in cs.items():
    for m in re.finditer(r"\basync\s+Task[^\(\n]*\s(\w+)\s*\(", src):
        rest = src[m.end():]
        nxt = re.search(r"\n    (?:public|private|internal|protected|\})", rest)
        body = rest[:nxt.start()] if nxt else rest
        if "await" not in body:
            found.append(
                f"{f.name}: {m.group(1)}() is async and awaits nothing "
                f"- CS1998, and warnings are errors here")

# --- XML docs: document every parameter, or none (CS1573)
#
# C# accepts no <param> tags at all, or one for every parameter. Document two
# of six and the build FAILS -- this project turns that warning into an error.
# Half-documenting a record while explaining the interesting fields is the
# natural thing to do, and it broke the build twice.
for f, src in cs.items():
    # Positional records: the doc comment block immediately above them.
    for m in re.finditer(
            r"((?:^[ \t]*///[^\n]*\n)+)[ \t]*public\s+(?:sealed\s+)?record\s+(\w+)\s*\(([^)]*)\)",
            src, re.M | re.S):
        doc, name, params = m.group(1), m.group(2), m.group(3)
        tags = re.findall(r'<param\s+name="(\w+)"', doc)
        documented = set(tags)
        # COUNTED, not collapsed into a set. A set hides the duplicate that
        # CS1571 is about -- which is how a second documentation block, added
        # above one that already existed, passed this check and failed the
        # build on nine parameters at once.
        dupes = sorted({t for t in tags if tags.count(t) > 1})
        if dupes:
            found.append(
                f"{f.name}: record {name} documents {', '.join(dupes)} twice "
                f"- CS1571, the build fails")
        if len(re.findall(r"<summary>", doc)) > 1:
            found.append(
                f"{f.name}: record {name} has two <summary> blocks - a second "
                f"doc comment was added above one that was already there")
        if not documented:
            continue                      # none is fine; some is not
        declared = []
        for part in re.split(r",(?![^<>]*>)", params):
            part = part.strip()
            if not part:
                continue
            bare = re.sub(r"=.*$", "", part).strip()
            pm = re.search(r"(\w+)$", bare)
            if pm:
                declared.append(pm.group(1))
        missing = [d for d in declared if d not in documented]
        if missing:
            found.append(
                f"{f.name}: record {name} documents some parameters but not "
                f"{', '.join(missing)} - CS1573, the build fails")
        stray = [d for d in documented if d not in declared]
        if stray:
            found.append(
                f"{f.name}: record {name} documents {', '.join(stray)}, which is "
                f"not a parameter - CS1572, the build fails")

    # Methods carry the same rule, and `ct` is NOT excluded. An earlier
    # version skipped CancellationToken as mere plumbing -- but the compiler
    # counts it, so a documented method with an undocumented ct fails the
    # build while this check stays quiet. Match the compiler, not taste.
    for m in re.finditer(
            r"((?:^[ \t]*///[^\n]*\n)+)[ \t]*(?:public|private|internal|protected)\s+"
            r"(?!record\s)(?:static\s+|async\s+|virtual\s+|override\s+)*"
            r"[\w<>,\[\]\?\. ]+?\s+(\w+)\s*\(([^)]*)\)", src, re.M | re.S):
        doc, name, params = m.group(1), m.group(2), m.group(3)
        tags = re.findall(r'<param\s+name="(\w+)"', doc)
        documented = set(tags)
        dupes = sorted({t for t in tags if tags.count(t) > 1})
        if dupes:
            found.append(
                f"{f.name}: {name}() documents {', '.join(dupes)} twice "
                f"- CS1571, the build fails")
        if not documented:
            continue
        declared = []
        for part in re.split(r",(?![^<>]*>)", params):
            part = part.strip()
            if not part:
                continue
            pm = re.search(r"(\w+)$", re.sub(r"=.*$", "", part).strip())
            if pm:
                declared.append(pm.group(1))
        missing = [d for d in declared if d not in documented]
        if missing:
            found.append(
                f"{f.name}: {name}() documents some parameters but not "
                f"{', '.join(missing)} - CS1573, the build fails")

# --- every file must import the namespaces of the infrastructure it uses
#
# The same blind spot as the Program.cs rule below, one level down: a service
# that throws DomainException without `using Fcms.Api.Common;` compiles
# nowhere and is invisible to every check here.
_NEEDS = {
    "Npgsql": ("PostgresException", "NpgsqlConnection"),
    "Dapper": ("CommandDefinition",),
    "Fcms.Api.Common": ("PostgresErrors", "DomainException"),
}
for f, src in cs.items():
    body = strip_cs(src)
    own = re.search(r"^namespace\s+([A-Za-z0-9_.]+)", src, re.M)
    own_ns = own.group(1) if own else ""
    for ns, symbols in _NEEDS.items():
        if ns == own_ns:
            continue          # the file that defines them needs no import
        used = [sym for sym in symbols if re.search(rf"\b{sym}\b", body)]
        if used and not re.search(rf"^using\s+{re.escape(ns)};", src, re.M):
            found.append(
                f"{f.name} uses {', '.join(used)} but does not import {ns}")

# --- Program.cs must import the namespaces of what it wires up
#
# A service registered with AddScoped<X>() and a route group added with
# app.MapY() both live in a feature namespace. Add the service and forget the
# `using`, and the build fails with CS0246 / CS1061 -- which is a real failure
# nobody here can see, because dotnet does not run in the environment these
# checks were written in. It shipped exactly that way once.
_prog = next((v for k, v in cs.items() if k.name == "Program.cs"), None)
if _prog:
    _usings = set(re.findall(r"^using\s+([A-Za-z0-9_.]+);", _prog, re.M))
    _own = re.search(r"^namespace\s+([A-Za-z0-9_.]+)", _prog, re.M)
    if _own:
        _usings.add(_own.group(1))

    # where each class and each route-extension method is defined
    _ns_of = {}
    for f, src in cs.items():
        if f.name == "Program.cs":
            continue
        m = re.search(r"^namespace\s+([A-Za-z0-9_.]+)", src, re.M)
        if not m:
            continue
        ns = m.group(1)
        for name in re.findall(r"\b(?:sealed\s+|static\s+|abstract\s+)*class\s+(\w+)", src):
            _ns_of.setdefault(name, ns)
        for name in re.findall(r"\bstatic\s+void\s+(Map\w+)\s*\(\s*this\s+IEndpointRouteBuilder", src):
            _ns_of.setdefault(name, ns)

    _used = set(re.findall(r"AddScoped<(\w+)>", _prog))
    _used |= set(re.findall(r"\bapp\.(Map\w+)\s*\(", _prog))
    for name in sorted(_used):
        ns = _ns_of.get(name)
        if ns and ns not in _usings:
            found.append(
                f"Program.cs uses {name} but does not import {ns} "
                f"- the build fails with CS0246/CS1061")

print("="*70); print("CROSS-LAYER SWEEP")
print("  enums, casts, function calls, Dapper parameters")
print("="*70)
seen=set(); out=[x for x in found if not (x in seen or seen.add(x))]
if out:
    print(f"FINDINGS ({len(out)})")
    for x in out: print("  X", x)
else:
    print("Nothing found.")
import sys; sys.exit(1 if out else 0)
