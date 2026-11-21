#!/usr/bin/env python3
"""
Replay a month of Kiboga station's workbook through FCMS, then reconcile.

    tools/replay/run.sh KIBOGA_STATION_OCTOBER_2026.xlsx 2026-10

Each block of the SALES sheet becomes one FCMS shift, opened and closed through
fn_open_shift / fn_close_shift on the moved clock (see tools/sim/README.md), as
the app role, with the API's own SQL for credit sales, discounts, returns to
tank, deliveries and banking. FCMS then computes litres, book stock,
variances and every cash-up by its own rules, and this script sets those
figures beside the workbook's, day by day.

Where the workbook does not say something FCMS needs, the replay makes the
smallest assumption and lists it in the report: nothing is silently made up.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sim"))
import simulate as sim  # noqa: E402  -- Db, the clock, q()

from simulate import Db, q, r2, KAMPALA  # noqa: E402

T = "a0000000-0000-4000-8000-000000000001"
SITE = "a1000000-0000-4000-8000-000000000001"
PROD = {"PMS": "a2000000-0000-4000-8000-000000000001", "AGO": "a2000000-0000-4000-8000-000000000002",
        "BIK": "a2000000-0000-4000-8000-000000000003"}
TANK = {"PMS": "a3000000-0000-4000-8000-000000000001", "AGO": "a3000000-0000-4000-8000-000000000002",
        "BIK": "a3000000-0000-4000-8000-000000000003"}
NOZ = {c: f"a5000000-0000-4000-8000-0000000000{i:02d}" for i, c in enumerate(
    ["PMS1", "PMS2", "PMS3", "PMS4", "AGO1", "AGO2", "AGO3", "AGO4", "BIK1", "BIK2"], 1)}
MGR, SUP, TEAM = ("a6000000-0000-4000-8000-000000000001", "a6000000-0000-4000-8000-000000000002",
                  "a6000000-0000-4000-8000-000000000003")
# PLACEHOLDER costs: the workbook has none. Margins are not reconciled.
COST = {"PMS": 5800.0, "AGO": 6100.0, "BIK": 4500.0}
BIK_OPENING = 5000.0   # not dipped in the workbook

sim.T = T   # Db.run sets app.tenant_id from simulate.T


def litres(seg, p):
    return sum(n["close"] - n["open"] for k, n in seg["nozzles"].items() if k.startswith(p))


class Replay:
    def __init__(self, db: Db, data: dict):
        self.db, self.data = db, data
        self.days = data["days"]
        self.assumptions: list[str] = []
        self.findings: list[str] = []
        self.rows: list[dict] = []
        self.price = {}
        self.customers: dict[str, str] = {}
        self.slip = 1

    def note(self, s):
        if s not in self.assumptions:
            self.assumptions.append(s)

    def at(self, d: str, hour: float) -> dt.datetime:
        x = dt.date.fromisoformat(d)
        return dt.datetime(x.year, x.month, x.day, tzinfo=KAMPALA) + dt.timedelta(hours=hour)

    # ---- the opening position --------------------------------------------
    def start(self):
        first = next(iter(self.days))
        d0 = self.days[first]
        self.db.at(self.at(first, 5))
        self.price = {p: d0["money"]["price"][p] for p in PROD}
        open_dip = {p: d0["tanks"][p]["open_dip"] for p in ("PMS", "AGO")}
        open_dip["BIK"] = BIK_OPENING
        self.note(f"BIK is never dipped in the workbook: its tank opens at a placeholder {BIK_OPENING:,.0f} L "
                  "and every BIK dip is taken as the book, so BIK shows no variance by construction.")
        self.note("The workbook records no cash drops: the drop check (CASH_HELD_OVER_CAP) is off for this replay.")
        self.note("Costs are placeholders (the workbook carries none): PMS "
                  f"{COST['PMS']:,.0f}, AGO {COST['AGO']:,.0f}, BIK {COST['BIK']:,.0f}. Margins are not reconciled.")
        sql = []
        for p in PROD:
            sql.append(f"""
INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind, litres, signed_litres, unit_cost, occurred_at, recorded_by)
VALUES ({q(T)}, {q(SITE)}, {q(TANK[p])}, {q(PROD[p])}, 'OPENING_BALANCE', {open_dip[p]}, {open_dip[p]}, {COST[p]}, now(), {q(MGR)});
INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from, source, status, authorised_by,
                          no_shift_to_break, executed_at)
VALUES ({q(T)}, {q(SITE)}, {q(PROD[p])}, {self.price[p]}, now(), 'OMC_DIRECTIVE', 'EXECUTED', {q(MGR)}, TRUE, now());""")
        # Seeds run as the database owner, like the station seed.
        self.db.run(MGR, "RESET ROLE;\n" + "\n".join(sql))
        self.totalizer = {k: n["open"] for k, n in d0["segments"][0]["nozzles"].items()}

    # ---- prices -------------------------------------------------------------
    def plan_prices(self, d: str, segs: list) -> list[dict]:
        """The price each block sold at. BANKING gives one price per day --
        a blend on the days the price moved mid-day."""
        m = self.days[d].get("money")
        if not m:
            self.note("Days with no BANKING block (" + ", ".join(
                x for x in self.days if not self.days[x].get("money")) + ") sell at the previous day's price, "
                "with no mobile money, discount or shortage recorded.")
            return [dict(self.price) for _ in segs]
        blended = m["price"]
        if len(segs) == 1:
            return [{p: blended.get(p, self.price[p]) for p in PROD}]
        day_p, night_p = dict(self.price), {}
        for p in PROD:
            ld, ln = litres(segs[0], p), litres(segs[1], p)
            b = blended.get(p, self.price[p])
            if ln > 0 and abs(b - self.price[p]) > 0.5:
                raw = (b * (ld + ln) - self.price[p] * ld) / ln
                night_p[p] = round(raw / 10) * 10
                if abs(raw - night_p[p]) > 2:
                    self.findings.append(f"{d} {p}: the night price solved from BANKING's blended {b:,.2f} is "
                                         f"{raw:,.2f}, not a round figure; replayed at {night_p[p]:,.0f}.")
            else:
                night_p[p] = self.price[p]
        return [day_p, night_p]

    # ---- one block -----------------------------------------------------------
    def block(self, d: str, i: int, seg: dict, price: dict, last: bool):
        db = self.db
        span = {"BOTH": (6, 30), "DAY": (6, 18), "NIGHT": (18, 30)}[seg["shift"]]
        label = "NIGHT" if seg["shift"] == "NIGHT" else "DAY"
        # Two minutes after the previous close: the clock never runs backwards.
        t_open = self.at(d, span[0]) + dt.timedelta(minutes=2)

        # A price that differs from what the pumps sell at falls due at this open (560).
        changes = [p for p in PROD if abs(price[p] - self.price[p]) > 0.004]
        if changes:
            db.at(t_open - dt.timedelta(minutes=30))
            db.run(MGR, "\n".join(f"""
INSERT INTO price_change (tenant_id, site_id, product_id, old_price, new_price, effective_from, source,
                          directive_ref, document_url, status, authorised_by)
VALUES ({q(T)}, {q(SITE)}, {q(PROD[p])}, {self.price[p]}, {price[p]}, {q(t_open.isoformat())}, 'OMC_DIRECTIVE',
        {q('Workbook ' + d)}, NULL, 'PENDING', {q(MGR)});""" for p in changes))
            for p in changes:
                self.price[p] = price[p]

        # Open: dips as the workbook gives them (BIK: the book).
        db.at(t_open)
        book = {p: float(db.one(SUP, f"SELECT fn_book_stock({q(TANK[p])});")) for p in PROD}
        tanks = self.days[d].get("tanks", {})
        dips = []
        for p in PROD:
            v = tanks.get(p, {}).get("open_dip") if (i == 0 and p != "BIK") else None
            dips.append({"tank_id": TANK[p], "product_litres": round(v if v is not None else book[p], 2), "water_litres": 0})
        roster = [{"nozzle_id": NOZ[k], "attendant_id": TEAM, "volume_totalizer": self.totalizer[k]} for k in NOZ]
        shift_id = db.one(SUP, f"SELECT fn_open_shift({q(SITE)}, {q(label)}, {q(SUP)}, {q(json.dumps(dips))}::jsonb, "
                               f"{q(json.dumps(roster))}::jsonb, NULL, NULL);")
        rows = db.run(SUP, f"SELECT n.code, na.id FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id "
                           f"WHERE na.shift_id = {q(shift_id)};")
        assign = dict((r[0], r[1]) for r in rows)
        sp = {p: float(db.one(SUP, f"SELECT fn_shift_price({q(shift_id)}, {q(PROD[p])});")) for p in PROD}

        credit_total = discount_total = 0.0
        m = self.days[d].get("money") if last else None

        # Deliveries the wet-stock sheet records on this day, in the first block.
        # The workbook does not say WHEN; receive each at the earliest moment
        # it fits the tank, given the block's sales so far, and say so.
        if i == 0:
            hours = span[1] - span[0]
            for p in ("PMS", "AGO"):
                got = tanks.get(p, {}).get("delivered") or 0.0
                if got:
                    rate = (litres(seg, p) - seg.get("rtt", {}).get(p, 0.0)) / hours
                    room = 30000 - 50 - float(db.one(SUP, f"SELECT fn_book_stock({q(TANK[p])});"))
                    rec = next((x for x in self.data["deliveries"] if x["date"] == d and x["product"] == p), None)
                    need = (rec["received"] if rec else got) - room
                    h = 2.0 if need <= 0 else (need / rate + 0.25 if rate > 0 else hours + 1)
                    if h >= hours:
                        self.findings.append(f"{d} {p}: {got:,.0f} L received cannot fit the 30,000 L tank at any "
                                             f"time that day -- the dips, the sales or the delivery are wrong.")
                        h = hours - 0.5
                    elif need > 0:
                        self.note("Deliveries are received at the earliest time they fit the tank (the workbook gives "
                                  "no times); the dip before is the opening dip less the day's sales so far.")
                    self.delivery(d, p, got, shift_id, t_open + dt.timedelta(hours=h), sold_before=rate * h)

        # Credit invoices dated this day go on its last block.
        if last:
            for inv in [x for x in self.data["invoices"] if x["date"] == d]:
                c, dsc = self.credit(d, inv, shift_id, sp, t_open + dt.timedelta(hours=4))
                credit_total += c
                discount_total += dsc

        # Returns to tank, against the busiest nozzle of the grade.
        for p in PROD:
            rtt = seg.get("rtt", {}).get(p, 0.0)
            if rtt > 0:
                k = max((k for k in seg["nozzles"] if k.startswith(p)),
                        key=lambda k: seg["nozzles"][k]["close"] - seg["nozzles"][k]["open"])
                db.at(t_open + dt.timedelta(hours=5))
                db.run(SUP, f"""
INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres, reason, recorded_by, witnessed_by)
SELECT s.tenant_id, s.site_id, s.id, {q(NOZ[k])}, {rtt}, 'Returned to tank (workbook RTT row)', {q(SUP)}, NULL
  FROM shift s WHERE s.id = {q(shift_id)};""")

        # BANKING's discount column, as an authorised discount.
        if m and m.get("discount"):
            db.at(t_open + dt.timedelta(hours=6))
            db.run(SUP, f"""
INSERT INTO discount_grant (tenant_id, site_id, shift_id, staff_id, customer_ref, litres, amount, reason, authorised_by)
VALUES ({q(T)}, {q(SITE)}, {q(shift_id)}, {q(TEAM)}, 'Various', NULL, {r2(m['discount'])},
        'Daily discounts (workbook BANKING)', {q(MGR)});""")
            discount_total += r2(m["discount"])

        # Close: meters, dips and the station's one cash-up.
        t_close = self.at(d, span[1])
        db.at(t_close)
        readings = []
        for k in NOZ:
            n = seg["nozzles"].get(k)
            close = n["close"] if n else self.totalizer[k]
            readings.append({"assignment_id": assign[k], "volume_totalizer": close, "is_rollover": False})
            self.totalizer[k] = close
        rtt = {p: seg.get("rtt", {}).get(p, 0.0) for p in PROD}
        sold = {p: litres(seg, p) for p in PROD}
        book_now = {p: float(db.one(SUP, f"SELECT fn_book_stock({q(TANK[p])});")) for p in PROD}
        close_dips = []
        for p in PROD:
            v = tanks.get(p, {}).get("close_dip") if (last and p != "BIK") else None
            if v is None:
                v = book_now[p] - sold[p] + rtt[p]
                if p != "BIK" and last:
                    self.findings.append(f"{d} {p}: no closing dip in the workbook; closed at the book, so no variance shows.")
            close_dips.append({"tank_id": TANK[p], "product_litres": round(v, 2), "water_litres": 0})

        owed = sum(r2((sold[p] - rtt[p]) * sp[p]) for p in PROD)
        tenders = []
        momo = short = 0.0
        if m:
            for code, key in (("MTN_MOMO", "mtn"), ("AIRTEL", "airtel")):
                if m.get(key):
                    tenders.append({"channel_code": code, "amount": r2(m[key]), "reference": f"{d} workbook"})
                    momo += r2(m[key])
            short = m.get("short") or 0.0
        # BANKING's SHORT is cash MISSING: its expected cash is sales less
        # mobile money, discount AND short, and that is what was banked
        # (26 Oct: 631,441.40 short, 18,779,100 expected, 18,779,000 banked).
        cash = r2(owed - credit_total - discount_total - momo - short)
        cashup = {"attendant_id": TEAM, "cash": max(cash, 0.0), "tenders": tenders}
        if short > 0:
            cashup["shortage_reason"] = "SHORT column of the workbook's BANKING sheet"
        res = json.loads(db.one(SUP, f"SELECT fn_close_shift({q(shift_id)}, {q(SUP)}, 'SCHEDULED', "
                                     f"{q(json.dumps(readings))}::jsonb, {q(json.dumps(close_dips))}::jsonb, "
                                     f"{q(json.dumps([cashup]))}::jsonb)::text;"))
        db.at(t_close + dt.timedelta(minutes=1))
        db.run(MGR, f"UPDATE shift SET state = 'APPROVED', approved_by = {q(MGR)}, approved_at = now() "
                    f"WHERE id = {q(shift_id)} AND state = 'DECLARED';")
        self.rows.append({"date": d, "shift": seg["shift"], "shift_id": shift_id, "cash_declared": cash,
                          "sheet_short": short if m else None})
        return res

    def delivery(self, d, p, qty, shift_id, when, sold_before=0.0):
        db = self.db
        rec = next((x for x in self.data["deliveries"] if x["date"] == d and x["product"] == p), None)
        loaded = rec["loaded"] if rec else qty
        received = rec["received"] if rec else qty
        if not rec:
            self.note("Receipts on the wet-stock sheets that RECIEVED does not list are taken as depot transfers "
                      "received exactly as loaded (round figures: 7,000, 10,000, 13,000 ...).")
        if abs(loaded - qty) > 0.01:
            self.findings.append(f"{d} {p}: wet-stock sheet books {qty:,.2f} L, RECIEVED says loaded {loaded:,.2f}.")
        db.at(when)
        dn = f"KIB-{d}-{p}"
        did = db.one(SUP, f"""
INSERT INTO delivery (tenant_id, site_id, supplier_id, delivery_note_no, invoice_no, depot, transporter, truck_reg,
                      driver_name, seal_numbers, status, arrived_at)
SELECT {q(T)}, {q(SITE)}, s.id, {q(dn)}, NULL, 'Kiboga depot', NULL, {q(rec['truck'] if rec else None)}, NULL, NULL,
       'ARRIVED', now() FROM supplier s WHERE s.tenant_id = {q(T)} LIMIT 1 RETURNING id;""")
        before = round(float(db.one(SUP, f"SELECT fn_book_stock({q(TANK[p])});")) - sold_before, 2)
        db.run(SUP, f"""
INSERT INTO delivery_line (tenant_id, delivery_id, tank_id, product_id, loaded_litres, unit_cost)
VALUES ({q(T)}, {q(did)}, {q(TANK[p])}, {q(PROD[p])}, {loaded}, {COST[p]});
INSERT INTO dip_reading (tenant_id, site_id, tank_id, context, dip_mm, water_dip_mm, gross_litres, water_litres,
                         product_litres, evidence, recorded_by, captured_at)
VALUES ({q(T)}, {q(SITE)}, {q(TANK[p])}, 'PRE_DELIVERY', NULL, 0, {before}, 0, {before}, 'PENDING', {q(SUP)}, now()),
       ({q(T)}, {q(SITE)}, {q(TANK[p])}, 'POST_DELIVERY', NULL, 0, {before + received}, 0, {before + received}, 'PENDING', {q(SUP)}, now());
UPDATE delivery_line SET
  dip_before_id = (SELECT id FROM dip_reading WHERE tank_id = {q(TANK[p])} AND context = 'PRE_DELIVERY' ORDER BY id DESC LIMIT 1),
  dip_after_id  = (SELECT id FROM dip_reading WHERE tank_id = {q(TANK[p])} AND context = 'POST_DELIVERY' ORDER BY id DESC LIMIT 1),
  received_litres = {received}, rejected_litres = 0, rejection_reason = NULL
 WHERE delivery_id = {q(did)};
UPDATE delivery SET seals_intact = TRUE, seal_photo_url = NULL, decant_ended_at = now(), status = 'DECANTING' WHERE id = {q(did)};
SELECT fn_receive_delivery({q(did)}, {q(shift_id)}, {q(SUP)})::text;""")
        self.note("A delivery's dip before is the book at that moment; the workbook dips only at day end.")

    def credit(self, d, inv, shift_id, sp, when):
        """A credit invoice. Where it is not at the pump price, the customer has
        an agreed price (600): the manager agrees it as a fixed price, and the
        sale is billed under it -- as FCMS would have run October."""
        db = self.db
        p = min(("PMS", "AGO"), key=lambda x: abs(inv["price"] - sp[x]))
        name = inv["customer"] or "UNNAMED ON INVOICE"
        if not inv["customer"]:
            self.findings.append(f"{d}: an invoice of {inv['litres']:,.0f} L at {inv['price']:,.0f} names no customer.")
        if name not in self.customers:
            code = f"C{len(self.customers) + 1:02d}"
            self.customers[name] = self.db.one(MGR, f"""
INSERT INTO credit_customer (tenant_id, site_id, code, name, credit_limit, payment_terms_days)
VALUES ({q(T)}, {q(SITE)}, {q(code)}, {q(name)}, 100000000, 30) RETURNING id;""")
        cust = self.customers[name]
        db.at(when)
        agreed = db.run(SUP, f"SELECT customer_price_id, price FROM fn_customer_price({q(cust)}, {q(PROD[p])}, {sp[p]}, now());")
        current = float(agreed[0][1]) if agreed and agreed[0][0] else sp[p]
        if abs(inv["price"] - current) > 0.004:
            if abs(inv["price"] - sp[p]) > 0.004:
                db.run(MGR, f"""
UPDATE customer_price SET valid_to = now(), ended_by = {q(MGR)}
 WHERE customer_id = {q(cust)} AND product_id = {q(PROD[p])} AND valid_to IS NULL;
INSERT INTO customer_price (tenant_id, customer_id, product_id, price, reason, authorised_by)
VALUES ({q(T)}, {q(cust)}, {q(PROD[p])}, {inv['price']}, {q('As invoiced ' + d)}, {q(MGR)});""")
                self.findings.append(f"{d}: {name} is invoiced {p} at {inv['price']:,.0f} against a pump price of "
                                     f"{sp[p]:,.0f}. FCMS needs that as an agreed price set by a manager; the replay "
                                     f"agreed it then. The {abs(inv['price'] - sp[p]) * inv['litres']:,.0f} difference "
                                     f"settles on the attendant's cash-up as an agreed-price line.")
            else:
                db.run(MGR, f"UPDATE customer_price SET valid_to = now(), ended_by = {q(MGR)} "
                            f"WHERE customer_id = {q(cust)} AND product_id = {q(PROD[p])} AND valid_to IS NULL;")
            db.at(when + dt.timedelta(seconds=5))
        row = db.run(SUP, f"SELECT customer_price_id, price FROM fn_customer_price({q(cust)}, {q(PROD[p])}, {sp[p]}, now());")
        cp_id, unit = (row[0][0], float(row[0][1])) if row and row[0][0] else (None, sp[p])
        db.run(SUP, f"""
INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, vehicle_id, staff_id, attendant_id, nozzle_id,
                         product_id, litres, unit_price, amount, voucher_no, odometer, signed_by, evidence_url,
                         customer_price_id)
VALUES ({q(T)}, {q(SITE)}, {q(shift_id)}, {q(cust)}, NULL, {q(SUP)}, {q(TEAM)}, {q(NOZ[p + "1"])},
        {q(PROD[p])}, {inv['litres']}, {unit}, {r2(inv['litres'] * unit)}, {q(inv['vehicle'])}, NULL, NULL, NULL,
        {q(cp_id)});""")
        # What the attendant answers for: the pump value, whatever the customer pays.
        return r2(inv["litres"] * sp[p]), 0.0

    def run(self):
        self.start()
        for d, day in self.days.items():
            segs = day.get("segments", [])
            if not segs:
                self.findings.append(f"{d}: no SALES block; the day is not replayed.")
                continue
            prices = self.plan_prices(d, segs)
            for i, (seg, price) in enumerate(zip(segs, prices)):
                # Return-to-tank sits on its own row per grade; the extract puts it on the block.
                self.block(d, i, seg, price, last=(i == len(segs) - 1))
            print(f"  {d}  {'/'.join(s['shift'] for s in segs):9s}  ({self.db.calls} calls)", flush=True)


def main():
    data = json.load(open(sys.argv[1]))
    port = os.environ.get("SIM_PORT", "5546")
    db = Db(os.environ["SIMCLOCK_FILE"], os.environ.get("REPLAY_DB", "fcms_replay"), port)
    r = Replay(db, data)
    try:
        r.run()
    finally:
        json.dump({"assumptions": r.assumptions, "findings": r.findings, "rows": r.rows},
                  open(sys.argv[2], "w"), indent=1)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
