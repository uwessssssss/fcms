#!/usr/bin/env python3
"""
FCMS simulator -- months of trading at the demo station, through the REAL
database functions and the API's own SQL, on a movable clock.

Run it through tools/sim/run.sh, which starts a throwaway PostgreSQL server
with simclock.so preloaded. Before every action this script moves that
server's clock to the simulated moment, so now(), every column default and
every rule (meter plausibility, drops only while open, approval after close)
sees the time the action "happened". Nothing is backdated afterwards.

Each action runs as the app role (fcms_app) with app.tenant_id and
app.staff_id set, exactly as the API runs: row-level security, the station
scope, grants and triggers all apply. Where the API calls a function
(fn_open_shift, fn_close_shift, fn_record_cash_drop, fn_receive_delivery) so
does this; where the API runs an INSERT, this runs the same INSERT, column for
column (see the comments naming each service).

What a simulated day holds, deliberately imperfect:
  * DAY 06:00-18:00 and NIGHT 18:00-06:00, two attendants a shift, rotating
  * hourly sales on every nozzle, busier by day and at the weekend
  * cash dropped to the safe as it builds up, witnessed by the supervisor;
    now and then an attendant skips the last drop (CASH_HELD_OVER_CAP)
  * mobile money and card tenders; credit sales to the two station accounts
  * a morning pump test, returned to the tank
  * shop sales while stock lasts; a weekly restock
  * deliveries when a tank runs low, with a small transit loss
  * price changes every ~12 days, applied when the next shift opens (560)
  * dip noise on every close; now and then a real loss of fuel
  * now and then an attendant comes up short
  * the manager approves each shift the morning after, banks the takings,
    pays the bills; customers settle their accounts weekly
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import struct
import subprocess
import sys
import time
import uuid
from zoneinfo import ZoneInfo

KAMPALA = ZoneInfo("Africa/Kampala")
T = "0a000000-0000-4000-8000-000000000001"
SITE = "0b000000-0000-4000-8000-000000000001"
MGR = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000005"]
SUP = {"DAY": "10000000-0000-4000-8000-000000000002", "NIGHT": "10000000-0000-4000-8000-000000000003"}
ATT = ["10000000-0000-4000-8000-000000000010", "10000000-0000-4000-8000-000000000011",
       "10000000-0000-4000-8000-000000000012", "10000000-0000-4000-8000-000000000013"]
NAMES = {ATT[0]: "Moses", ATT[1]: "Peter", ATT[2]: "Alice", ATT[3]: "John"}
TANKS = {"PMS": "0d000000-0000-4000-8000-000000000001", "AGO": "0d000000-0000-4000-8000-000000000002"}
PRODUCTS = {"PMS": "0c000000-0000-4000-8000-000000000001", "AGO": "0c000000-0000-4000-8000-000000000002"}
NOZZLES = {f"N{i}": f"0f000000-0000-4000-8000-00000000000{i}" for i in range(1, 10)}
NOZZLE_PRODUCT = {n: ("PMS" if int(n[1:]) % 2 else "AGO") for n in NOZZLES}
CUSTOMERS = ["12000000-0000-4000-8000-000000000001", "12000000-0000-4000-8000-000000000002"]
SUPPLIERS: list[str] = []   # the seed gives suppliers fresh ids; read at start

# Litres a day across the station, before day-of-week and random swing.
# Kiboga's station sold about 2,100 L a day in August 2026 (director reports).
DAILY_LITRES = {"PMS": 1300.0, "AGO": 850.0}
HOURLY_SHAPE = [0.2, 0.15, 0.1, 0.1, 0.2, 0.5, 0.9, 1.3, 1.4, 1.3, 1.2, 1.2,
                1.3, 1.2, 1.1, 1.2, 1.4, 1.5, 1.3, 1.0, 0.8, 0.6, 0.4, 0.3]
SHOP_ITEMS = [  # sku-level ids from one_station.sql; weight, typical qty
    ("11000000-0000-4000-8000-000000000020", 6, 3), ("11000000-0000-4000-8000-000000000021", 4, 2),
    ("11000000-0000-4000-8000-000000000002", 3, 1), ("11000000-0000-4000-8000-000000000001", 1, 1),
    ("11000000-0000-4000-8000-000000000004", 1, 1), ("11000000-0000-4000-8000-000000000012", 1, 1),
]


class Db:
    """psql, one transaction per call, as the app role on the moved clock."""

    def __init__(self, clock_file: str, dbname: str, port: str):
        self.clock_file, self.dbname, self.port = clock_file, dbname, port
        self.calls = 0

    def at(self, when: dt.datetime) -> None:
        offset_us = int(when.timestamp() * 1e6 - time.time() * 1e6)
        with open(self.clock_file, "r+b") as f:
            f.write(struct.pack("<q", offset_us))

    def run(self, staff: str, sql: str) -> list[list[str]]:
        script = (
            "\\set ON_ERROR_STOP 1\nBEGIN;\nSET LOCAL ROLE fcms_app;\n"
            f"SELECT set_config('app.tenant_id', '{T}', true), set_config('app.staff_id', '{staff}', true) \\g /dev/null\n"
            f"{sql}\nCOMMIT;\n"
        )
        p = subprocess.run(
            ["psql", "-X", "-q", "-At", "-F", "\t", "-h", "localhost", "-p", self.port, "-U", "postgres",
             "-d", self.dbname, "-f", "-"],
            input=script, capture_output=True, text=True)
        self.calls += 1
        if p.returncode != 0:
            raise RuntimeError(f"SQL failed:\n{p.stderr.strip()}\n--- script ---\n{sql[:3000]}")
        return [line.split("\t") for line in p.stdout.splitlines() if line.strip()]

    def one(self, staff: str, sql: str) -> str:
        rows = self.run(staff, sql)
        return rows[-1][0] if rows else ""


def q(v) -> str:
    """A SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(round(v, 3)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


def r2(x: float) -> float:
    """Round half away from zero to cents, like PostgreSQL's round(numeric, 2)."""
    return math.floor(abs(x) * 100 + 0.5) / 100 * (1 if x >= 0 else -1)


class Sim:
    def __init__(self, db: Db, start: dt.date, days: int, seed: int):
        self.db, self.start, self.days = db, start, days
        self.rng = random.Random(seed)
        self.tot = {}           # nozzle -> totalizer
        self.physical = {}      # product -> litres actually in the tank
        self.drop_book = 1
        self.receipt = 1
        self.dn = 1
        self.slip = 1
        self.stats = {k: 0 for k in ("shifts", "drops", "credit_sales", "shop_sales", "deliveries",
                                     "price_changes", "shortages", "losses", "over_cap", "pump_tests",
                                     "bankings", "payments", "expenses", "restocks",
                                     "agreed_price_sales", "supplier_invoices", "supplier_payments",
                                     "withdrawals", "statement_lines", "bank_charges")}
        self.pending_delivery: dict[str, float] = {}
        self.to_invoice: list[tuple] = []   # (delivery_id, supplier, amount, note no)
        self.to_pay: list[tuple] = []       # (invoice_id, supplier, amount, due date)
        self.next_price_day = 9
        # Statements as the bank and the networks would issue them (630).
        self.bank_lines: list[tuple] = []                       # (date, amount, text, ref)
        self.momo_lines: dict[str, list] = {"MTN_MOMO": [], "AIRTEL": []}   # (at, amount, text, ref)
        self.accounts: dict[str, str] = {}
        self.short_banked = False

    # ---- helpers -----------------------------------------------------------
    def local(self, d: dt.date, hour: float) -> dt.datetime:
        base = dt.datetime(d.year, d.month, d.day, tzinfo=KAMPALA)
        return base + dt.timedelta(hours=hour)

    def book(self, product: str) -> float:
        return float(self.db.one(SUP["DAY"], f"SELECT round(fn_book_stock({q(TANKS[product])}), 3);"))

    def load_start(self, when: dt.datetime) -> None:
        self.db.at(when)
        for n, nid in NOZZLES.items():
            v = self.db.one(SUP["DAY"], f"SELECT COALESCE(max(volume_totalizer), 0) FROM meter_reading WHERE nozzle_id = {q(nid)};")
            self.tot[n] = float(v) if float(v) > 0 else float(self.rng.randint(150_000, 600_000))
        for p in TANKS:
            self.physical[p] = self.book(p)
        SUPPLIERS[:] = [r[0] for r in self.db.run(SUP["DAY"], "SELECT id FROM supplier ORDER BY name;")]
        # The money accounts (630): the collections account, and a wallet per network.
        self.accounts["BANK"] = self.db.one(MGR[0], f"""
INSERT INTO money_account (tenant_id, site_id, kind, name, institution, account_ref, is_default)
VALUES ({q(T)}, {q(SITE)}, 'BANK', 'Stanbic Kiboga collections', 'Stanbic Bank', 'Kiboga collections', TRUE) RETURNING id;""")
        for ch, net in (("MTN_MOMO", "MTN"), ("AIRTEL", "Airtel")):
            self.accounts[ch] = self.db.one(MGR[0], f"""
INSERT INTO money_account (tenant_id, site_id, kind, name, institution, channel_id)
SELECT {q(T)}, {q(SITE)}, 'MOBILE_MONEY', {q(net + ' merchant wallet')}, {q(net)}, pc.id
  FROM payment_channel pc WHERE pc.site_id = {q(SITE)} AND pc.code = {q(ch)} RETURNING id;""")
        # What the seed already put in the bank is on the statement too.
        for d0, amt, memo in self.db.run(MGR[0], f"SELECT on_date, amount, memo FROM fn_money_account_book({q(self.accounts['BANK'])});"):
            self.bank_lines.append((dt.date.fromisoformat(d0), float(amt), memo or 'Opening', ''))
        if not SUPPLIERS:
            raise RuntimeError("no suppliers in the seed")
        # Agreed prices (600): the transporter on credit terms of pump + 80,
        # the farm on a fixed diesel price that the pump will drift away from.
        start_ago = float(self.db.one(MGR[0], f"""SELECT new_price FROM price_change
            WHERE product_id = {q(PRODUCTS['AGO'])} AND status = 'EXECUTED' ORDER BY effective_from DESC LIMIT 1;"""))
        self.db.run(MGR[0], f"""
INSERT INTO customer_price (tenant_id, customer_id, product_id, margin, reason, authorised_by)
VALUES ({q(T)}, {q(CUSTOMERS[1])}, {q(PRODUCTS['AGO'])}, 80, 'Credit terms: pump + 80, 30 days', {q(MGR[0])});
INSERT INTO customer_price (tenant_id, customer_id, product_id, price, reason, authorised_by)
VALUES ({q(T)}, {q(CUSTOMERS[0])}, {q(PRODUCTS['AGO'])}, {start_ago - 100}, 'Season contract, fixed', {q(MGR[0])});""")

    # ---- the day -------------------------------------------------------------
    def run(self) -> None:
        self.load_start(self.local(self.start, 5))
        for i in range(self.days):
            d = self.start + dt.timedelta(days=i)
            if i == self.next_price_day:
                self.price_change(d)
                self.next_price_day += self.rng.randint(9, 15)
            if i > 0:
                self.morning_office(d)
            for label, open_h in (("DAY", 6.0), ("NIGHT", 18.0)):
                self.shift(d, i, label, open_h)
            print(f"  {d}  shifts {self.stats['shifts']:4d}  PMS {self.physical['PMS']:8.0f} L  "
                  f"AGO {self.physical['AGO']:8.0f} L  ({self.db.calls} calls)", flush=True)

    def price_change(self, d: dt.date) -> None:
        """A manager schedules new pump prices the evening before (OperationsService)."""
        self.db.at(self.local(d, -8))  # 16:00 the day before
        mgr = MGR[0]
        sql = []
        for p in ("PMS", "AGO"):
            delta = self.rng.choice([-1, 1, 1]) * self.rng.randint(2, 8) * 10
            sql.append(f"""
INSERT INTO price_change (tenant_id, site_id, product_id, old_price, new_price, effective_from,
                          source, directive_ref, document_url, status, authorised_by)
SELECT {q(T)}, {q(SITE)}, {q(PRODUCTS[p])},
       (SELECT new_price FROM price_change WHERE site_id = {q(SITE)} AND product_id = {q(PRODUCTS[p])}
           AND status = 'EXECUTED' ORDER BY effective_from DESC LIMIT 1),
       (SELECT new_price FROM price_change WHERE site_id = {q(SITE)} AND product_id = {q(PRODUCTS[p])}
           AND status = 'EXECUTED' ORDER BY effective_from DESC LIMIT 1) + {delta},
       {q(self.local(d, 5).isoformat())}, 'OMC_DIRECTIVE', {q(f'OMC price notice {d:%d %b}')}, NULL, 'PENDING', {q(mgr)};""")
        self.db.run(mgr, "\n".join(sql))
        self.stats["price_changes"] += 1

    def morning_office(self, d: dt.date) -> None:
        """Bank yesterday's cash, pay bills, take customer payments, restock the shop."""
        y = d - dt.timedelta(days=1)
        mgr = MGR[d.toordinal() % 2]
        self.db.at(self.local(d, 9.5))
        cash = float(self.db.one(mgr, f"""
SELECT COALESCE(-SUM(mm.amount), 0) FROM money_movement mm JOIN shift sh ON sh.id = mm.shift_id
 WHERE sh.site_id = {q(SITE)} AND sh.business_date = {q(str(y))} AND mm.settlement = 'CASH';"""))
        till_paid = 0.0
        # Small cash bills come out of the till before banking.
        if self.rng.random() < 0.35:
            till_paid = float(self.rng.choice([15000, 20000, 35000, 50000]))
            self.expense(mgr, y, "CONSUMABLES", "Cleaning materials and toilet paper", till_paid, "TILL_CASH")
        if y.weekday() == 0:
            self.expense(mgr, y, "POWER", "UMEME token, forecourt and office", 180000, "BANK")
        if y.day == 1:
            self.expense(mgr, y, "SECURITY", "Night guard services, monthly", 600000, "BANK")
            self.expense(mgr, y, "RENT", "Plot rent, monthly", 1500000, "BANK")
        if y.day == 28:
            self.expense(mgr, y, "WAGES", "Forecourt wages, monthly", 4200000, "BANK")
        if self.rng.random() < 0.08:
            self.expense(mgr, y, "REPAIRS", "Nozzle hose and swivel replaced", float(self.rng.choice([85000, 120000, 240000])), "BANK")
        to_bank = round(cash - till_paid, 2)
        if to_bank > 0:
            # OperationsService.RecordBankingAsync
            self.db.run(mgr, f"""
INSERT INTO banking (tenant_id, site_id, business_date, amount, currency, bank_name,
                     account_ref, slip_no, slip_url, banked_by)
SELECT {q(T)}, {q(SITE)}, {q(str(y))}, {to_bank}, t.base_currency, 'Stanbic Bank', 'Kiboga collections',
       {q(f'DS-{self.slip:05d}')}, NULL, {q(mgr)} FROM tenant t WHERE t.id = {q(T)};""")
            # Most deposits show the same day; some the next. Once, halfway,
            # the bank credits 50,000 less than the slip says (planted).
            credited = to_bank
            if not self.short_banked and d >= self.start + dt.timedelta(days=self.days // 2):
                credited, self.short_banked = to_bank - 50000, True
            self.bank_lines.append((d + dt.timedelta(days=self.rng.choice([0, 0, 0, 1])), credited,
                                    'CASH DEPOSIT KIBOGA', f'DS-{self.slip:05d}'))
            self.slip += 1
            self.stats["bankings"] += 1
        # Customers settle on Tuesdays and Fridays (CreditService.RecordPaymentAsync).
        if d.weekday() in (1, 4):
            for c in CUSTOMERS:
                bal = float(self.db.one(mgr, f"SELECT balance FROM fn_customer_headroom({q(c)});"))
                if bal > 0:
                    amt = round(bal * self.rng.choice([1.0, 1.0, 0.8, 0.6]), -3)
                    if amt > 0:
                        self.db.run(mgr, f"""
INSERT INTO credit_payment (tenant_id, customer_id, amount, method, reference, evidence_url, received_by)
VALUES ({q(T)}, {q(c)}, {amt}, 'BANK', {q(f'EFT {d:%Y%m%d}')}, NULL, {q(mgr)});""")
                        self.bank_lines.append((d, amt, 'INWARD EFT CUSTOMER', f'EFT {d:%Y%m%d}'))
                        self.stats["payments"] += 1
        # Supplier invoices for yesterday's deliveries; payments as they fall
        # due (AccountsService.RecordSupplierInvoiceAsync / RecordSupplierPaymentAsync).
        for delivery_id, supplier, amount, dn in self.to_invoice:
            inv = self.db.one(mgr, f"""
INSERT INTO supplier_invoice (tenant_id, site_id, supplier_id, invoice_no, invoice_date, due_date, amount, currency,
                              notes, recorded_by)
SELECT {q(T)}, {q(SITE)}, {q(supplier)}, {q('INV-' + dn[3:])}, {q(str(y))}, {q(str(y + dt.timedelta(days=14)))},
       {amount}, t.base_currency, NULL, {q(mgr)} FROM tenant t WHERE t.id = {q(T)} RETURNING id;""")
            self.db.run(mgr, f"INSERT INTO supplier_invoice_delivery (invoice_id, delivery_id) VALUES ({q(inv)}, {q(delivery_id)});")
            self.to_pay.append((inv, supplier, amount, y + dt.timedelta(days=14)))
            self.stats["supplier_invoices"] += 1
        self.to_invoice.clear()
        for item in [x for x in self.to_pay if x[3] <= d]:
            inv, supplier, amount, due = item
            self.db.run(mgr, f"""
INSERT INTO supplier_payment (tenant_id, site_id, supplier_id, invoice_id, amount, currency, method, reference,
                              paid_on, recorded_by)
SELECT {q(T)}, {q(SITE)}, {q(supplier)}, {q(inv)}, {amount}, t.base_currency, 'BANK', {q('EFT ' + str(d))},
       {q(str(d))}, {q(mgr)} FROM tenant t WHERE t.id = {q(T)};""")
            self.bank_lines.append((d, -amount, 'OUTWARD EFT SUPPLIER', 'EFT ' + str(d)))
            self.to_pay.remove(item)
            self.stats["supplier_payments"] += 1

        # Mondays: the MoMo wallets are emptied to the bank, less a float, with
        # the network's fee (MoneyAccountService.TransferAsync).
        if d.weekday() == 0:
            for ch in ("MTN_MOMO", "AIRTEL"):
                bal = float(self.db.one(mgr, f"SELECT COALESCE(SUM(amount), 0) FROM fn_money_account_book({q(self.accounts[ch])});"))
                amount = math.floor((bal - 200_000) / 100_000) * 100_000
                if amount > 0:
                    fee = float(min(round(amount * 0.005, -2), 15000))
                    at = self.local(d, 10.5)
                    self.db.at(at)
                    self.db.run(mgr, f"""
INSERT INTO money_transfer (tenant_id, site_id, from_account, to_account, amount, fee, reference, transferred_at, recorded_by)
VALUES ({q(T)}, {q(SITE)}, {q(self.accounts[ch])}, {q(self.accounts['BANK'])}, {amount}, {fee},
        {q(f'WD {ch} {d:%Y%m%d}')}, now(), {q(mgr)});""")
                    self.momo_lines[ch].append((at, -(amount + fee), 'WITHDRAWAL TO BANK', f'WD {ch} {d:%Y%m%d}'))
                    self.bank_lines.append((d, amount, 'MOMO SETTLEMENT ' + ch, f'WD {ch} {d:%Y%m%d}'))
                    self.stats["withdrawals"] += 1
                    self.db.at(self.local(d, 9.5))
        # The bank's monthly fee, which only the statement knows about.
        if (d + dt.timedelta(days=1)).day == 1:
            self.bank_lines.append((d, -25000.0, 'MONTHLY LEDGER FEE', ''))
        # A standing order nobody recorded (planted, once).
        if d == self.start + dt.timedelta(days=self.days // 3):
            self.bank_lines.append((d, -180000.0, 'STANDING ORDER 0042', 'SO0042'))

        # Weekly shop restock (DryStockService.ReceiveAsync).
        if d.weekday() == 1:
            sql = []
            for item, _, _ in SHOP_ITEMS:
                sql.append(f"""
INSERT INTO dry_movement (tenant_id, site_id, item_id, kind, qty, signed_qty, unit_cost, note, recorded_by)
SELECT {q(T)}, {q(SITE)}, {q(item)}, 'PURCHASE_IN', n, n, round(fn_dry_price({q(SITE)}, {q(item)}) * 0.8, 2),
       'Weekly restock', {q(mgr)}
  FROM (SELECT GREATEST(0, CASE WHEN fn_dry_price({q(SITE)}, {q(item)}) > 50000 THEN 10 ELSE 60 END
                         - fn_dry_on_hand({q(item)}, {q(SITE)}))::int AS n) x WHERE n > 0;""")
            self.db.run(SUP["DAY"], "\n".join(sql))
            self.stats["restocks"] += 1

    def expense(self, who: str, d: dt.date, cat: str, desc: str, amount: float, paid_from: str) -> None:
        # AccountsService.RecordExpenseAsync
        self.db.run(who, f"""
INSERT INTO expense (tenant_id, site_id, business_date, category, description, amount, currency,
                     paid_from, reference, supplier_id, receipt_url, recorded_by)
SELECT {q(T)}, {q(SITE)}, {q(str(d))}, {q(cat)}::expense_category, {q(desc)}, {amount}, t.base_currency,
       {q(paid_from)}, NULL, NULL, NULL, {q(who)} FROM tenant t WHERE t.id = {q(T)};""")
        if paid_from == "BANK":
            self.bank_lines.append((d + dt.timedelta(days=1), -amount, 'CHEQUE/EFT ' + desc[:20].upper(), ''))
        self.stats["expenses"] += 1

    # ---- one shift ---------------------------------------------------------
    def shift(self, d: dt.date, day_i: int, label: str, open_h: float) -> None:
        rng, db = self.rng, self.db
        sup = SUP[label]
        week = (d.toordinal() // 7) % 2
        pair = (ATT[0:2] if (label == "DAY") ^ bool(week) else ATT[2:4])
        # Two attendants share nine nozzles: first takes the odd pumps' side.
        roster = {n: pair[0] if int(n[1:]) <= 5 else pair[1] for n in NOZZLES}

        t_open = self.local(d, open_h) + dt.timedelta(minutes=2)
        db.at(t_open)
        dips = [{"tank_id": TANKS[p], "product_litres": round(self.physical[p] + rng.gauss(0, 2.5), 1),
                 "water_litres": 0} for p in TANKS]
        ros = [{"nozzle_id": NOZZLES[n], "attendant_id": roster[n], "volume_totalizer": round(self.tot[n], 3)}
               for n in NOZZLES]
        # ShiftService.OpenAsync -> fn_open_shift
        shift_id = db.one(sup, f"SELECT fn_open_shift({q(SITE)}, {q(label)}, {q(sup)}, "
                               f"{q(json.dumps(dips))}::jsonb, {q(json.dumps(ros))}::jsonb, NULL, NULL);")
        rows = db.run(sup, f"""
SELECT n.code, na.id FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id WHERE na.shift_id = {q(shift_id)};
SELECT 'price', p.code, fn_shift_price({q(shift_id)}, p.id) FROM product p WHERE p.id IN ({q(PRODUCTS['PMS'])}, {q(PRODUCTS['AGO'])});""")
        assign = {r[0]: r[1] for r in rows if r[0] != "price"}
        price = {r[1]: float(r[2]) for r in rows if r[0] == "price"}

        # Per attendant running money, and per nozzle litres.
        metered = {n: 0.0 for n in NOZZLES}
        tested = {n: 0.0 for n in NOZZLES}
        owed = {a: 0.0 for a in pair}          # value of everything they sold (unrounded running)
        credit = {a: 0.0 for a in pair}
        tenders = {a: {"MTN_MOMO": 0.0, "AIRTEL": 0.0, "VISA_MC": 0.0} for a in pair}
        shop = {a: 0.0 for a in pair}
        dropped = {a: 0.0 for a in pair}
        held = {a: 0.0 for a in pair}
        skip_last_drop = {a: rng.random() < 0.05 for a in pair}
        self.stats["over_cap"] += sum(skip_last_drop.values())   # expected CASH_HELD_OVER_CAP

        swing = rng.uniform(0.8, 1.2) * (1.12 if d.weekday() >= 5 else 1.0)
        delivery_hour = 3 if (label == "DAY" and self.pending_delivery) else None

        # Morning pump test on one nozzle, poured back (ForecourtService).
        if label == "DAY":
            n = rng.choice(list(NOZZLES))
            meas = round(rng.uniform(19.92, 20.08), 2)
            db.at(t_open + dt.timedelta(minutes=35))
            db.run(sup, f"""
INSERT INTO pump_test (tenant_id, site_id, shift_id, nozzle_id, can_size_litres, measured_litres,
                       returned_to_tank, tested_by, witnessed_by, photo_url)
SELECT {q(T)}, s.site_id, {q(shift_id)}, {q(NOZZLES[n])}, 20, {meas}, TRUE, {q(sup)}, NULL, NULL
  FROM shift s WHERE s.id = {q(shift_id)};""")
            metered[n] += meas
            tested[n] += meas
            self.physical[NOZZLE_PRODUCT[n]] -= meas   # out through the meter; poured back at close
            self.stats["pump_tests"] += 1

        for h in range(12):
            hour_of_day = int(open_h + h) % 24
            t_hour = t_open + dt.timedelta(hours=h)
            hour_sales = {a: 0.0 for a in pair}
            for n in NOZZLES:
                p = NOZZLE_PRODUCT[n]
                share = DAILY_LITRES[p] / (5 if p == "PMS" else 4)
                lit = max(0.0, rng.gauss(share * HOURLY_SHAPE[hour_of_day] / 21.0 * swing, share * 0.02))
                lit = round(lit, 2)
                metered[n] += lit
                v = lit * price[p]
                owed[roster[n]] += v
                hour_sales[roster[n]] += v
                self.physical[p] -= lit

            # A credit sale now and then, on a diesel nozzle (CreditService.RecordSaleAsync).
            if rng.random() < (0.12 if label == "DAY" else 0.04):
                n = rng.choice([x for x in NOZZLES if NOZZLE_PRODUCT[x] == "AGO"])
                a = roster[n]
                lit = round(rng.choice([40, 60, 80, 100, 150, 200]) + rng.uniform(-3, 3), 2)
                db.at(t_hour + dt.timedelta(minutes=rng.randint(5, 55)))
                cust = rng.choices(CUSTOMERS, weights=[1, 3])[0]   # the transporter buys most
                # Priced as CreditService does: the agreement in force, else the pump.
                row = db.run(sup, f"SELECT customer_price_id, price FROM fn_customer_price({q(cust)}, "
                                  f"{q(PRODUCTS['AGO'])}, {price['AGO']}, now());")
                cp_id, unit = (row[0][0], float(row[0][1])) if row and row[0][0] else (None, price["AGO"])
                amount = r2(lit * unit)
                db.run(sup, f"""
INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, vehicle_id, staff_id, attendant_id,
                         nozzle_id, product_id, litres, unit_price, amount, voucher_no, odometer, signed_by, evidence_url,
                         customer_price_id)
VALUES ({q(T)}, {q(SITE)}, {q(shift_id)}, {q(cust)}, NULL, {q(sup)}, {q(a)}, {q(NOZZLES[n])},
        {q(PRODUCTS['AGO'])}, {lit}, {unit}, {amount}, {q(f'V-{rng.randint(1000, 9999)}')}, NULL, 'Driver', NULL,
        {q(cp_id)});""")
                self.stats["agreed_price_sales"] += 1 if cp_id else 0
                # As the API does: over the customer's limit raises a flag, never a refusal.
                db.run(sup, f"""
SELECT fn_raise_flag({q(T)}, {q(SITE)}, {q(shift_id)}, 'credit_sale', cs.id::text, 'CREDIT_LIMIT_EXCEEDED', 'WARN',
                     jsonb_build_object('customer', cc.name, 'balance', h.balance, 'this_sale', cs.amount))
  FROM credit_sale cs JOIN credit_customer cc ON cc.id = cs.customer_id
 CROSS JOIN LATERAL fn_customer_headroom(cs.customer_id) h
 WHERE cs.id = (SELECT id FROM credit_sale WHERE shift_id = {q(shift_id)} ORDER BY recorded_at DESC LIMIT 1)
   AND h.headroom < 0;""")
                metered[n] += lit
                owed[a] += lit * price["AGO"]
                # The attendant answers for the PUMP value: credit at the agreed
                # price plus the agreed-price line make exactly that at close.
                credit[a] += r2(lit * price["AGO"])
                self.physical["AGO"] -= lit
                self.stats["credit_sales"] += 1

            # Shop sale (DryStockService.RecordSaleAsync).
            if rng.random() < 0.18:
                a = rng.choice(pair)
                item, _, qty = rng.choices(SHOP_ITEMS, weights=[w for _, w, _ in SHOP_ITEMS])[0]
                db.at(t_hour + dt.timedelta(minutes=rng.randint(5, 55)))
                rows = db.run(sup, f"SELECT fn_dry_on_hand({q(item)}, {q(SITE)}), fn_dry_price({q(SITE)}, {q(item)});")
                on_hand, unit = float(rows[0][0]), float(rows[0][1])
                if on_hand >= qty:
                    total = r2(qty * unit)
                    sale_id, line_id = str(uuid.uuid4()), str(uuid.uuid4())
                    db.run(sup, f"""
INSERT INTO dry_sale (id, tenant_id, site_id, shift_id, seller_id, receipt_no, customer_ref, total_amount, currency, recorded_by)
VALUES ({q(sale_id)}, {q(T)}, {q(SITE)}, {q(shift_id)}, {q(a)}, {q(f'R-{self.receipt:05d}')}, NULL, {total}, 'UGX', {q(sup)});
INSERT INTO dry_sale_line (id, tenant_id, sale_id, item_id, qty, unit_price, line_amount, exchange_in_item_id)
VALUES ({q(line_id)}, {q(T)}, {q(sale_id)}, {q(item)}, {qty}, {unit}, {total}, NULL);
INSERT INTO dry_movement (tenant_id, site_id, item_id, shift_id, kind, qty, signed_qty, unit_price, dry_sale_line_id, recorded_by)
VALUES ({q(T)}, {q(SITE)}, {q(item)}, {q(shift_id)}, 'SALE_OUT', {qty}, -{qty}, {unit}, {q(line_id)}, {q(sup)});""")
                    self.receipt += 1
                    shop[a] += total
                    hour_sales[a] += total
                    self.stats["shop_sales"] += 1

            # The tenders this hour: some customers pay by phone or card.
            for a in pair:
                momo = round(hour_sales[a] * rng.uniform(0.08, 0.2), -2)
                ch = "MTN_MOMO" if rng.random() < 0.7 else "AIRTEL"
                tenders[a][ch] += momo
                # On the network's statement, the customers' own payments,
                # each at its minute.
                left, k = momo, rng.randint(1, 3)
                for j in range(k):
                    part = left if j == k - 1 else round(left * rng.uniform(0.2, 0.6), -2)
                    if part > 0:
                        self.momo_lines[ch].append((t_hour + dt.timedelta(minutes=rng.randint(1, 58)), part,
                                                    'MERCHANT PAYMENT', f'MP{rng.randint(10**8, 10**9 - 1)}'))
                    left = round(left - part, 2)
                card = round(hour_sales[a] * 0.03, -3) if rng.random() < 0.1 else 0.0
                tenders[a]["VISA_MC"] += card
                held[a] += hour_sales[a] - momo - card

            # The delivery, mid-morning (DeliveryService create + receive).
            if delivery_hour is not None and h == delivery_hour:
                self.delivery(d, shift_id, sup, t_hour + dt.timedelta(minutes=20))

            # Cash drops, witnessed by the supervisor (CashDropService -> fn_record_cash_drop).
            # An attendant walks to the safe on reaching about 400,000, not on
            # the hour -- so a busy hour means two or three drops, each of what
            # they had on them then.
            for a in pair:
                last_hours = h >= 8
                if last_hours and skip_last_drop[a]:
                    continue
                minute = 10
                while held[a] >= 400_000:
                    amt = 400_000 if held[a] < 800_000 else math.floor(held[a] / 2 / 100_000) * 100_000
                    amt = min(amt, 400_000)
                    minute = min(58, minute + rng.randint(8, 20))
                    db.at(t_hour + dt.timedelta(minutes=minute))
                    db.run(sup, f"SELECT fn_record_cash_drop({q(shift_id)}, {q(a)}, {amt}, {q(sup)}, "
                                f"{q(f'p.{self.drop_book // 30 + 1} l.{self.drop_book % 30 + 1}')}, {q(sup)});")
                    self.drop_book += 1
                    dropped[a] += amt
                    held[a] -= amt
                    self.stats["drops"] += 1

        # ---- close (ShiftClosureService -> fn_close_shift) ----
        t_close = t_open + dt.timedelta(hours=12)
        db.at(t_close)
        for n in NOZZLES:
            self.tot[n] = round(self.tot[n] + metered[n], 3)
        for n in NOZZLES:
            self.physical[NOZZLE_PRODUCT[n]] += tested[n]   # poured back
        loss = None
        if rng.random() < 0.025:
            p = rng.choice(["PMS", "AGO"])
            loss = (p, round(rng.uniform(60, 160), 1))
            self.physical[p] -= loss[1]
            self.stats["losses"] += 1
        readings = [{"assignment_id": assign[n], "volume_totalizer": self.tot[n], "is_rollover": False} for n in NOZZLES]
        close_dips = [{"tank_id": TANKS[p], "product_litres": round(self.physical[p] + rng.gauss(0, 2.0), 1),
                       "water_litres": 0} for p in TANKS]

        # What each attendant owes, as the close bills it: one rounded line per
        # nozzle (litres sold = metered less returned tests) plus shop sales.
        bill = {a: 0.0 for a in pair}
        for n in NOZZLES:
            bill[roster[n]] += r2(round(metered[n] - tested[n], 3) * price[NOZZLE_PRODUCT[n]])
        cashups = []
        for a in pair:
            owes = r2(bill[a] + shop[a])
            electronic = sum(tenders[a].values())
            cash = r2(owes - credit[a] - electronic - dropped[a])
            reason = None
            if rng.random() < 0.05 and cash > 60_000:
                short = float(rng.choice([2000, 5000, 10000, 20000, 35000, 50000]))
                cash = r2(cash - short)
                reason = "Counted twice with the supervisor; short"
                self.stats["shortages"] += 1
            cashups.append({"attendant_id": a, "cash": cash,
                            "tenders": [{"channel_code": c, "amount": v, "reference": f"{c}-{d:%m%d}-{a[-2:]}"}
                                        for c, v in tenders[a].items() if v > 0],
                            **({"shortage_reason": reason} if reason else {})})
        db.one(sup, f"SELECT fn_close_shift({q(shift_id)}, {q(sup)}, 'SCHEDULED', {q(json.dumps(readings))}::jsonb, "
                    f"{q(json.dumps(close_dips))}::jsonb, {q(json.dumps(cashups))}::jsonb)::text;")
        self.stats["shifts"] += 1

        # The manager signs it off (ShiftService.ApproveAsync). A minute after
        # close, before the next shift opens: the clock must never run
        # backwards, or rows written "earlier" fall outside what was booked.
        db.at(t_close + dt.timedelta(minutes=1))
        mgr = MGR[d.toordinal() % 2]
        db.run(mgr, f"UPDATE shift SET state = 'APPROVED', approved_by = {q(mgr)}, approved_at = now() "
                    f"WHERE id = {q(shift_id)} AND state = 'DECLARED';")

        # Order fuel when a tank will not last two days.
        for p in TANKS:
            if self.physical[p] < DAILY_LITRES[p] * 2.6 + 300 and p not in self.pending_delivery:
                self.pending_delivery[p] = 0

    def delivery(self, d: dt.date, shift_id: str, sup: str, when: dt.datetime) -> None:
        rng, db = self.rng, self.db
        self.db.at(when)
        dn = f"DN-{d:%y%m}{self.dn:03d}"
        self.dn += 1
        supplier = rng.choice(SUPPLIERS)
        lines = []
        nominal = {"PMS": 19000, "AGO": 28500}
        for p in list(self.pending_delivery):
            room = nominal[p] - self.physical[p] - 500
            loaded = min(room, 10000 if p == "PMS" else 15000)
            loaded = math.floor(loaded / 1000) * 1000
            if loaded < 3000:
                continue
            cost = round(self.current_price(p, shift_id) * rng.uniform(0.895, 0.915))
            lines.append((p, loaded, cost))
        self.pending_delivery.clear()
        if not lines:
            return
        delivery_id = db.one(sup, f"""
INSERT INTO delivery (tenant_id, site_id, supplier_id, delivery_note_no, invoice_no, depot, transporter,
                      truck_reg, driver_name, seal_numbers, status, arrived_at)
VALUES ({q(T)}, {q(SITE)}, {q(supplier)}, {q(dn)}, {q('INV-' + dn[3:])}, 'Jinja', 'Own fleet',
        {q('UB' + str(rng.randint(100, 999)) + 'K')}, 'Driver', NULL, 'ARRIVED', now()) RETURNING id;""")
        sql = []
        for p, loaded, cost in lines:
            sql.append(f"""
INSERT INTO delivery_line (tenant_id, delivery_id, tank_id, product_id, loaded_litres, unit_cost)
SELECT {q(T)}, {q(delivery_id)}, {q(TANKS[p])}, t.product_id, {loaded}, {cost} FROM tank t WHERE t.id = {q(TANKS[p])};""")
        db.run(sup, "\n".join(sql))
        sql = []
        for p, loaded, cost in lines:
            before = round(self.physical[p] + rng.gauss(0, 2), 1)
            received = round(loaded * (1 - rng.uniform(0.0005, 0.003)), 1)
            self.physical[p] += received
            after = round(self.physical[p] + rng.gauss(0, 2), 1)
            for ctx, litres in (("PRE_DELIVERY", before), ("POST_DELIVERY", after)):
                sql.append(f"""
INSERT INTO dip_reading (tenant_id, site_id, tank_id, context, dip_mm, water_dip_mm, gross_litres, water_litres,
                         product_litres, evidence, recorded_by, captured_at)
SELECT {q(T)}, t.site_id, {q(TANKS[p])}, {q(ctx)}::dip_context, NULL, 0, {litres}, 0, {litres}, 'PENDING', {q(sup)}, now()
  FROM tank t WHERE t.id = {q(TANKS[p])};""")
            sql.append(f"""
UPDATE delivery_line SET
  dip_before_id = (SELECT id FROM dip_reading WHERE tank_id = {q(TANKS[p])} AND context = 'PRE_DELIVERY' ORDER BY id DESC LIMIT 1),
  dip_after_id  = (SELECT id FROM dip_reading WHERE tank_id = {q(TANKS[p])} AND context = 'POST_DELIVERY' ORDER BY id DESC LIMIT 1),
  received_litres = {round(after - before, 1)}, rejected_litres = 0, rejection_reason = NULL
 WHERE delivery_id = {q(delivery_id)} AND tank_id = {q(TANKS[p])};""")
        sql.append(f"UPDATE delivery SET seals_intact = TRUE, seal_photo_url = NULL, decant_ended_at = now(), status = 'DECANTING' WHERE id = {q(delivery_id)};")
        sql.append(f"SELECT fn_receive_delivery({q(delivery_id)}, {q(shift_id)}, {q(sup)})::text;")
        db.run(sup, "\n".join(sql))
        self.stats["deliveries"] += 1
        # The supplier bills what was loaded, at the agreed cost.
        self.to_invoice.append((delivery_id, supplier, sum(round(loaded * cost, 2) for _, loaded, cost in lines), dn))

    def current_price(self, p: str, shift_id: str) -> float:
        return float(self.db.one(SUP["DAY"], f"SELECT fn_shift_price({q(shift_id)}, {q(PRODUCTS[p])});"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--db", default="fcms_sim")
    ap.add_argument("--port", default=os.environ.get("SIM_PORT", "5546"))
    ap.add_argument("--clock", default=os.environ.get("SIMCLOCK_FILE", "/tmp/fcms_simclock.offset"))
    ap.add_argument("--start", help="first day, YYYY-MM-DD (default: --days before yesterday)")
    a = ap.parse_args()
    today = dt.datetime.now(KAMPALA).date()
    start = dt.date.fromisoformat(a.start) if a.start else today - dt.timedelta(days=a.days + 1)
    sim = Sim(Db(a.clock, a.db, a.port), start, a.days, a.seed)
    t0 = time.time()
    sim.run()
    reconcile_money(sim)
    print(f"\nSimulated {a.days} days from {start} in {time.time() - t0:.0f}s: "
          + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in sim.stats.items()))
    detected(sim)


ACCOUNTANT = "10000000-0000-4000-8000-000000000004"


def reconcile_money(sim: Sim) -> None:
    """The month-end routine: import each statement, match it, post what only
    the bank knew (its fees), and require every account to reconcile to nil
    (MoneyAccountService.ImportStatementAsync / AutoMatchAsync / PostLineAsync)."""
    db = sim.db
    for key, acct in sim.accounts.items():
        if key == "BANK":
            rows = [(d, None, amt, text, ref) for d, amt, text, ref in sim.bank_lines]
        else:
            rows = [(at.astimezone(KAMPALA).date(), at, amt, text, ref) for at, amt, text, ref in sim.momo_lines[key]]
        rows.sort(key=lambda r: (r[0], r[1] or dt.datetime.min.replace(tzinfo=KAMPALA)))
        if not rows:
            continue
        stmt = db.one(ACCOUNTANT, f"""
INSERT INTO bank_statement (tenant_id, money_account_id, period_from, period_to, source_name, imported_by)
VALUES ({q(T)}, {q(acct)}, {q(str(rows[0][0]))}, {q(str(rows[-1][0]))}, 'simulated statement', {q(ACCOUNTANT)})
RETURNING id;""")
        for i in range(0, len(rows), 400):
            values = ",\n".join(
                f"({q(T)}, {q(stmt)}, {q(acct)}, {q(str(r[0]))}, {q(r[1].isoformat() if r[1] else None)}, "
                f"{q(r[3])}, {q(r[4])}, {r[2]}, {n})"
                for n, r in enumerate(rows[i:i + 400], i + 1))
            db.run(ACCOUNTANT, f"""
INSERT INTO bank_statement_line (tenant_id, statement_id, money_account_id, txn_date, txn_at, description,
                                 reference, amount, line_no)
VALUES {values}
ON CONFLICT DO NOTHING;""")
        sim.stats["statement_lines"] += len(rows)
        db.run(ACCOUNTANT, f"SELECT fn_bank_auto_match({q(acct)}, {q(ACCOUNTANT)});")
        for (line,) in db.run(ACCOUNTANT, f"""
SELECT sl.id FROM bank_statement_line sl
 WHERE sl.money_account_id = {q(acct)} AND sl.description = 'MONTHLY LEDGER FEE'
   AND sl.id NOT IN (SELECT line_id FROM v_bank_matched_statement);"""):
            db.run(ACCOUNTANT, f"SELECT fn_bank_post_statement_line({q(line)}, '6100', 'Bank ledger fee', {q(ACCOUNTANT)});")
            sim.stats["bank_charges"] += 1
        r = db.run(ACCOUNTANT, f"""
SELECT statement_balance, in_transit, not_presented, statement_only, book_balance, difference,
       unmatched_book, unmatched_statement, stale_book
  FROM fn_bank_reconciliation({q(acct)}, current_date);""")[0]
        print(f"  {key:9s} statement {float(r[0]):>15,.2f}  in transit {float(r[1]):>13,.2f}  "
              f"not presented {float(r[2]):>12,.2f}  books {float(r[4]):>15,.2f}  difference {float(r[5]):,.2f}  "
              f"(open: {r[6]} book, {r[7]} statement)")
        # The wallets have nothing planted: nothing may be open.
        if key != "BANK" and (int(r[7]) or int(r[8])):
            raise RuntimeError(f"RECONCILIATION FAILED: {key} has {r[7]} statement and {r[8]} stale book items open")
        if key == "BANK":
            # Exactly what was planted, and nothing else: the short-credited
            # deposit (one book item, one statement line) and the standing order.
            planted_statement = 1 + (1 if sim.short_banked else 0)
            planted_book = 1 if sim.short_banked else 0
            if int(r[7]) != planted_statement or int(r[8]) != planted_book:
                raise RuntimeError(f"RECONCILIATION FAILED: bank shows {r[7]} statement and {r[8]} stale book items "
                                   f"open; planted {planted_statement} and {planted_book}")
            print(f"  bank: caught the deposit credited 50,000 short and the unrecorded standing order")


def detected(sim: Sim) -> None:
    """Did the system catch what the simulator planted -- and nothing else?"""
    rows = sim.db.run(MGR[0], f"""
SELECT 'losses',    count(*) FROM exception_flag WHERE code = 'STOCK_VARIANCE' AND level = 'CRITICAL' AND shift_id IS NOT NULL
UNION ALL SELECT 'noise', count(*) FROM exception_flag WHERE code = 'STOCK_VARIANCE' AND level = 'WARN'
UNION ALL SELECT 'shortages', count(*) FROM staff_shortage
UNION ALL SELECT 'over_cap',  count(*) FROM exception_flag WHERE code = 'CASH_HELD_OVER_CAP';""")
    got = {r[0]: int(r[1]) for r in rows}
    problems = []
    if got["losses"] != sim.stats["losses"]:
        problems.append(f"{sim.stats['losses']} fuel losses planted, {got['losses']} CRITICAL variances raised")
    if got["noise"]:
        problems.append(f"{got['noise']} stock warnings raised on dip noise alone")
    if got["shortages"] != sim.stats["shortages"]:
        problems.append(f"{sim.stats['shortages']} cash shortages planted, {got['shortages']} raised")
    if got["over_cap"] > sim.stats["over_cap"]:
        problems.append(f"{got['over_cap']} over-cap flags, but only {sim.stats['over_cap']} attendants skipped drops")
    print(f"Detected: {got['losses']} of {sim.stats['losses']} losses, {got['shortages']} of "
          f"{sim.stats['shortages']} shortages, {got['over_cap']} over-cap (at most {sim.stats['over_cap']}), "
          f"{got['noise']} false stock alarms")
    if problems:
        raise RuntimeError("DETECTION FAILED:\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
