#!/usr/bin/env python3
"""
Set FCMS's figures for the replayed month beside the workbook's, day by day,
and write the reconciliation as Markdown on stdout.

FCMS's side is computed only from what FCMS stored: meter events, its fuel
ledger, its dips, its cash-ups. The workbook's side is its own columns.
"""
import json
import os
import subprocess
import sys

PORT = os.environ.get("SIM_PORT", "5547")
DB = os.environ.get("REPLAY_DB", "fcms_replay")


def rows(sql):
    p = subprocess.run(["psql", "-X", "-At", "-F", "\t", "-h", "localhost", "-p", PORT, "-U", "postgres", "-d", DB,
                        "-c", sql], capture_output=True, text=True, check=True)
    return [line.split("\t") for line in p.stdout.splitlines() if line]


def f(x):
    return float(x) if x not in (None, "") else 0.0


def fmt(x, d=0):
    return f"{x:,.{d}f}"


def main():
    sheet = json.load(open(sys.argv[1]))
    rep = json.load(open(sys.argv[2]))
    month = sys.argv[3]
    D = sheet["days"]

    sold = {}
    for d, p, l in rows("""
SELECT sh.business_date, pr.code, SUM(md.litres) FILTER (WHERE md.kind = 'SALE')
  FROM shift sh JOIN meter_event me ON me.shift_id = sh.id
  JOIN metered_disposition md ON md.meter_event_id = me.id
  JOIN tank t ON t.id = me.tank_id JOIN product pr ON pr.id = t.product_id
 GROUP BY 1, 2"""):
        sold[(d, p)] = f(l)

    # FCMS's own day: closing dip - (opening dip + every movement it booked).
    var = {}
    for d, p, v in rows("""
WITH day AS (SELECT business_date AS d, array_agg(id ORDER BY opened_at) AS ids FROM shift GROUP BY 1)
SELECT day.d, pr.code,
       (SELECT product_litres FROM dip_reading WHERE tank_id = t.id AND context = 'SHIFT_CLOSE'
           AND shift_id = day.ids[array_upper(day.ids, 1)])
     - (SELECT product_litres FROM dip_reading WHERE tank_id = t.id AND context = 'SHIFT_OPEN' AND shift_id = day.ids[1])
     - COALESCE((SELECT SUM(signed_litres) FROM fuel_movement fm WHERE fm.tank_id = t.id
                   AND (fm.shift_id = ANY(day.ids)
                        OR fm.delivery_line_id IN (SELECT dl.id FROM delivery_line dl JOIN delivery dv ON dv.id = dl.delivery_id
                                                    WHERE dv.decant_shift_id = ANY(day.ids)))), 0)
  FROM day CROSS JOIN tank t JOIN product pr ON pr.id = t.product_id"""):
        var[(d, p)] = f(v)

    money = {}
    for d, sale, cash, momo, credit, disc, short, over in rows("""
SELECT sh.business_date,
       SUM(mm.amount) FILTER (WHERE mm.entry = 'SALE'),
       -SUM(mm.amount) FILTER (WHERE mm.settlement = 'CASH'),
       -SUM(mm.amount) FILTER (WHERE mm.settlement = 'MOBILE_MONEY'),
       -SUM(mm.amount) FILTER (WHERE mm.settlement = 'CREDIT'),
       -SUM(mm.amount) FILTER (WHERE mm.settlement = 'DISCOUNT'),
       -SUM(mm.amount) FILTER (WHERE mm.settlement = 'SHORTAGE'),
       SUM(mm.amount) FILTER (WHERE mm.settlement = 'OVERAGE')
  FROM shift sh JOIN money_movement mm ON mm.shift_id = sh.id GROUP BY 1"""):
        money[d] = dict(sale=f(sale), cash=f(cash), momo=f(momo), credit=f(credit), disc=f(disc),
                        short=f(short), over=f(over))
    flags = {}
    for d, code, lvl, n in rows("""
SELECT sh.business_date, ef.code, ef.level, count(*) FROM exception_flag ef JOIN shift sh ON sh.id = ef.shift_id
 GROUP BY 1, 2, 3"""):
        flags.setdefault(d, []).append(f"{code}{'!' if lvl == 'CRITICAL' else ''}" + (f"×{n}" if int(n) > 1 else ""))

    out = []
    w = out.append
    w(f"# Kiboga station, {month}: the workbook replayed through FCMS\n")
    w("Every block of the SALES sheet was opened and closed as an FCMS shift, through the real functions, at the "
      "time it happened. FCMS then worked out litres, stock and cash by its own rules. Each table puts FCMS's "
      "figure beside the workbook's; **Δ** is FCMS minus workbook.\n")

    # ---- litres
    w("## 1. Litres sold\n")
    w("PMS and AGO against the wet-stock sheets' Sales column; BIK, which has no wet-stock sheet, against BANKING's litres.\n")
    w("| date | PMS FCMS | PMS sheet | Δ | AGO FCMS | AGO sheet | Δ | BIK FCMS | BIK BANKING | Δ |")
    w("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|")
    tot = {"PMS": [0, 0], "AGO": [0, 0]}
    for d in D:
        cells = [d]
        for p in ("PMS", "AGO"):
            a = sold.get((d, p), 0.0)
            b = (D[d].get("tanks", {}).get(p) or {}).get("sales") or 0.0
            tot[p][0] += a
            tot[p][1] += b
            cells += [fmt(a, 2), fmt(b, 2), ("**" + fmt(a - b, 2) + "**") if abs(a - b) > 0.05 else "0"]
        a = sold.get((d, "BIK"), 0.0)
        bk = D[d].get("money") or {}
        b = (bk.get("litres") or {}).get("BIK")
        tot.setdefault("BIK", [0, 0])
        tot["BIK"][0] += a
        tot["BIK"][1] += b or 0
        cells += [fmt(a, 2), fmt(b, 2) if b is not None else "–",
                  (("**" + fmt(a - b, 2) + "**") if abs(a - b) > 0.05 else "0") if b is not None else "–"]
        w("| " + " | ".join(cells) + " |")
    w("| **month** | " + " | ".join(f"**{fmt(tot[p][0], 2)}** | **{fmt(tot[p][1], 2)}** | **{fmt(tot[p][0] - tot[p][1], 2)}**"
                                       for p in ("PMS", "AGO", "BIK")) + " |\n")

    # ---- variance
    w("## 2. Stock variance (gain + / loss −)\n")
    w("FCMS's figure is its own: closing dip less (opening dip + everything its ledger booked that day). "
      "The workbook's is its column F.\n")
    w("| date | PMS FCMS | PMS sheet | AGO FCMS | AGO sheet | FCMS raised |")
    w("|---|--:|--:|--:|--:|---|")
    vt = {"PMS": [0, 0], "AGO": [0, 0]}
    for d in D:
        cells = [d]
        for p in ("PMS", "AGO"):
            a = var.get((d, p))
            b = (D[d].get("tanks", {}).get(p) or {}).get("variance")
            vt[p][0] += a or 0
            vt[p][1] += b or 0
            cells += [fmt(a, 2) if a is not None else "–", fmt(b, 2) if b is not None else "–"]
        cells.append(", ".join(sorted(flags.get(d, []))))
        w("| " + " | ".join(cells) + " |")
    w(f"| **month** | **{fmt(vt['PMS'][0], 2)}** | **{fmt(vt['PMS'][1], 2)}** | **{fmt(vt['AGO'][0], 2)}** | "
      f"**{fmt(vt['AGO'][1], 2)}** | |\n")

    # ---- money
    w("## 3. Money\n")
    w("| date | sales FCMS | sales sheet | Δ | MoMo | credit | discount | cash due | short FCMS | short sheet |")
    w("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|")
    mt = dict(a=0, b=0, cash=0, short=0, ss=0)
    for d in D:
        m = money.get(d, {})
        bk = D[d].get("money") or {}
        b = (bk.get("sales_value") or 0) + (bk.get("credit_value") or 0) if bk else None
        a = m.get("sale", 0)
        mt["a"] += a
        mt["b"] += b or 0
        mt["cash"] += m.get("cash", 0)
        mt["short"] += m.get("short", 0) - m.get("over", 0)
        ss = (bk.get("short") or 0) if bk else None
        mt["ss"] += ss or 0
        w(f"| {d} | {fmt(a)} | {fmt(b) if b is not None else '–'} | "
          f"{('**' + fmt(a - b) + '**') if b is not None and abs(a - b) > 1 else ('0' if b is not None else '–')} | "
          f"{fmt(m.get('momo', 0))} | {fmt(m.get('credit', 0))} | {fmt(m.get('disc', 0))} | {fmt(m.get('cash', 0))} | "
          f"{fmt(m.get('short', 0) - m.get('over', 0))} | {fmt(ss) if ss is not None else '–'} |")
    w(f"| **month** | **{fmt(mt['a'])}** | **{fmt(mt['b'])}** | **{fmt(mt['a'] - mt['b'])}** | | | | **{fmt(mt['cash'])}** | "
      f"**{fmt(mt['short'])}** | **{fmt(mt['ss'])}** |\n")
    w("*Sales sheet* = BANKING's cash-sales column plus its invoice column. A shortage is positive.\n")

    w("## 4. What the replay had to assume\n")
    for a in rep["assumptions"]:
        w(f"* {a}")
    w("\n## 5. What the workbook says that FCMS would have stopped or flagged\n")
    for x in rep["findings"]:
        w(f"* {x}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
