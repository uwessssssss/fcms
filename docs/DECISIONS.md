# FCMS v2 — Decisions & Schema Status

## Your four answers, and what each one changed

### 1. Attendants do not sign in

This is the answer with the largest structural consequence, and it goes further
than "no login screen for attendants."

If an attendant never touches a keyboard, an attendant can never be the **author**
of a record. Every reading, dip and declaration is written by a supervisor *about*
an attendant. So `staff` now separates two roles a person can play:

| | Who | Signs in | Example column |
|---|---|---|---|
| **Subject** | attendant — the fuel and cash are theirs | no | `nozzle_assignment.attendant_id`, `cash_up.staff_id` |
| **Author** | supervisor and up — recorded it | yes | `meter_reading.recorded_by`, `cash_up.declared_by` |

Enforced by a **composite foreign key**, not application checks:

```sql
staff (id, is_operator) UNIQUE          -- is_operator = (role <> 'ATTENDANT')
meter_reading.recorded_by_is_operator   -- GENERATED ALWAYS AS (TRUE)
FOREIGN KEY (recorded_by, recorded_by_is_operator)
  REFERENCES staff (id, is_operator)
```

The generated column is pinned `TRUE`, so the FK can only resolve against a staff
row whose `is_operator` is also true. **A meter reading signed by a man who has
never logged in is not a bug you can write** — the insert fails. Demoting someone
to attendant while they still hold a credential also fails, loudly, which is
correct.

Attendants hold zero rows in `role_permission`. Their name is on the fuel and the
cash, never on the record.

### 2. DAY and NIGHT, sometimes three

Modelled as `business_date + label + segment`. A supervisor worked *one* day shift
that got cut when the price moved at 2pm — not "three shifts". So:

- `shift(business_date, label, segment)` — segment 1, 2, 3…
- `predecessor_id` chains them, `closed_reason` says why each cut happened
- `v_duty_period` folds segments back into one line for reports
- Reconciliation happens **per segment**, because that is the unit where one price
  was in force and one set of meters ran end to end

`fn_business_date()` uses `site.day_starts_at`, so a night shift closing at 05:30
files under yesterday instead of splitting across two days.

The price break is now a single function: close segment N → execute the price →
open segment N+1 with the new price stamped on it. One transaction.

### 3. Dry stock — now

`045_dry_stock.sql`. Same conservation discipline as fuel: on-hand is
`SUM(signed_qty)` from `dry_movement`, never a stored `qty_on_hand`.

Two things genuinely differ from fuel and are modelled explicitly rather than
forced into the fuel shape:

- **Units are exact.** No calibration chart, no interpolation. So an unexplained
  difference is theft, breakage or a miskey — never measurement error. Variance
  tolerance is zero and every line needs a reason.
- **LPG cylinders come back.** A refill is a full cylinder out and an empty one in;
  the customer pays for gas only. Modelled as two SKUs linked by
  `exchange_pair_id`. Trying to do this with one item and a full/empty flag is
  where LPG stock control usually falls apart.

Dry sales settle into the same `cash_up` as fuel, so a shop sale is accounted for
by the identical balance rule. `dry_stock_stays_positive` refuses a sale that would
take stock negative — that is almost always an unbooked delivery, and it should
stop at the counter rather than surface in a count six weeks later.

### 4. One station

**I kept `tenant_id` and `site_id` on the tables, deliberately, and I want to be
straight about why** since it reads like ignoring you.

What I *did* remove is the complexity: no site pickers, no cross-site rollups, no
multi-station roster logic. `fn_open_shift` resolves the one active site. The system
behaves as a single-station system.

What I kept is two columns. Removing them now means that when you take on a second
station — and your other products suggest you will — you backfill every row in
twenty tables and rewrite every RLS policy. Keeping them costs 32 bytes a row and
one column in some indexes. That trade is lopsided enough that I'd rather flag it
than quietly do either. **Say the word and I'll strip them.**

## Schema status

| File | Contents | State |
|---|---|---|
| `010_foundation.sql` | tenancy, policy, site, product, equipment | issued last turn |
| `020_people.sql` | staff, credentials, sessions, permissions, auth | **new** |
| `030_pricing.sql` | price changes, `shift_price` capture, WAC | **new** |
| `040_shift.sql` | patterns, shift segments, assignments, exceptions | **new** |
| `045_dry_stock.sql` | dry items, ledger, sales, counts, LPG | **new** |
| `050_fuel_ledger.sql` | fuel movements, meter events, dispositions, dips | issued last turn |
| `060_money_ledger.sql` | cash-up, money ledger, credit, shortages, banking | issued last turn |
| `070_operations.sql` | deliveries, stock counts, **open/close/price break** | **new** |
| `080_security.sql` | RLS event trigger, roles, audit log | issued last turn |

Run in numeric order — `020`/`030`/`040`/`045` must precede `050` because the fuel
ledger references `shift`, `staff` and `nozzle_assignment`.

## Known gaps — read this before running anything

1. **`070` opens with a retrofit block** that `ALTER`s `money_movement` and
   `cash_up` from `060`, and applies the authorship FKs to `050`/`060` tables.
   Those belong *inside* `050`/`060`. Fold them in before the first run — letting
   the schema accumulate a patch history is exactly what went wrong in v1, and I'd
   rather not start v2 that way.

2. **Nothing has been executed.** No Postgres in this sandbox, no network. The SQL
   is reviewed, not proven. Expect ordering and typo fixes on first run.
   Highest-risk spots: the `fn_require_operator_author` calls (they `ALTER` tables
   defined in earlier files), and the deferred trigger interactions inside
   `fn_close_shift`.

3. **Not yet written:** the migration runner, seed data for one station, and the
   integrity test suite that proves the invariants actually bite — a test that
   tries to commit an unaccounted litre and expects failure is worth more than any
   amount of review.

4. **Deferred to a settings decision:** LPG cylinder *deposits* are a column on
   `dry_item` but there's no deposit refund flow yet. Confirm whether you sell
   cylinders outright, exchange only, or both.

## Next

The schema is now complete enough to build against. My suggested order:

1. Migration runner + seed one station + **integrity tests** (prove the invariants)
2. `IUnitOfWork` — one connection, one transaction, `set_config(..., TRUE)`
3. Shift lifecycle API on top of `fn_open_shift` / `fn_close_shift`
4. The close screen, and **the credit-sale screen v1 never had** (audit H1)
