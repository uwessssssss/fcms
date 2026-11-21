"""fn_weighted_avg_cost (migration 380), mirrored statement for statement and
run against a scenario worked by hand. PL/pgSQL cannot run here; this is the
same algorithm, so a change to one must be made to the other."""
import sys, pathlib
# The mirror is only a test while it matches the SQL. If these decisions change
# in the migration, this fails -- update the mirror with them.
SQL = (pathlib.Path(__file__).resolve().parents[2] / 'db' / 'migrations' / '380_moving_average_cost.sql').read_text(encoding='utf-8')
for frag in ("r.kind IN ('DELIVERY_IN', 'BULK_IN') AND r.unit_cost IS NOT NULL AND r.signed_litres > 0",
             "IF v_avg IS NULL OR v_stock <= 0 THEN",
             "v_avg := (v_stock * v_avg + r.signed_litres * r.unit_cost) / (v_stock + r.signed_litres);",
             "ORDER BY occurred_at, id"):
    if frag not in SQL:
        print(f"  FAIL  the SQL no longer contains: {frag}"); sys.exit(1)
# Shop stock (390) runs the SAME algorithm over purchases -- guarded the same way.
SHOP = (pathlib.Path(__file__).resolve().parents[2] / 'db' / 'migrations' / '390_shop_moving_average.sql').read_text(encoding='utf-8')
for frag in ("r.kind = 'PURCHASE_IN' AND r.unit_cost IS NOT NULL AND r.signed_qty > 0",
             "IF v_avg IS NULL OR v_qty <= 0 THEN",
             "v_avg := (v_qty * v_avg + r.signed_qty * r.unit_cost) / (v_qty + r.signed_qty);",
             "AND site_id = p_site_id", "ORDER BY occurred_at, id"):
    if frag not in SHOP:
        print(f"  FAIL  the shop SQL no longer contains: {frag}"); sys.exit(1)
def moving_avg(moves, at=None):
    stock, avg = 0.0, None
    for i, (t, kind, signed, cost) in enumerate(moves):
        if at is not None and t > at: break
        if kind in ('DELIVERY_IN', 'BULK_IN') and cost is not None and signed > 0:
            avg = cost if (avg is None or stock <= 0) else (stock * avg + signed * cost) / (stock + signed)
        stock += signed
    return None if avg is None else round(avg, 4)
def simple_avg(moves, at=None):          # the OLD function, for contrast
    ins = [(s, c) for t, k, s, c in moves if k in ('DELIVERY_IN', 'BULK_IN') and c and (at is None or t <= at)]
    return round(sum(s * c for s, c in ins) / sum(s for s, _ in ins), 4)
M = [(1, 'DELIVERY_IN', 10_000, 4000), (2, 'METER_OUT', -6_000, None),
     (3, 'DELIVERY_IN',  6_000, 5000), (4, 'METER_OUT', -10_000, None),
     (5, 'DELIVERY_IN',  5_000, 6000), (6, 'METER_OUT', -7_000, None),
     (7, 'BULK_IN',      5_000, 6500), (8, 'TEST_RETURN_IN', 20, None), (9, 'METER_OUT', -20, None)]
ok = bad = 0
def check(n, got, want):
    global ok, bad
    good = got is not None and abs(got - want) < 1e-4
    ok += good; bad += not good
    print(f"  {'PASS' if good else 'FAIL'}  {n}: got {got}, expected {want}")
check("first delivery sets the cost", moving_avg(M, 1), 4000)
check("a sale does not move the average", moving_avg(M, 2), 4000)
check("4,000 L left at 4,000 + 6,000 L at 5,000", moving_avg(M, 3), 4600)
check("...where the OLD simple average said", simple_avg(M, 3), 4375)
check("sold out to zero, the next delivery sets it", moving_avg(M, 5), 6000)
check("sold into NEGATIVE, the next delivery sets it", moving_avg(M, 7), 6500)
check("pump-test returns and sales do not move it", moving_avg(M), 6500)
print(f"{ok} passed, {bad} failed"); sys.exit(1 if bad else 0)
