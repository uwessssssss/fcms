#!/usr/bin/env python3
"""
FCMS coverage check -- schema features nothing can reach.

The contract checker compares the frontend to the backend. It is blind to a
whole class of gap where BOTH SIDES AGREE ON NOTHING EXISTING: a table the
schema defines, that no C# file mentions, that no screen could possibly show.

That blind spot hid six core features for several rounds of work -- the price
break specified in the original brief, discounts (without which an attendant
who gave a fleet rate could not close a balanced shift), the monthly stock take,
banking, shortage recovery, and calibration import. Every one of them was
correct in the database and completely unreachable.

This asks the other question: for every table and function in the schema, is
there any path from a user to it?

Some objects are legitimately internal -- written by other SQL, not by C#. Those
are listed explicitly rather than pattern-matched, so adding a new one is a
deliberate act somebody has to justify in a code review.
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).parent.parent
MIGRATIONS = ROOT / "db" / "migrations"
API = ROOT / "api"

# Objects written or read only by other database code. Each entry says why.
INTERNAL_TABLES = {
    "fuel_movement":      "written by fn_close_shift, fn_receive_delivery, fn_post_stock_count",
    "money_movement":     "written by fn_close_shift",
    "metered_disposition": "written by fn_close_shift",
    "meter_event":        "written by fn_close_shift",
    "cash_up":            "written by fn_close_shift; read through v_cash_up_position",
    "staff_shortage":     "written by fn_close_shift; read through v_staff_shortage_balance",
    "dry_movement":       "written by the dry stock service through its own inserts",
    "shift_price":        "written by fn_capture_shift_prices",
    "bulk_draw":          "written by the forecourt service alongside own_use",
    "audit_log":          "insert-only; no read surface yet -- see gaps below",
    "idempotency_record": "written by IdempotencyMiddleware",
    "role_permission":    "mirrored in RolePermissions.cs",
    "schema_migration":   "written by migrate.sh",
    "tenant":             "created at provisioning, not in the app",
    "tenant_policy":      "created at provisioning, not in the app",
}

INTERNAL_FUNCTIONS = {
    "fn_movement_sign", "fn_dry_sign", "fn_apply_tenant_rls", "fn_rls_on_create",
    "fn_require_operator_author", "fn_meter_delta", "fn_capture_shift_prices",
    "fn_current_price", "fn_shift_price", "fn_business_date", "fn_raise_flag",
    "fn_has_permission", "fn_weighted_avg_cost", "fn_dry_on_hand",
    "fn_session_is_live", "fn_auth_record_attempt", "fn_movement_sign",
}

sql = "\n".join(p.read_text(encoding="utf-8") for p in MIGRATIONS.glob("*.sql"))
sql = re.sub(r"--[^\n]*", "", sql)

tables = {m.group(1).lower() for m in
          re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)", sql, re.I)}
functions = {m.group(1).lower() for m in
             re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION (fn_\w+)", sql, re.I)}
views = {m.group(1).lower() for m in
         re.finditer(r"CREATE (?:OR REPLACE )?VIEW (v_\w+)", sql, re.I)}

cs = "\n".join(p.read_text(encoding="utf-8") for p in API.rglob("*.cs"))

unreachable_tables, unreachable_functions, unreachable_views = [], [], []

for t in sorted(tables):
    if t in INTERNAL_TABLES:
        continue
    if not re.search(rf"\b{re.escape(t)}\b", cs, re.I):
        unreachable_tables.append(t)

for f in sorted(functions):
    if f in INTERNAL_FUNCTIONS:
        continue
    if f not in cs:
        unreachable_functions.append(f)

for v in sorted(views):
    if v not in cs:
        unreachable_views.append(v)

print("=" * 70)
print("FCMS COVERAGE CHECK -- schema features nothing can reach")
print("=" * 70)
print(f"tables {len(tables)}   functions {len(functions)}   views {len(views)}")
print()

total = len(unreachable_tables) + len(unreachable_functions) + len(unreachable_views)

if unreachable_tables:
    print(f"TABLES WITH NO API ({len(unreachable_tables)})")
    for t in unreachable_tables:
        print(f"  * {t}")
    print()

if unreachable_functions:
    print(f"FUNCTIONS NOTHING CALLS ({len(unreachable_functions)})")
    for f in unreachable_functions:
        print(f"  * {f}()")
    print()

if unreachable_views:
    print(f"VIEWS NOTHING READS ({len(unreachable_views)})")
    for v in unreachable_views:
        print(f"  * {v}")
    print()

if total == 0:
    print("Every schema feature has a path from a user to it.")
else:
    print(f"{total} feature(s) exist in the database and cannot be reached.")
    print("Each needs a decision: build the surface, or delete the schema.")
    print()
    print("If one is genuinely internal -- written by other SQL rather than by")
    print("C# -- add it to INTERNAL_TABLES or INTERNAL_FUNCTIONS with a reason.")
    print("Making that explicit means adding one is a deliberate act somebody")
    print("has to justify, not a silent omission.")

# A warning, not a failure. Mid-build these are expected; invisible is the
# problem, not present.
sys.exit(0)
