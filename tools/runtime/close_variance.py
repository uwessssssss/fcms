"""fn_close_variance (migration 430), mirrored statement for statement: what
THIS shift lost, not the standing gap. Guarded against the SQL drifting."""
import sys, pathlib
SQL = (pathlib.Path(__file__).resolve().parents[2] / 'db' / 'migrations' / '430_close_variance_is_a_change.sql').read_text(encoding='utf-8')
for frag in ("AND shift_id IS DISTINCT FROM p_shift_id AND captured_at < p_at",
             "v_prev_level := v_prev.product_litres - fn_book_stock(p_tank_id, v_prev.captured_at);",
             "WHERE tank_id = p_tank_id AND kind = 'STOCK_TAKE_ADJUST'",
             "RETURN (p_actual - fn_book_stock(p_tank_id, p_at)) - v_prev_level + v_adj;"):
    if frag not in SQL:
        print(f"  FAIL  the SQL no longer contains: {frag}"); sys.exit(1)
# The book at a moment, and the close dips so far (shift, time, product litres).
moves = [(0, 10_000), (10, -1_000), (20, -1_000), (25, -40), (30, -1_000)]   # (time, signed litres); 25 = stock count
book = lambda at: sum(s for t, s in moves if t <= at)
adj = [(25, -40)]
dips = []
def close_variance(actual, at, shift):
    prev = [d for d in dips if d[0] != shift and d[1] < at]
    lvl = 0; a = 0
    if prev:
        ps, pt, pa = max(prev, key=lambda d: d[1])
        lvl = pa - book(pt)
        a = sum(s for t, s in adj if pt < t <= at)
    return (actual - book(at)) - lvl + a
ok = bad = 0
def check(n, got, want):
    global ok, bad
    g = abs(got - want) < 1e-6; ok += g; bad += not g
    print(f"  {'PASS' if g else 'FAIL'}  {n}: got {got}, expected {want}")
v1 = close_variance(8_960, 10, 'S1'); dips.append(('S1', 10, 8_960))
check("shift 1 loses 40 L and is flagged for 40", v1, -40)
v2 = close_variance(7_960, 20, 'S2'); dips.append(('S2', 20, 7_960))
check("shift 2 loses nothing: its variance is 0", v2, 0)
check("...where the OLD rule flagged it for the same 40", 7_960 - book(20), -40)
v3 = close_variance(6_960, 30, 'S3'); dips.append(('S3', 30, 6_960))
check("shift 3, after a count wrote the 40 off: still 0, no fake gain", v3, 0)
print(f"{ok} passed, {bad} failed"); sys.exit(1 if bad else 0)
