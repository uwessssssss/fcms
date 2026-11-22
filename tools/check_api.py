#!/usr/bin/env python3
"""
FCMS API static check.

No .NET SDK here, so this cannot compile. What it CAN do is catch the errors
that a compiler would catch first and that a careful reader misses:

  * file-scoped namespace mixed with a block namespace (a hard compile error)
  * types used but never declared anywhere in the project
  * services resolved from DI that were never registered
  * middleware referenced in Program.cs but not defined
  * SQL identifiers in Dapper strings that do not exist in the schema
  * unbalanced braces

The last one is the valuable one: a query naming a column that was renamed in
the schema compiles perfectly and fails at 6am on a forecourt.
"""
import re, sys, pathlib
from collections import defaultdict

API = pathlib.Path(__file__).parent.parent / "api"
SCHEMA = pathlib.Path(__file__).parent.parent / "db" / "migrations"
problems, notes = [], []

cs_files = sorted(API.rglob("*.cs"))
if not cs_files:
    print("no C# files found"); sys.exit(1)

sources = {p: p.read_text(encoding="utf-8") for p in cs_files}


def strip_strings_and_comments(s):
    s = re.sub(r'"""(.*?)"""', lambda m: '"' + " " * (len(m.group(1))) + '"', s, flags=re.S)
    s = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', s)
    s = re.sub(r"//[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return s


# ---- 1. namespace form ----
for p, s in sources.items():
    body = strip_strings_and_comments(s)
    file_scoped = re.search(r"^namespace\s+[\w.]+\s*;", body, re.M)
    block = re.search(r"^namespace\s+[\w.]+\s*\{", body, re.M)
    if file_scoped and block:
        problems.append(f"{p.name}: file-scoped namespace mixed with a block namespace "
                        f"(CS8955 -- will not compile)")

# ---- 2. brace balance ----
for p, s in sources.items():
    body = strip_strings_and_comments(s)
    body = re.sub(r"'(?:[^'\\]|\\.)'", "''", body)
    if body.count("{") != body.count("}"):
        problems.append(f"{p.name}: unbalanced braces "
                        f"({body.count('{')} open, {body.count('}')} close)")

# ---- 3. declared types ----
declared = set()
for p, s in sources.items():
    body = strip_strings_and_comments(s)
    for m in re.finditer(r"\b(?:public|internal|private|sealed|abstract|static|partial|\s)*"
                         r"(?:class|record|interface|enum|struct)\s+(\w+)", body):
        declared.add(m.group(1))

EXTERNAL = {
    # BCL / ASP.NET / packages we take as given
    "Guid","String","Task","List","Dictionary","HashSet","DateTimeOffset","DateOnly",
    "TimeSpan","Exception","InvalidOperationException","CancellationToken","Stream",
    "MemoryStream","StreamReader","Convert","Encoding","JsonSerializer","JsonDocument",
    "JsonNamingPolicy","JsonSerializerOptions","Results","HttpContext","HttpMethods",
    "IEndpointRouteBuilder","RequestDelegate","ILogger","IConfiguration","WebApplication",
    "IHttpContextAccessor","ClaimsPrincipal","Claim","NpgsqlConnection","NpgsqlTransaction",
    "NpgsqlDataSource","NpgsqlDataSourceBuilder","NpgsqlCommand","PostgresException",
    "CommandDefinition","IsolationLevel","SigningCredentials","SymmetricSecurityKey",
    "JwtSecurityToken","JwtSecurityTokenHandler","TokenValidationParameters",
    "SecurityAlgorithms","JwtBearerDefaults","BCrypt","RateLimitPartition",
    "FixedWindowRateLimiterOptions","ValueTask","IAsyncDisposable","Regex","RegexOptions",
    "StringComparer","IReadOnlyCollection","IEnumerable","Array","SHA256","ArgumentException",
}

# ---- 4. DI registrations vs constructor dependencies ----
registered = set()
prog = sources.get(API / "Program.cs", "")
for m in re.finditer(r"Add(?:Scoped|Singleton|Transient)<([^>]+)>", prog):
    for t in m.group(1).split(","):
        registered.add(t.strip().split(".")[-1])
for m in re.finditer(r"AddSingleton\((\w+)", prog):
    registered.add(m.group(1))

# framework-provided services never registered by hand
FRAMEWORK = {"IConfiguration","ILogger","HttpContext","CancellationToken",
             "IHttpContextAccessor","NpgsqlDataSource","RequestDelegate"}

for p, s in sources.items():
    body = strip_strings_and_comments(s)
    for m in re.finditer(r"public\s+(\w+)\s*\(([^)]*)\)\s*(?:=>|\{|:)", body):
        cls, params = m.group(1), m.group(2)
        if cls not in declared:
            continue
        for prm in params.split(","):
            prm = prm.strip()
            if not prm:
                continue
            tm = re.match(r"([\w<>\[\]]+)\s+\w+", prm)
            if not tm:
                continue
            t = tm.group(1).split("<")[0]
            if t in FRAMEWORK or t in EXTERNAL or t in registered:
                continue
            if t in declared and t not in registered and t[0] == "I":
                notes.append(f"{p.name}: {cls} depends on {t}, not registered in Program.cs")

# ---- 5. middleware referenced in Program.cs ----
for m in re.finditer(r"UseMiddleware<(\w+)>", prog):
    if m.group(1) not in declared:
        problems.append(f"Program.cs: UseMiddleware<{m.group(1)}> -- type not defined")

# ---- 6. endpoint extension methods ----
extensions = set()
for p, s in sources.items():
    for m in re.finditer(r"public\s+static\s+void\s+(\w+)\s*\(\s*this\s+IEndpointRouteBuilder",
                         strip_strings_and_comments(s)):
        extensions.add(m.group(1))
for m in re.finditer(r"^app\.(Map\w+)\(\)", prog, re.M):
    if m.group(1) not in extensions and m.group(1) not in {"MapHealthChecks"}:
        problems.append(f"Program.cs: app.{m.group(1)}() -- extension method not defined")

# ---- 7. SQL identifiers against the schema ----
schema_sql = "\n".join(p.read_text(encoding="utf-8") for p in SCHEMA.glob("*.sql"))
schema_sql_nc = re.sub(r"--[^\n]*", "", schema_sql)
tables, functions, views, columns = set(), set(), set(), defaultdict(set)

for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\((.*?)\n\)\s*;",
                     schema_sql_nc, re.S | re.I):
    t = m.group(1).lower(); tables.add(t)
    for line in m.group(2).split("\n"):
        cm = re.match(r"\s*(\w+)\s+(uuid|text|int|bigint|boolean|numeric|date|time|"
                      r"timestamptz|char|inet|jsonb|\w+)\b", line)
        if cm and cm.group(1).upper() not in ("PRIMARY","UNIQUE","CHECK","FOREIGN","CONSTRAINT"):
            columns[t].add(cm.group(1).lower())
for m in re.finditer(r"ALTER TABLE (\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)", schema_sql_nc, re.I):
    columns[m.group(1).lower()].add(m.group(2).lower())
for m in re.finditer(r"CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+(\w+)", schema_sql_nc, re.I):
    functions.add(m.group(1).lower())
for m in re.finditer(r"CREATE\s+(?:OR REPLACE\s+)?VIEW\s+(\w+)", schema_sql_nc, re.I):
    views.add(m.group(1).lower())

for p, s in sources.items():
    for lit in re.findall(r'"""(.*?)"""', s, re.S):
        # CTEs and aliases are defined inside the query itself, not the schema.
        # Comments first: one between ", " and a CTE's name hid the name.
        lit = re.sub(r"--[^\n]*", "", lit)
        local = {m.group(1).lower() for m in
                 re.finditer(r"(?:WITH|,)\s+(\w+)\s+AS\s*\(", lit, re.I)}
        local |= {m.group(1).lower() for m in
                  re.finditer(r"\)\s*(\w+)\s*(?:ON|WHERE|GROUP|ORDER|$)", lit, re.I)}
        # SQL comments are prose. "read straight into a C# string" contains INTO
        # followed by a word and reads as a table reference otherwise.
        lit = re.sub(r"--[^\n]*", "", lit)
        # Same blind spot as check_sql.py had: `extract(hour FROM ts)` uses
        # FROM as a keyword inside a function call, and a set-returning
        # function in the FROM clause -- generate_series -- is not a table
        # either. Both are legitimate SQL; neither is a missing relation.
        scan = re.sub(
            r"\b(extract|substring|trim|overlay|position)\s*\([^()]*?\bFROM\b",
            lambda mm: mm.group(0).replace("FROM", "____").replace("from", "____"),
            lit, flags=re.I)

        SET_RETURNING = {"generate_series", "unnest", "jsonb_array_elements",
                         "json_array_elements", "regexp_split_to_table",
                         "jsonb_to_recordset", "json_to_recordset", "lateral"}

        for m in re.finditer(r"(?<![@\w])(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)", scan, re.I):
            if m.group(1).lower() in SET_RETURNING:
                continue
            if m.group(1).lower() in local:
                continue
            t = m.group(1).lower()
            if t in tables or t in views or t in functions:
                continue
            # SQL keywords that can follow FROM/JOIN/INTO/UPDATE and are not
            # table names: "ON CONFLICT ... DO UPDATE SET" is the common one.
            if t in ("set", "lateral", "only", "select", "values"):
                continue
            if t.startswith("fn_"):
                if t.startswith("fn_") and t not in functions:
                    problems.append(f"{p.name}: SQL calls {t}() -- not in the schema")
                continue
            problems.append(f"{p.name}: SQL references '{t}' -- not a table or view in the schema")
        for m in re.finditer(r"\b(fn_\w+)\s*\(", lit):
            if m.group(1).lower() not in functions:
                problems.append(f"{p.name}: SQL calls {m.group(1)}() -- not in the schema")

print("=" * 68)
print("FCMS API STATIC CHECK")
print("=" * 68)
print(f"files {len(cs_files)}   types declared {len(declared)}   "
      f"schema objects {len(tables) + len(views) + len(functions)}")
print()
if problems:
    print(f"PROBLEMS ({len(problems)})")
    for x in sorted(set(problems)):
        print(f"  X {x}")
else:
    print("PROBLEMS  none")
print()
if notes:
    print(f"NOTES ({len(set(notes))})")
    for x in sorted(set(notes)):
        print(f"  * {x}")
sys.exit(1 if problems else 0)
