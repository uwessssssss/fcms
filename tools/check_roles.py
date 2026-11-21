#!/usr/bin/env python3
"""
check_roles.py -- can each role load the screens it works from?

Found by computing it, not by clicking: the supervisors and managers who open
shifts could not load the equipment or staff list to roster from, because
READING was gated by the MANAGE permission. A supervisor's own dashboard
refused them. Head office could not add a pump. Accountants held an approval
permission the approval rule then refused. Every one of those passed every
other check, because each check looked at one layer and none asked "as whom?".

This derives each role's permissions from the migrations -- including the
two inheritance rules: a manager holds everything a supervisor does, and head
office holds everything a manager does -- then resolves every GET a screen
makes to the permission its route demands, and asks whether the role that
works from that screen can load it.

Only READS are judged. A write a role may not make should be refused -- that
is the permission system working, not failing.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent.parent

# The screens each role works from. Extend this when a role gains a job.
WORK = {
    "ACCOUNTANT": ["suppliers", "expenses", "losses", "full-reports", "stock-counts", "management-reports"],
    "SUPERVISOR": ["shift-operations", "shift-closure", "components/DashboardContent.tsx",
                   "site-operations-detail", "inventory/tanks", "pump-attendants", "stock-counts"],
    "MANAGER": ["shift-operations", "shift-closure", "pump-setup", "components/DashboardContent.tsx",
                "expenses", "credit-customers", "losses", "products", "depot", "stock-counts"],
    "HEAD_OFFICE": ["pump-setup", "users", "components/DashboardContent.tsx", "losses",
                    "reports", "full-reports", "depot", "suppliers", "management-reports", "administration"],
}

sql = "\n".join(re.sub(r"--[^\n]*", "", p.read_text(encoding="utf-8"))
                for p in sorted((ROOT / "db" / "migrations").glob("*.sql")))
perms: dict[str, set[str]] = {}
for blk in re.finditer(r"INSERT INTO role_permission\s*\(role,\s*permission\)\s*VALUES(.*?);", sql, re.S):
    for r, p in re.findall(r"\(\s*'([A-Z_]+)'\s*,\s*'([a-z_.]+)'\s*\)", blk.group(1)):
        perms.setdefault(r, set()).add(p)
for m in re.finditer(r"DELETE FROM role_permission\s+WHERE permission = '([a-z_.]+)'\s+AND role IN \(([^)]*)\)", sql):
    for r in re.findall(r"'([A-Z_]+)'", m.group(2)):
        perms.get(r, set()).discard(m.group(1))
perms.setdefault("MANAGER", set()).update(perms.get("SUPERVISOR", set()))       # 200
perms["HEAD_OFFICE"] = set(perms["MANAGER"]) | perms.get("HEAD_OFFICE", set())   # 290
perms["SYSTEM_ADMIN"] = set().union(*perms.values())                             # 160

CS = {f: f.read_text(encoding="utf-8") for f in (ROOT / "api").rglob("*.cs")}
need = {}
for f, src in CS.items():
    code = re.sub(r"//[^\n]*", "", src)
    cls = None
    for m in re.finditer(r"\bclass\s+(\w+)|public async Task(?:<[^>]*(?:<[^>]*>)?[^>]*>)?\s+(\w+)\s*\(", code):
        if m.group(1):
            cls = m.group(1)
            continue
        st = code.index("{", m.end())
        d, i = 0, st
        while i < len(code):
            if code[i] == "{":
                d += 1
            elif code[i] == "}":
                d -= 1
                if d == 0:
                    break
            i += 1
        b = code[st:i]
        need[(cls, m.group(2))] = (
            re.findall(r'(?<!Any)Require\("([a-z_.]+)"\)', b),
            [re.findall(r'"([a-z_.]+)"', x) for x in re.findall(r"RequireAny\(([^)]*)\)", b)]
            # RequireSiteView: report.view for any station, shift.open for one's own.
            + ([["report.view", "shift.open"]] if "RequireSiteView(" in b else []),
            re.findall(r'Can\("([a-z_.]+)"\)', b),
        )

routes = {}
for f, raw in CS.items():
    src = re.sub(r"//[^\n]*", "", raw)
    g = {m.group(1): m.group(2) for m in re.finditer(r'var\s+(\w+)\s*=\s*app\.MapGroup\("([^"]+)"\)', src)}
    for m in re.finditer(r'\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*"([^"]*)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>(?=(.{0,300}))',
                         src, re.S):
        h, meth, tpl, args, tail = m.groups()
        pre = g.get(h, "" if h == "app" else None)
        if pre is None:
            continue
        path = re.sub(r"\{[^}]*\}", ":p", (pre + tpl).replace("//", "/")).rstrip("/") or "/"
        svc = {a.split()[1]: a.split()[0] for a in [x.strip() for x in args.split(",")]
               if len(a.split()) == 2 and a.split()[0][0].isupper()}
        c = re.search(r"await\s+(\w+)\.(\w+)\(", tail)
        routes[f"{meth.upper()} {path}"] = (need.get((svc.get(c.group(1)), c.group(2)), ([], [], []))
                                            if c and c.group(1) in svc else ([], [], []))


def allowed(role: str, route: str) -> bool:
    req, anyof, can = routes.get(route, ([], [], []))
    held = perms.get(role, set())
    if req and not all(x in held for x in req):
        return False
    if any(grp and not any(x in held for x in grp) for grp in anyof):
        return False
    if can and not any(x in held for x in can):
        return False
    return True


reads: dict[str, set[str]] = {}
CALL = re.compile(r"api\s*\.\s*(get|post|put|del)<[^>]*>\(\s*[`'\"]([^`'\"]+)[`'\"]", re.S)
for f in (ROOT / "web" / "src" / "app").rglob("*.tsx"):
    rel = str(f).split("src/app/")[1]
    scr = rel.split("/components")[0].replace("/page.tsx", "")
    s = f.read_text(encoding="utf-8")
    for m in CALL.finditer(s):
        if m.group(1) != "get":
            continue
        p = re.sub(r"\$\{[^}]*\}", ":p", m.group(2)).split("?")[0].rstrip("/")
        reads.setdefault(scr, set()).add("GET " + re.sub(r"(?::p)+", ":p", p))
    if "useSites()" in s:
        reads.setdefault(scr, set()).add("GET /api/v1/dashboard/overview")

problems = []
for role, screens in WORK.items():
    for scr in screens:
        for r in sorted(reads.get(scr, [])):
            if not allowed(role, r):
                problems.append(f"{role} works from {scr} but cannot load {r}")

# --- every route checks its own permission, or is openly listed
#
# The audit found 33 reads with no permission check of their own. Company
# isolation held (row-level security), but WITHIN a company any signed-in user
# -- a supervisor included -- could read the loss reports, the attendant
# scorecard, credit statements, supplier balances and the cash position. The
# directors' pack was guarded only by accident: its first call happened to be
# to a method that checked.
#
# Now: a route either checks, or it is on this list, with the reason it is
# open to any signed-in operator.
OPEN_READS = {
    # Running the forecourt: every operator on shift needs these.
    "GET /api/shifts": "the shift list", "GET /api/shifts/current": "the open shift",
    "GET /api/shifts/:p": "a shift's detail", "GET /api/shifts/:p/tenders": "a shift's tenders",
    "GET /api/shifts/:p/activity": "a shift's log",
    "GET /api/dry-stock/items": "ringing up the shop", "GET /api/dry-stock/shifts/:p/sales": "this shift's shop sales",
    "GET /api/credit/customers": "recording a credit sale needs the customer and their headroom",
    "GET /api/credit/shifts/:p/sales": "this shift's credit sales",
    "GET /api/ops/prices/pending": "a price change due at close",
    "GET /api/ops/stock-counts/:p/lines": "the count being conducted",
    "GET /api/dry-counts/:p/lines": "the count being conducted",
    "GET /api/forecourt/exceptions": "exceptions on the shift",
    "GET /api/v1/income/categories": "reference list", "GET /api/setup/payment-channels": "reference list",
    "GET /api/deliveries": "receiving a delivery", "GET /api/depot/day/current": "the open depot day",
    "GET /api/rosters": "rostering",
}

def _route_methods():
    for f, raw in CS.items():
        src = re.sub(r"//[^\n]*", "", raw)
        g = {m.group(1): m.group(2) for m in re.finditer(r'var\s+(\w+)\s*=\s*app\.MapGroup\("([^"]+)"\)', src)}
        for m in re.finditer(r'\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*"([^"]*)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>(?=(.{0,400}))', src, re.S):
            h, meth, tpl, args, tail = m.groups()
            pre = g.get(h, "" if h == "app" else None)
            if pre is None:
                continue
            path = re.sub(r"\{[^}]*\}", ":p", (pre + tpl).replace("//", "/")).rstrip("/") or "/"
            svc = {a.split()[1]: a.split()[0] for a in [x.strip() for x in args.split(",")]
                   if len(a.split()) == 2 and a.split()[0][0].isupper()}
            c = re.search(r"await\s+(\w+)\.(\w+)\(", tail)
            if c and c.group(1) in svc:
                yield f"{meth.upper()} {path}", (svc[c.group(1)], c.group(2))

# Whether a method checks ANYTHING -- including a computed permission such as
# Require(isWriteOff ? "shortage.write_off" : "shortage.approve") or
# Can(def.Permission). The first version recognised only literal strings and
# flagged both of those, which do check.
_checks_any = {}
for f, src in CS.items():
    code = re.sub(r"//[^\n]*", "", src)
    cls = None
    for m in re.finditer(r"\bclass\s+(\w+)|public async Task(?:<[^>]*(?:<[^>]*>)?[^>]*>)?\s+(\w+)\s*\(", code):
        if m.group(1):
            cls = m.group(1)
            continue
        st = code.index("{", m.end())
        d, i = 0, st
        while i < len(code):
            if code[i] == "{":
                d += 1
            elif code[i] == "}":
                d -= 1
                if d == 0:
                    break
            i += 1
        _checks_any[(cls, m.group(2))] = bool(re.search(r"\bRequire(Any|SiteView)?\(|\.Can\(", code[st:i]))

for route, key in _route_methods():
    if not _checks_any.get(key, True) and route not in OPEN_READS and "/api/auth/" not in route:
        problems.append(f"{route} checks no permission and is not on the open list - "
                        f"any signed-in user in the company can call it")

print("=" * 70)
print("ROLES vs SCREENS")
print("  can each role load the screens it works from?")
print("=" * 70)
print(f"roles {len(perms)}  screens judged {sum(len(v) for v in WORK.values())}")
if problems:
    print(f"\nPROBLEMS ({len(problems)})")
    for p in problems:
        print("  X", p)
else:
    print("\nPROBLEMS  none -- every role can load the screens it works from")
sys.exit(1 if problems else 0)
