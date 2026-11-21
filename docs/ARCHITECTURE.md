# FCMS v2 — Architecture

## The one idea

Everything below follows from a single change: **reconciliation is derived, never
stored.**

v1 asked stored procedures to compute `book_closing`, `variance_litres`,
`expected_cash` and `balance_after`, then wrote the answers into columns. Three
migrations (`010` → `019` → `025`) rewrote the same cash-up formula because each
version was wrong, and rows written under the old formula keep the old answer
forever.

v2 has two append-only ledgers and no stored answers:

| | Ledger | Invariant | Enforced by |
|---|---|---|---|
| Fuel | `fuel_movement` | book stock = `SUM(signed_litres)` | generated column + rules |
| Fuel | `metered_disposition` | `SUM(dispositions)` = metered volume | deferred constraint trigger |
| Money | `money_movement` | `SUM(amount)` per cash-up = 0 | deferred constraint trigger |

An unaccounted litre and an unallocated shilling are both **uncommittable**. Not
flagged afterwards — refused at COMMIT, with a message that names the person, the
nozzle and the amount.

## Why the three-way disposition matters

The v1 formula was `net_sales = throughput − tests − own_use`, written out longhand
in three procedures. Two of the audit's critical bugs are that formula being wrong
in a way nothing could detect:

- **C5**: bulk own-use (never passed a meter) was subtracted from metered
  throughput, understating what the attendant owed.
- **C6**: pump tests were valued at nominal can size instead of measured volume, so
  every test pushed its deviation into stock variance as a phantom loss.

In v2 those are not subtractions. Metered fuel is *partitioned*: every litre that
passed a nozzle is a `SALE`, a `PUMP_TEST` or an `OWN_USE` row, and the parts must
sum to the whole. Bulk own-use is structurally a different thing — a `BULK_OUT`
movement with no disposition — so it *cannot* be subtracted from metered throughput
by mistake. The bug class is designed out, not patched.

## Entity map

```
tenant ── tenant_policy            (every tolerance, one row, auditable)
  └─ site ── product
       ├─ tank ── tank_calibration
       │    └─ nozzle ── pump
       ├─ staff
       └─ shift ── nozzle_assignment
                        │
        ┌───────────────┴───────────────┐
        │                               │
   meter_reading (open/close)      cash_up
        └─ meter_event                  └─ money_movement ──┐
              ├─ metered_disposition ───────────────────────┤ SALE / CASH /
              │     ├─ pump_test                            │ MOMO / CARD /
              │     └─ own_use                              │ CREDIT / DISCOUNT
              └─ fuel_movement ◄── delivery_line            │ / SHORTAGE
                     ▲            ◄── bulk_draw             │
                     │            ◄── stock_count      credit_sale
                dip_reading                            discount_grant
                (physical truth)                       staff_shortage
```

Relationships worth calling out:

- **Readings hang off the assignment, not the shift.** A nozzle can change hands
  mid-shift and each holder settles independently.
- **`meter_event` is unique per assignment.** One open, one close, one volume.
  Partial unique indexes make a second opening reading impossible.
- **Nozzle has no `product_id`.** It dispenses whatever its tank holds
  (`v_nozzle_product`). v1 had both and a trigger to keep them agreeing; deleting
  the column deletes the bug.
- **Price is captured onto the transaction**, not looked up at close time. v1's
  `fn_price_at()` re-priced closed shifts whenever anyone backdated a price row.

## Stack

Keeping your decision: **.NET 8 API + Next.js frontend + PostgreSQL 16**. The
changes are in how they talk to the database.

**Transaction boundary — the fix for C2 and C9.** One `IUnitOfWork` per request
owning one connection and one transaction. RLS context set with
`set_config(..., TRUE)` — transaction-local, so it cannot survive into the next
request on a pooled connection. EF Core and Dapper share that connection; no
component opens its own. A shift close is then genuinely atomic instead of three
independent transactions that can leave a station wedged half-closed.

**Offline-first stays.** The forecourt has no signal and the outbox design in v1 was
right. It gets stronger here: `idempotency_key` is a unique partial index on both
ledgers, so a replayed outbox entry is a no-op rather than a double posting — which
is what made C3 double-charge attendants.

## Build order

Schema first because everything else is a projection of it.

1. **Schema + migration runner + self-tests** ← *files below are this step*
2. **Data access core** — `IUnitOfWork`, RLS session, idempotency, error mapping
3. **Setup & equipment** — tenant, site, tanks, calibration import, pumps, nozzles
4. **People & access** — staff, roles, password lifecycle, login lockout
5. **Shift lifecycle** — open, assign, handover, close (the atomic close routine)
6. **Fuel side** — deliveries, dips, pump tests, own use, stock take
7. **Money side** — cash-up, **credit sales UI (audit H1)**, discounts, shortages, banking
8. **Exceptions & reporting** — variance, meter divergence, attendant scorecard
9. **Hardening** — rate limits, secrets, session revocation, load test

Phase 2 (deferred per your instruction): URA/EFRIS and EPRA/eTIMS fiscalisation,
QuickBooks posting.

## What I need from you before step 3

A few things change the schema and are cheaper to settle now than to migrate later:

- **Attendant sign-in.** v1 migration `022` says attendants do not sign in — the
  supervisor records everything. Confirm that holds, since it decides whether
  `staff` needs credentials at all for that role.
- **Shift patterns.** Two 12s? Three 8s? Fixed labels or roster-driven?
- **Dry stock.** Lubricants, LPG cylinders, shop items — in scope now or later?
  `stock_count` is built to take them but the sales path is fuel-only today.
- **Multi-site.** One database serving many stations under one dealer, or one
  deployment per station?
