#!/usr/bin/env python3
"""
FCMS contract check -- frontend calls vs backend endpoints.

This exists because of the two most expensive findings in the v1 audit, which
were the same fault seen from opposite ends:

  H1  POST /api/credit/sales existed in the backend and NOTHING in 24 frontend
      routes ever called it. The balance rule needs credit in the allocation, so
      every station selling on credit had an attendant short by exactly the
      credit value, every shift, unable to close. The feature was "built".

  H2  Six more endpoints had no caller at all -- banking among them, so cash
      declared at cash-up was never followed through to a deposit and the trail
      ended in a supervisor's drawer.

Neither is visible in a compiler, a test suite, or a code review of either side
alone. They are only visible when you look at both at once, which is what this
does. Run it in CI: an endpoint without a caller is either dead code or a
missing screen, and both need a decision from a person.
"""
import re, sys, pathlib
from collections import defaultdict

ROOT = pathlib.Path(__file__).parent.parent
API = ROOT / "api"
WEB = ROOT / "web"

# ---------------------------------------------------------------------------
# 1. What the backend exposes.
# ---------------------------------------------------------------------------
endpoints = {}          # normalised path -> (method, source file)
group_of = {}

for cs in API.rglob("*.cs"):
    src = cs.read_text(encoding="utf-8")

    # A file can declare several route groups:
    #   var g = app.MapGroup("/api/reports");
    #   var r = app.MapGroup("/api/rosters");
    # so the group must be tracked PER VARIABLE, not per file. Taking the first
    # MapGroup as the base for everything silently files every roster endpoint
    # under /api/reports, and then reports a perfectly good call as broken.
    group_base = {}
    for m in re.finditer(r'var\s+(\w+)\s*=\s*app\.MapGroup\(\s*"([^"]+)"', src):
        group_base[m.group(1)] = m.group(2)

    for m in re.finditer(r'\b(\w+)\.Map(Get|Post|Put|Delete)\(\s*"([^"]*)"', src):
        var, method, sub = m.group(1), m.group(2).upper(), m.group(3)
        base = group_base.get(var, "")
        full = (base + sub) if sub.startswith("/") else base
        norm = re.sub(r"\{[^}]+\}", ":p", full).rstrip("/")
        if norm:
            endpoints[(method, norm)] = cs.name
    for m in re.finditer(r'app\.MapHealthChecks\(\s*"([^"]+)"', src):
        endpoints[("GET", m.group(1))] = cs.name

# ---------------------------------------------------------------------------
# 2. What the frontend calls.
# ---------------------------------------------------------------------------
calls = defaultdict(list)   # (method, normalised path) -> [source files]

for ts in list(WEB.rglob("*.ts")) + list(WEB.rglob("*.tsx")):
    if ".stub" in str(ts) or ts.name.endswith(".d.ts"):
        continue
    src = ts.read_text(encoding="utf-8")
    for m in re.finditer(
        r"api\s*\.\s*(get|post|put|delete)\s*<[^>]*>\s*\(\s*[`\"']([^`\"']+)[`\"']", src
    ):
        method, path = m.group(1).upper(), m.group(2)
        norm = re.sub(r"\$\{[^}]+\}", ":p", path)
        norm = re.sub(r"\?.*$", "", norm).rstrip("/")
        calls[(method, norm)].append(ts.name)
    # A path assigned to a const and then used, e.g.
    #     const path = `/api/depot/day/${id}/close`;
    #     api.post(`${path}?preview=true`, ...)
    # The literal is still right there; only the indirection hides it. Matching
    # the assignment keeps the checker honest without forcing the frontend to
    # write awkward code for the tool's benefit.
    for m in re.finditer(r"const \w+ = `(/api/[^`]*)`", src):
        norm = re.sub(r"\$\{[^}]+\}", ":p", m.group(1))
        norm = re.sub(r"\?.*$", "", norm).rstrip("/")
        calls[("POST", norm)].append(ts.name)

    # untyped form: api.post("/x", ...)
    for m in re.finditer(
        r"api\s*\.\s*(get|post|put|delete)\s*\(\s*[`\"']([^`\"']+)[`\"']", src
    ):
        method, path = m.group(1).upper(), m.group(2)
        norm = re.sub(r"\$\{[^}]+\}", ":p", path)
        norm = re.sub(r"\?.*$", "", norm).rstrip("/")
        calls[(method, norm)].append(ts.name)

# ---------------------------------------------------------------------------
# 3. Compare.
# ---------------------------------------------------------------------------
# A path built from a variable -- `/api/statements/${key}` -- cannot be matched
# against a route table by reading it. The checker rewrites interpolations as
# :p, so the literal ":p" in a path means "resolved at runtime", not "wrong".
# Flagging it would push whoever runs this toward hardcoding paths, which is
# worse than the check.
calls = {k: v for k, v in calls.items() if ":p" not in k[1]}

broken = []      # frontend calls something that does not exist -> a 404 at runtime
uncalled = []    # backend exposes something nobody uses -> dead code or missing screen

for key, files in calls.items():
    if key not in endpoints:
        broken.append((key, sorted(set(files))))

# Endpoints that are legitimately called by something other than the web client.
EXEMPT = {
    ("GET", "/health"),
    # Machine-to-machine. The ATG is somebody else's hardware on a serial line;
    # polling it belongs in a small agent on the station's own network, not in
    # a screen. This endpoint is that agent's door.
    ("POST", "/api/setup/atg"),
    # Calibration is equipment configuration, not accounting, and was taken off
    # the Operations screen deliberately. The endpoint stays: a chart is loaded
    # once when a tank is commissioned or recalibrated, by whoever set the tank
    # up, and it does not belong in a supervisor's daily flow.
    ("POST", "/api/ops/tanks/:p/calibration"),
    # Catalogue setup: products, tender channels and suppliers are defined when
    # a station is commissioned and barely touched afterwards. The endpoints
    # exist for that provisioning, and for the seed; building three forms
    # somebody opens twice a year would be surface for its own sake.
    ("POST", "/api/admin/products"),
    ("POST", "/api/admin/channels"),
    ("POST", "/api/admin/suppliers"),
}

for key, src in endpoints.items():
    if key in calls or key in EXEMPT:
        continue
    uncalled.append((key, src))

print("=" * 70)
print("FCMS CONTRACT CHECK -- frontend <-> backend")
print("=" * 70)
print(f"endpoints exposed {len(endpoints)}   distinct calls {len(calls)}")
print()

if broken:
    print(f"BROKEN CALLS ({len(broken)}) -- these 404 at runtime")
    for (method, path), files in sorted(broken):
        print(f"  X {method:6} {path}")
        print(f"           called from {', '.join(files)}")
    print()
else:
    print("BROKEN CALLS  none")
    print()

if uncalled:
    print(f"UNCALLED ENDPOINTS ({len(uncalled)}) -- dead code, or a screen not built yet")
    for (method, path), src in sorted(uncalled):
        print(f"  * {method:6} {path}   ({src})")
    print()
    print("  Each needs a decision: build the screen, or delete the endpoint.")
    print("  v1 shipped seven of these. One of them (credit sales) meant no")
    print("  station selling on credit could ever close a balanced shift.")
else:
    print("UNCALLED ENDPOINTS  none")


# ---------------------------------------------------------------------------
# 4. Internal links vs pages that actually exist.
#
# Added after the dashboard shipped with three href values pointing at routes
# nobody had built. The API contract was perfect; the app 404'd on tap. Same
# class of fault as H1 -- correct on both sides, broken between them -- and it
# needed the same kind of check.
# ---------------------------------------------------------------------------
pages = set()
for page in WEB.rglob("page.tsx"):
    rel = page.relative_to(WEB / "src" / "app").parent.as_posix()
    route = "/" if rel == "." else "/" + rel
    pages.add(re.sub(r"\[[^\]]+\]", ":p", route))

links = defaultdict(list)
for ts in list(WEB.rglob("*.tsx")):
    src = ts.read_text(encoding="utf-8")
    for m in re.finditer(r'href=\{?[`"\']([^`"\'{}]*(?:\$\{[^}]+\}[^`"\']*)*)[`"\']', src):
        raw = m.group(1)
        if not raw.startswith("/"):
            continue
        norm = re.sub(r"\$\{[^}]+\}", ":p", raw).split("?")[0].rstrip("/") or "/"
        links[norm].append(ts.name)

dead_links = [(l, sorted(set(f))) for l, f in links.items() if l not in pages]

if dead_links:
    print(f"DEAD LINKS ({len(dead_links)}) -- these 404 when tapped")
    for link, files in sorted(dead_links):
        print(f"  \u2717 {link}")
        print(f"           linked from {', '.join(files)}")
    print()
else:
    print("DEAD LINKS  none")
    print()

# A broken call is a build failure. An uncalled endpoint is a warning -- it is
# legitimate mid-build, but it must never be invisible.
sys.exit(1 if (broken or dead_links) else 0)
