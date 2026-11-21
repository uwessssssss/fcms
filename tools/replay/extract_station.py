#!/usr/bin/env python3
"""
Read Kiboga's station workbook for one month into plain daily records.

    python3 -I tools/replay/extract_station.py KIBOGA_STATION_OCTOBER_2026.xlsx > station.json

Only the sheets that carry the month's figures are read: SALES (meters per
nozzle, per day), PMS / AGO (wet-stock reconciliation: dips, deliveries,
book, variance), BANKING (prices, credit, mobile money, discounts, expected
and banked cash), INVOICES (credit customers) and RECIEVED (deliveries).
The workbook's other sheets are older templates and customer statements.

Output is figures only -- no names of staff. Customer names are kept because
a credit sale must name its customer.
"""
import datetime as dt
import json
import re
import sys

import openpyxl


def day(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, str):
        m = re.match(r"\s*(\d{1,2})[./](\d{1,2})[./](\d{4})", v)
        if m:
            return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    return None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = {"days": {}, "invoices": [], "deliveries": []}
    D = out["days"]

    # --- SALES: nozzle meters. A block starts at a row with a date in column E
    # and its shift in F: BOTH (the whole day) or, on a day the price moved,
    # a DAY block and a NIGHT block. Each block becomes one segment.
    seg = None
    for r in wb["SALES"].iter_rows(values_only=True):
        r = list(r) + [None] * 20
        d = day(r[4])
        if d:
            seg = {"shift": (str(r[5]).strip().upper() if r[5] else "BOTH"), "nozzles": {}}
            D.setdefault(d, {}).setdefault("segments", []).append(seg)
        # Return to tank: its own row, "RTT PMS" in column N and litres in O.
        if seg is not None and isinstance(r[13], str):
            mr = re.fullmatch(r"\s*RTT\s+(PMS|AGO|BIK)\s*", r[13].upper())
            if mr and num(r[14]):
                seg.setdefault("rtt", {})[mr[1]] = seg.get("rtt", {}).get(mr[1], 0.0) + num(r[14])
        name = (r[6] or "").strip() if isinstance(r[6], str) else ""
        m = re.fullmatch(r"(PMS|AGO|BIK)\s*(\d)", name)
        if seg is not None and m and num(r[10]) is not None and num(r[11]) is not None:
            seg["nozzles"][f"{m[1]}{m[2]}"] = {
                "open": num(r[10]), "close": num(r[11]), "rtt": num(r[14]) or 0.0,
                "value": num(r[13]) or 0.0}

    # --- PMS / AGO wet stock: opening dip, deliveries, sales, closing dip.
    for prod in ("PMS", "AGO"):
        for r in wb[prod].iter_rows(values_only=True):
            r = list(r) + [None] * 20
            d = day(r[1])
            if d and num(r[4]) is not None:
                t = D.setdefault(d, {}).setdefault("tanks", {})
                t[prod] = {"open_dip": num(r[4]), "delivered": num(r[5]) or 0.0, "sales": num(r[6]),
                           "book": num(r[7]), "close_dip": num(r[8]), "variance": num(r[9])}

    # --- BANKING: one block per day; the date is on the block's first row.
    cur = None
    for r in wb["BANKING"].iter_rows(values_only=True):
        r = list(r) + [None] * 20
        d = day(r[0])
        if d:
            cur = D.setdefault(d, {}).setdefault("money", {"price": {}})
            cur["airtel"] = num(r[8]) or 0.0
            cur["mtn"] = num(r[9]) or 0.0
            cur["discount"] = num(r[10]) or 0.0
            cur["short"] = num(r[11]) or 0.0
        if cur is None:
            continue
        p = (r[1] or "").strip().upper() if isinstance(r[1], str) else ""
        if p in ("PMS", "AGO", "IK", "BIK") and num(r[5]):
            cur["price"]["BIK" if p in ("IK", "BIK") else p] = num(r[5])
            cur.setdefault("litres", {})["BIK" if p in ("IK", "BIK") else p] = num(r[2]) or 0.0
            if num(r[3]):
                cur.setdefault("credit_litres", {})["BIK" if p in ("IK", "BIK") else p] = num(r[3])
        # The FIRST total of a day's block. The sheet carries later TOTAL rows
        # (the month's) that would otherwise overwrite the last day.
        if p == "TOTAL" and "sales_value" not in cur:
            cur["sales_value"] = num(r[6])
            cur["credit_value"] = num(r[7]) or 0.0
            cur["expected_cash"] = num(r[12])
            cur["banked"] = num(r[13])
            cur["bank_variance"] = num(r[14])

    # --- INVOICES: credit customers.
    for r in wb["INVOICES"].iter_rows(values_only=True):
        r = list(r) + [None] * 20
        d = day(r[0])
        if d and num(r[7]):
            out["invoices"].append({"date": d, "customer": (r[3] or "").strip() or None,
                                    "vehicle": (str(r[4]).strip() if r[4] else None),
                                    "litres": num(r[7]), "price": num(r[8]), "total": num(r[9])})

    # --- RECIEVED: deliveries into the station.
    for r in wb["RECIEVED"].iter_rows(values_only=True):
        r = list(r) + [None] * 20
        d = day(r[2])
        prod = (r[7] or "").strip().upper() if isinstance(r[7], str) else ""
        if d and prod in ("PMS", "AGO", "BIK") and num(r[8]):
            out["deliveries"].append({"date": d, "truck": r[3], "product": prod,
                                      "loaded": num(r[8]), "received": num(r[9])})

    out["days"] = dict(sorted((k, v) for k, v in D.items() if k.startswith(sys.argv[2] if len(sys.argv) > 2 else "")))
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
