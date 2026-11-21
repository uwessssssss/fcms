# FCMS — Audit Report

Scope: 22,796 lines across 26 SQL migrations, 21 .NET feature modules, 24 Next.js
routes. Reviewed against one question: **can this station close a shift where every
litre and every shilling is accounted for?**

Answer today: **no.** Not because the code is bad — much of it is thoughtful — but
because of five structural faults and a set of arithmetic bugs that make the books
silently wrong rather than loudly wrong. Silently wrong is worse.

---

## Verdict first

| | |
|---|---|
| Critical (data loss / wrong money / security) | 9 |
| High (feature does not work at all) | 11 |
| Medium (works, but drifts or misleads) | 14 |
| Root architectural fault | 1 — reconciliation is *stored*, not *derived* |

The migrations tell their own story. `025_cashup_arithmetic.sql` fixes bugs in
`019_full_declaration.sql`, which fixed bugs in `010_price_break.sql`. Each pass
patches a formula in a stored procedure that writes a **snapshot number** into a
column. That is the fault. Numbers that are computed once and stored can only ever
drift; you then need a new migration every time reality disagrees with them.

---

## CRITICAL

### C1 — Thirteen tables have no row-level security at all
`011_rls.sql` enumerates the tables to protect as a hard-coded list. Every table
created afterwards was never added:

`credit_customer`, `credit_vehicle`, `credit_sale`, `credit_payment`,
`discount_grant`, `banking`, `payment_channel_statement_line` (all `019`),
`return_to_tank`, `supplier`, `purchase`, `purchase_line`, `purchase_payment`,
`treasury_movement` (all `023`), `shift_type` (`024`), `maintenance_run` (`016`).

In a multi-tenant deployment, **tenant A can read and write tenant B's entire
credit book, purchase ledger, banking records and treasury movements.** Only
`idempotency_record` was retrofitted (in `016`), which shows the gap was known and
handled one table at a time.

*Fix:* RLS must be applied by an event trigger on `CREATE TABLE`, or by a
migration-time assertion that fails the build when a `tenant_id` column exists
without a policy. Never by a list.

### C2 — Session variables are set at session scope, not transaction scope
`Infrastructure/TenantContext.cs`:

```csharp
"SELECT set_config('app.tenant_id', @t, false), " +
"       set_config('app.staff_id',  @s, false)"
```

The third argument `false` means *session-scoped*, not *transaction-local*. The
connection is pooled. Two outcomes, both bad:

- Npgsql resets on return to pool → the setting vanishes between queries, `FORCE
  ROW LEVEL SECURITY` matches zero rows, and **the screen renders blank with no
  error.** This is almost certainly a large share of "features not working."
- Reset disabled → the value survives into the next request on that connection and
  **one tenant reads another's data.**

*Fix:* `set_config(..., true)` inside an explicit transaction that spans the unit of
work — not a middleware that pokes a connection and hopes.

### C3 — Re-running a cash-up double-charges the attendant
`025_cashup_arithmetic.sql`, `fn_compute_cash_up`. The `cash_up` insert is an upsert
(`ON CONFLICT (shift_id, staff_id) DO UPDATE`), so it is safely re-runnable. The
`shortage_ledger` insert directly below it is **a plain INSERT with no conflict
target**:

```sql
INSERT INTO shortage_ledger (...) VALUES (...);
```

Call the close twice — a retry, an offline outbox drain, a supervisor correcting a
figure — and the attendant now owes the shortage twice. `balance_after` compounds it.
There is no reversal path. This is a real receivable against a real person's wages.

### C4 — The shortage running balance is not tenant-scoped
Same function:

```sql
SELECT COALESCE(balance_after, 0) INTO v_balance
  FROM shortage_ledger WHERE staff_id = v_staff
  ORDER BY created_at DESC LIMIT 1;
```

No `tenant_id` filter. It relies entirely on RLS being correctly applied — see C2.
When RLS is not applied (background jobs, maintenance sweep, any path that missed
`ApplyAsync`), this reads across tenants. It also uses `ORDER BY created_at DESC`
with no tiebreak; two entries in the same transaction share `now()` and the balance
is picked non-deterministically.

### C5 — Bulk own-use is subtracted from metered throughput
`009_functions.sql`, `fn_assignment_own_use_litres`:

```sql
SELECT COALESCE(SUM(ou.litres), 0) FROM own_use ou ... -- no through_meter filter
```

`fn_assignment_net_sales_litres` then subtracts this from gross meter throughput.
But fuel drawn *bulk* (`through_meter = false`) never passed the meter, so it was
never in throughput. Subtracting it **understates the attendant's sales**, which
means the station undercharges them and the loss lands on the dealer.

The schema knows about this distinction — `005_stock.sql` splits `own_use_metered`
from `own_use_bulk` and the comment explicitly warns about double-counting. The
function ignores the flag.

### C6 — Pump tests are valued at can size, not measured volume
`009_functions.sql` and `010_price_break.sql` both use `pt.can_size_litres`. The
whole point of a pump test is that the measured volume differs from the nominal can
— `pump_test.deviation_ml` exists to record exactly that. Using the 20 L can size
when 19.94 L actually came out puts the deviation into stock variance every single
test, on every pump, every day. Over a month this is a systematic phantom loss.

*Fix:* meter throughput deduction uses `measured_litres`; tank return uses
`measured_litres` gated on `returned_to_tank`.

### C7 — Own-use value multiplies when a nozzle changes hands
`025_cashup_arithmetic.sql`:

```sql
FROM own_use o
JOIN nozzle n ON n.id = o.nozzle_id
JOIN nozzle_assignment na ON na.nozzle_id = o.nozzle_id
                         AND na.shift_id = p_shift_id
                         AND na.staff_id = v_staff
```

If one attendant held a nozzle twice in a shift (handover out and back), `own_use`
joins to **both** assignment rows and the value doubles. Handover mid-shift is a
first-class feature of this system — `/api/roster/handover` exists — so this fires
in normal operation.

### C8 — Cash-up prices everything at `shift.opened_at`
`fn_price_at(v_shift.station_id, n.product_id, v_shift.opened_at)`.

Two failures. If `opened_at` is NULL (a DRAFT shift, or a shift written up after a
power cut), `fn_price_at` raises `NO_PRICE` and **the entire close aborts with an
error that names neither the shift nor the cause.** And the design's guarantee that
"a shift only ever has one price" is enforced only by the price-break routine — any
manual `price_change` insert, any backdated correction, silently reprices closed
shifts because `fn_price_at` reads current data, not the price stamped at sale time.

Price must be **captured onto the transaction**, not looked up from it.

### C9 — Cross-service operations are not atomic
`SqlRoutines` opens its own connection per call; EF Core holds a different one.
A shift close that runs `fn_capture_shift_close` (SqlRoutines), then
`fn_compute_cash_up` (SqlRoutines), then updates shift state (EF) spans **three
independent transactions**. A failure between them leaves readings captured,
assignments closed, no cash-up, and a shift stuck at `READINGS_DONE` with no way
forward. Because assignments are already `CLOSED`, retrying hits
`NO_ACTIVE_ASSIGNMENT` and the station is wedged.

---

## HIGH — features that cannot work

### H1 — There is no way to record a credit sale
The balance rule requires:

```
sales = cash + non-cash + credit + discounts + declared shortage
```

The backend exposes `POST /api/credit/sales` and `POST /api/credit/discounts`.
**Neither is called from anywhere in the frontend.** Grep of all 24 routes finds
`/api/credit/customers`, `/api/credit/ageing`, `/api/credit/payments`,
`/api/credit/statement/:id`, `/api/credit/shift/:id` — no `sales`, no `discounts`.

So any station that pumps fuel on credit — which is essentially every commercial
station in Uganda and Kenya — has an attendant who is short by the exact value of
the credit, every shift, with no way to declare it. **The shift can never balance.**
I'd expect this to be the loudest complaint from the forecourt.

### H2 — Six backend endpoints have no caller
`/api/statements/banking` (GET+POST), `/api/statements/unmatched`,
`/api/statements/meter-health`, `/api/reports/channels`, `/api/reports/qbo.csv`,
`/api/ops/return-to-tank`. Banking is the one that matters: cash declared at
cash-up is never followed through to a bank deposit, so the cash trail ends at the
supervisor's drawer.

### H3 — `close_reason` is required but nothing sets it correctly
`shift_closed_needs_reason` demands `close_reason IS NOT NULL` when status is
`CLOSED`. The frontend close flow sends `closeReason` as an optional field. A close
that omits it fails a check constraint and surfaces as a generic 500.

### H4 — Evidence enforcement never ran
Documented in `016_maintenance_and_signoff.sql` itself: the maintenance sweep used
`SET LOCAL` outside a transaction (a no-op) on a connection with no `app.tenant_id`,
under `FORCE ROW LEVEL SECURITY`. Every sweep query matched zero rows, silently,
forever. The file says the 24-hour evidence rule "STILL did not run" after a prior
fix. Worth verifying it runs now — the same class of fault (C2) is still present.

### H5 — Closing readings are matched by nozzle, not by assignment
`fn_capture_shift_close` inserts a closing reading `WHERE na.nozzle_id = ... AND
na.status = 'ACTIVE'`, and separately `UPDATE nozzle_assignment ... WHERE nozzle_id
= ... AND status = 'ACTIVE'`. If two assignment rows are somehow both ACTIVE, the
`RETURNING id INTO v_reading_id` takes one arbitrarily and the UPDATE closes both.
`one_active_holder_per_nozzle` should prevent this, but the routine should key on
`assignment_id` and not rely on it.

### H6 — Variance percentage is meaningless when sales are zero
```sql
v_var_pct := CASE WHEN v_net_sales > 0 THEN round(v_variance / v_net_sales * 100, 4) END;
v_ok      := v_var_pct IS NULL OR abs(v_var_pct) <= tolerance;
```
A tank with zero throughput and a 400-litre variance — a leak, a theft, a misread —
returns `within_tolerance = true`. **A leaking tank on a quiet night passes.**
Variance must be checked against an absolute litre floor as well as a percentage.

### H7 — Deliveries are counted only if `d.shift_id` matches
Receipts join on `d.shift_id = p_shift_id`. A delivery that arrives during shift A
and is decanted during shift B (common — the settle window is 30 minutes by
default) is credited to whichever shift the header points at, not the shift whose
tank actually received it. Stock walks.

### H8–H11 (summarised)
- `fn_meter_delta` plausibility uses `recorded_at`, not `device_recorded_at`, so an
  offline reading synced hours later fails as "implausible".
- Rollover capacity is `power(10, meter_digits)`, but `volume_totalizer` is
  `numeric(14,2)` — a meter whose display includes decimals rolls at a different
  point and the wrap is computed wrong.
- `short_over` is set to `unallocated`, which includes declared shortage — so an
  attendant who declares a 50,000 shortage shows `short_over = 0`, i.e. *balanced*.
  The column comment still says "expected − declared".
- JWT lifetime is 720 minutes with no refresh and no revocation list. A dismissed
  attendant keeps a valid session for up to 12 hours.

---

## MEDIUM (abbreviated)

Dip clamping at `d_lo * 1.02` invents up to 2% of tank volume above the chart •
`fn_dip_to_litres` prorates from origin below the lowest charted point, which is
wrong for a cylindrical tank • no `ORDER BY` tiebreak on same-timestamp readings •
`atg_reading` has no `station_id` so it escapes the station filter • RLS policies use
`USING` and `WITH CHECK` identically, so a user can move a row between stations
within a tenant • `tank_calibration` has no RLS and no tenant column • the maintenance
job runs `IntervalMinutes: 15` against tables it may not see • dev signing key and
DB password committed in `appsettings.json` • `Cookies.Secure: false` • no rate limit
on `/api/auth/login` despite `failed_logins` / `locked_until` columns existing •
`price_change` has no unique guard on `(station, product, effective_from)` for
non-EXECUTED rows, so pending duplicates stack • `stock_reconciliation.breach_needs_reason`
is satisfied by `investigated_by IS NULL`, so it never actually forces a reason •
no index on `credit_sale(shift_id, staff_id)` despite being summed per cash-up •
`payment_declaration` is deleted and re-inserted on every recompute, destroying the
audit trail of what was declared first.

---

## The root fault

Every number that matters — `book_closing`, `variance_litres`, `net_sales_litres`,
`expected_cash`, `balance_after` — is **computed by a stored procedure and written
into a column.** That design has three consequences you are living with right now:

1. **It cannot self-check.** Nothing in the database can prove `book_closing` was
   derived correctly. A bug in the formula produces a plausible wrong number, and
   the only way to find it is for a human to disagree with the total.
2. **Every fix needs a migration.** `010` → `019` → `025` are three attempts at the
   same cash-up formula. Rows written under the old formula keep the old answer
   forever, so your history is a patchwork of arithmetic.
3. **Fuel is not conserved.** There is no single place where litres in must equal
   litres out. Throughput lives in `meter_reading`, returns in `pump_test`, draws in
   `own_use`, receipts in `delivery_line`, physical truth in `dip_reading` — and
   they are related only by a formula written out longhand in three different
   procedures, each of which gets it slightly differently.

"Every drop of fuel should be accounted for" is not a validation rule you add. It is
a **schema shape**: fuel movement has to be a ledger where the sum is the answer, so
that an unaccounted litre is structurally impossible rather than merely detected.

That is what the redesign below does.
