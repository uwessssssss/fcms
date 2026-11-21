"""The cash running balance and variance-as-at-close, executed in SQLite
against worked examples. PostgreSQL is the real engine; this runs the SAME
query shape so the arithmetic is tested by execution, not by reading."""
import sqlite3, sys
db = sqlite3.connect(':memory:'); c = db.cursor(); ok = fail = 0
def check(name, got, want):
    global ok, fail
    good = abs(got - want) < 1e-6; ok += good; fail += not good
    print(f"  {'PASS' if good else 'FAIL'}  {name}: got {got}, expected {want}")
# Cash: Mon collects 1,000,000; Tue collects 400,000 and banks Monday's; Wed collects
# 300,000 and banks Tuesday's. By hand: 300,000 is in the station at Wed close.
c.execute("CREATE TABLE v_cash_position (site_id TEXT, business_date TEXT, cash_collected REAL, cash_banked REAL, on_hand REAL)")
for s, d, col, b in [('S1','2026-09-21',1_000_000,0), ('S1','2026-09-22',400_000,1_000_000),
                     ('S1','2026-09-23',300_000,400_000), ('S2','2026-09-23',50_000,0)]:
    c.execute("INSERT INTO v_cash_position VALUES (?,?,?,?,?)", (s, d, col, b, col - b))
q = """SELECT BusinessDate, RunningOnHand FROM (
         SELECT business_date AS BusinessDate,
                SUM(SUM(on_hand)) OVER (ORDER BY business_date) AS RunningOnHand
           FROM v_cash_position WHERE (? IS NULL OR site_id = ?) GROUP BY business_date) x
        WHERE BusinessDate > ? ORDER BY BusinessDate DESC"""
check("station: cash held at the latest close", c.execute(q, ('S1','S1','2026-09-20')).fetchall()[0][1], 300_000)
check("a window starting after Monday still counts Monday", c.execute(q, ('S1','S1','2026-09-22')).fetchall()[0][1], 300_000)
check("head office: the whole company", c.execute(q, (None, None, '2026-09-20')).fetchall()[0][1], 350_000)
# Variance: opens 10,000; shift A sells 2,000 (closes 10:00), dip 7,950 -> 50 L missing.
c.execute("CREATE TABLE fuel_movement (tank_id TEXT, occurred_at TEXT, signed_litres REAL)")
c.executemany("INSERT INTO fuel_movement VALUES (?,?,?)", [('T','06:00',10_000), ('T','10:00',-2_000), ('T','12:00',5_000), ('T','18:00',-3_000)])
book = lambda at: c.execute("SELECT COALESCE(SUM(signed_litres),0) FROM fuel_movement WHERE tank_id='T' AND occurred_at <= ?", (at,)).fetchone()[0]
check("shift A's variance, as at its close", 7_950 - book('10:00'), -50)
# Migration 360: cash counted every way it moves. Same scenario, plus on Wed a
# 50,000 transport expense paid from the till and a customer settling 120,000
# in cash. By hand: 300,000 - 50,000 + 120,000 = 370,000 in the station.
for t in ("money_in (site_id TEXT, business_date TEXT, amount REAL)",
          "expense (site_id TEXT, business_date TEXT, amount REAL, paid_from TEXT)",
          "credit_payment (site_id TEXT, business_date TEXT, amount REAL, method TEXT)",
          "banking (site_id TEXT, business_date TEXT, amount REAL)"):
    c.execute("CREATE TABLE " + t)
c.executemany("INSERT INTO money_in VALUES (?,?,?)", [('S1','2026-09-21',1_000_000), ('S1','2026-09-22',400_000), ('S1','2026-09-23',300_000)])
c.executemany("INSERT INTO banking VALUES (?,?,?)", [('S1','2026-09-22',1_000_000), ('S1','2026-09-23',400_000)])
c.execute("INSERT INTO expense VALUES ('S1','2026-09-23',50000,'TILL_CASH')")
c.execute("INSERT INTO expense VALUES ('S1','2026-09-23',90000,'BANK')")          # not from the till
c.execute("INSERT INTO credit_payment VALUES ('S1','2026-09-23',120000,'CASH')")
c.execute("INSERT INTO credit_payment VALUES ('S1','2026-09-23',500000,'BANK')")  # never touched the till
v = """WITH moves AS (
         SELECT site_id, business_date, SUM(amount) AS cash_in, 0 AS cash_out, 0 AS banked FROM money_in GROUP BY 1,2
         UNION ALL SELECT site_id, business_date, SUM(amount), 0, 0 FROM credit_payment WHERE method='CASH' GROUP BY 1,2
         UNION ALL SELECT site_id, business_date, 0, SUM(amount), 0 FROM expense WHERE paid_from='TILL_CASH' GROUP BY 1,2
         UNION ALL SELECT site_id, business_date, 0, 0, SUM(amount) FROM banking GROUP BY 1,2)
       SELECT business_date, SUM(SUM(cash_in) - SUM(cash_out) - SUM(banked)) OVER (ORDER BY business_date)
         FROM moves GROUP BY business_date ORDER BY business_date DESC"""
check("cash in the station, every way it moves", c.execute(v).fetchall()[0][1], 370_000)
# Migration 420: a day's loss is the CHANGE in the tank-against-book gap.
# Day 1 loses 40 L; day 2 loses nothing; day 3 a stock count writes the 40 L
# off the book; day 4 loses 10 L. By hand: 50 L lost. The old view said 90.
c.execute("CREATE TABLE closes (tank_id TEXT, business_date TEXT, captured_at TEXT, actual REAL, book REAL)")
c.execute("CREATE TABLE adj (tank_id TEXT, occurred_at TEXT, signed_litres REAL)")
c.executemany("INSERT INTO closes VALUES (?,?,?,?,?)", [
    ('T','d1','d1 18:00', 8960, 9000), ('T','d2','d2 18:00', 7960, 8000),
    ('T','d3','d3 18:00', 6960, 6960), ('T','d4','d4 18:00', 5950, 5960)])
c.execute("INSERT INTO adj VALUES ('T','d3 12:00',-40)")
q = """WITH lev AS (
         SELECT tank_id, business_date, captured_at, actual - book AS level,
                LAG(actual - book) OVER w AS prev_level, LAG(captured_at) OVER w AS prev_captured
           FROM closes WINDOW w AS (PARTITION BY tank_id ORDER BY business_date))
       SELECT business_date, level - COALESCE(prev_level, 0)
              + COALESCE((SELECT SUM(signed_litres) FROM adj a WHERE a.tank_id = lev.tank_id
                            AND a.occurred_at > COALESCE(prev_captured, '') AND a.occurred_at <= captured_at), 0)
         FROM lev ORDER BY business_date"""
days = dict(c.execute(q).fetchall())
check("day 1: the 40 L loss", days['d1'], -40)
check("day 2: nothing more lost, so no loss", days['d2'], 0)
check("day 3: the count's write-off is not a fake gain", days['d3'], 0)
check("day 4: the new 10 L loss", days['d4'], -10)
check("the period: 50 L lost", sum(days.values()), -50)
old = c.execute("SELECT SUM(actual - book) FROM closes").fetchone()[0]
check("the OLD view's period total - was wrong", old, -90)
# Migration 440: one account per customer. 1,000,000 on credit at the pump,
# 10,000,000 loaded at the depot, 10,500,000 paid. By hand: 500,000 owed.
c.execute("CREATE TABLE acct_fuel (id TEXT, customer_id TEXT, recorded_at TEXT, amount REAL)")
c.execute("CREATE TABLE acct_bulk (id TEXT, customer_id TEXT, loaded_at TEXT, amount REAL, payment_terms TEXT)")
c.execute("CREATE TABLE acct_payment (customer_id TEXT, received_at TEXT, amount REAL)")
c.execute("INSERT INTO acct_fuel VALUES ('f1','C','d1',1000000)")
c.execute("INSERT INTO acct_bulk VALUES ('b1','C','d2',10000000,'CREDIT')")
c.execute("INSERT INTO acct_bulk VALUES ('b2','C','d2',3000000,'CASH')")     # cash terms: not on account
c.execute("INSERT INTO acct_payment VALUES ('C','d3',10500000)")
settle = """WITH charges AS (
      SELECT id, customer_id, recorded_at, amount FROM acct_fuel
      UNION ALL SELECT id, customer_id, loaded_at, amount FROM acct_bulk WHERE payment_terms = 'CREDIT'),
    sales AS (SELECT *, SUM(amount) OVER (PARTITION BY customer_id ORDER BY recorded_at, id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS billed_through FROM charges),
    receipts AS (SELECT customer_id, SUM(amount) AS paid FROM acct_payment GROUP BY customer_id)
    SELECT s.id, s.amount - MAX(0, MIN(s.amount, COALESCE(r.paid,0) - (s.billed_through - s.amount)))
      FROM sales s LEFT JOIN receipts r ON r.customer_id = s.customer_id ORDER BY s.recorded_at"""
rows = dict(c.execute(settle).fetchall())
check("pump sale settled first (oldest)", rows['f1'], 0)
check("the depot load: 500,000 still owed", rows['b1'], 500000)
check("the customer's balance", sum(rows.values()), 500000)
old = c.execute("""SELECT SUM(amount) - (SELECT SUM(amount) FROM acct_payment) FROM acct_fuel""").fetchone()[0]
check("the OLD statement's balance: 9.5M in CREDIT - was wrong", old, -9500000)
# Migration 450: a further 1,500,000 paid -> 12,000,000 against 11,000,000 billed.
c.execute("INSERT INTO acct_payment VALUES ('C','d4',1500000)")
rows = dict(c.execute(settle).fetchall())
check("everything billed is now settled", sum(rows.values()), 0)
ahead = c.execute("""SELECT MAX(0, (SELECT SUM(amount) FROM acct_payment)
                          - (SELECT SUM(amount) FROM acct_fuel)
                          - (SELECT SUM(amount) FROM acct_bulk WHERE payment_terms = 'CREDIT'))""").fetchone()[0]
check("1,000,000 paid ahead is kept, not lost", ahead, 1000000)
limit = 2_000_000
check("room to buy: limit + paid ahead", limit - sum(rows.values()) + ahead, 3000000)
print(f"{ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
