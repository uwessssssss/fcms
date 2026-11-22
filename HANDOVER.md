# FCMS v2 — where this stands

Written to be read by whoever picks this up next, including you in three
months. It says what is finished, what is half-finished, and which parts to
distrust. The last of those is the most useful section.

---

## The shape of it

| | |
|---|---|
| Database | PostgreSQL 16, **75 migrations**, **101 integrity tests**, **19 attacks that must fail** (db/test/security.sql), **every closed shift recomputed from its readings** (tools/audit/shift_math.sql, 25 rules) |
| API | .NET 8 + Dapper, **111 endpoints**, **22 statements** |
| Web | Next.js, **21 screens**, dark operations console |
| Checks | **12 static checkers** plus a TypeScript compile, one command |

```bash
cd db  && ./migrate.sh test     # expect 101 | 0 | 101
./verify.sh                     # 16 static checks
tools/runtime/run.sh            # executed checks (after npm install in web/)
cd api && dotnet build --no-incremental && dotnet run
cd web && npm install && npm run dev
./verify.sh                      # everything above, in one pass
```

---

## What is solid

**The database.** This is the part to trust. Every rule that matters is a
constraint, a trigger or a policy rather than application code, so it holds
regardless of which client writes:

- Fuel cannot go unaccounted: a meter event that does not classify every litre
  will not commit.
- A cash-up that does not balance cannot close a shift. The gap becomes a named
  receivable against a named person, or it does not close at all.
- Attendants are **subjects, not authors** — a composite foreign key makes it
  structurally impossible for one to author a reading.
- The person who closes a shift cannot approve it.
- Ledgers are append-only, including for the unrestricted role.
- Two simultaneous credit sales cannot both pass the limit — the headroom read
  takes a row lock.
- Tenant isolation is row-level security, verified as `fcms_app` rather than as
  a superuser, which is the mistake that made an earlier version of those tests
  meaningless.

89 tests assert these. The ones added with migrations 320-460 have NOT yet
been run against a real database - the first run on your machine is the
first time they execute. Treat any failure there as information, not noise.

**The statements engine.** 22 statements — mobile money by till, shortages and
recoveries, dip register, daily loss and gain, stock adjustments, meter drift,
discounts, debtor ageing and the rest. Each is a registry entry of SQL; the
paging, dates, totals, CSV and printing are shared. **A 22nd statement is a
query, not a screen.**

**The margin arithmetic.** One place computes a bottom line. Discounts, own-use
fuel and stock loss are all subtracted, and `check_arithmetic.py` fails the
build if any screen's net figure stops agreeing with the others. Two real errors
lived here and both flattered the numbers — see `docs/MARGIN.md`.

---

## What is half-finished

**The frontend is on mock data.** All 21 screens render and are styled. They do
not yet call the API. Each one carries a comment naming the endpoint it wants:

| Endpoint | State |
|---|---|
| `GET /api/v1/dashboard/overview` | **built**, serving real data |
| `GET /api/v1/sites/:id/operations` | pending |
| `GET /api/v1/analytics/revenue` | pending |
| `GET /api/v1/analytics/fuel` | pending |
| `GET /api/v1/sites/:id/analytics/by-shift` | live -- sales per shift (no honest hourly figure exists) |
| `GET /api/v1/reports/performance` | pending |
| `POST /api/v1/reports/export` | pending |
| `POST /api/v1/auth/login` | pending — `/api/auth/login` exists, wire the path |

**106 endpoints have no caller.** That is not dead code; it is the older screens'
worth of functionality waiting to be reconnected. `check_contract.py` prints the
count every run.

**Two things the design assumes that this station cannot produce**, and they
return honest nulls rather than plausible numbers:

- **Pump status.** Active/idle/fault/offline needs a forecourt controller. Here
  a nozzle is *active* when rostered on an open shift, *idle* otherwise.
- **Average transaction.** Needs a till roll. A manual station has a shift
  total, so this is null and the card shows a dash.

---

## What to distrust

**The checkers are not a compiler.** Twelve of them exist because there was no
compiler for the frontend and there is still none for the C#. They caught real
faults — sixteen wrong column names in the statements alone — but each one is a
regex with a blind spot, and several produced false positives before they
produced findings.

**Three were retired**, deliberately: the palette rule, the raw-colour rule and
the JSX tag-balance rule. They encoded the previous frontend's conventions. The
adopted one keeps colours in component-local tables and nests JSX in ways a line
counter cannot follow. **A check the code deliberately does not satisfy fails
every run, and a suite that always fails is one nobody reads.**

**The offline TypeScript compile is advisory, not a gate.** It reports 12
errors that are its own shim's limits — `next/dynamic` returning a module
namespace, `React` as a value. The real check is `npm install && npx tsc
--noEmit` where the packages resolve. **Run it before trusting a build.**

**The C# has never been compiled here.** No .NET SDK in the environment it was
written in. `check_seams.py` and `check_arity.py` approximate a compiler and
have caught missing `using` directives, argument-count mismatches and duplicate
anonymous-object keys — but `dotnet build` is the only real answer.

**The calibration charts in the seed are straight lines.** This no longer
matters for trading, because dips are entered in **litres** and nothing converts
through a chart. They are kept only for a station that records stick readings.

---

## Things that were wrong and are worth not re-introducing

Each of these shipped, reached a real screen, and was fixed. They are recorded
because the shape recurs.

**Discounts were never subtracted.** Revenue is litres times the shift price,
gross of any discount — and nothing took it off. Margin was overstated by every
shilling given away, while the statement said in words that it was already
accounted for.

**Own-use fuel was charged nowhere.** A generator burning diesel through a power
cut cost the station nothing on any screen.

**The idempotency record was written after the transaction committed**, so
`app.tenant_id` was already gone and row-level security refused it. The close
failed with a message about a policy violation on a table nobody had heard of.

**Eight writes used a fresh random uuid as their idempotency key**, which
changes on every retry. The header was present and prevented nothing.

**Every modal in the adopted frontend was permanently closed** — nine callers
pass `isOpen`, the component read `open`, and undefined is falsy. Nothing
errored; the buttons simply did nothing.

**A tank fill bar was called two different ways**, so one of them always drew at
NaN% — which renders as empty, making a full tank look like an empty one.

The pattern in most of these: **the failure was silent and the output looked
reasonable.** That is the class worth the most suspicion.

---

## If you change one thing, change this

Wire a screen to its endpoint and delete its mock array. Start with site
operations — the endpoint shape is already declared in the component, the data
exists, and it is the screen a supervisor opens most.

When you do, collect that screen's interfaces into `web/src/types/api.ts`. The
C#-to-TypeScript drift checker resumes the moment that file exists, and it
catches renamed fields and nullability mismatches before they reach a build.

## Policy settings stored but not enforced (decisions needed)

Found by checking every setting against the code that should read it. These
exist in `tenant_policy` but nothing enforces them, so the Administration
screen no longer offers them as controls. Each needs a decision about what it
should DO before it is wired:

| Setting | Default | The decision |
|---|---|---|
| dip_agreement_mm | 5 mm | Require a second dip at close, and refuse if they differ by more? |
| require_second_approver_above | 500,000 | Which approvals - expenses, write-offs, recoveries? |
| evidence_grace_hours | 24 | Flag readings whose photo has not arrived by then? |
| allow_dip_above_chart | off | A dip above the chart is ALWAYS refused. Allowing it means extrapolating the chart - which v1 did badly. |
| break_shift_on_price_change | on | The price break always cuts the shift. Turning it off would value litres at the wrong price. |

`allow_credit_sales` was in this list and is now enforced (migration 370).

`monthly_variance_pct` now marks a grade's loss in red on Management Reports, and
`max_shortage_carry` now WARNS when an attendant owing more is put on a nozzle
(migration 460). Neither blocks anything. Making the shortage limit a hard stop
is a one-line change in 460 - the decision is yours.

## Decisions taken in the November audit — yours to change

| decision | where | to change it |
|---|---|---|
| Station staff may write and read only their own station's records; head office, directors, auditors and anyone based at head office see all | 530, `Common/StationScope.cs` | — |
| A station's managers and supervisors may also work a **depot** of the same company (the depot runs on shift permissions today) | 530 `fn_station_scope_ok` | drop the depot line once the depot has its own staff |
| A **relief supervisor** who covers several stations is refused at the second one | 530 | base them at head office, or add a list of extra stations |
| A stock variance over the litres cap is CRITICAL; inside the cap but over the percentage is a WARNING | 550 | both tolerances are in Administration → Trading policy |
| A price change already due when a shift opens takes effect at that opening | 560 | — |
| A transfer from a tank with no recorded cost is refused rather than priced at 0 | 540 | record opening balances with a cost |
| Shifts are named **DAY, MID or NIGHT** — Kiboga's three. Morning/Afternoon were mock names and are gone; an expense carries no shift (the table has none), so the expenses screen no longer shows one | 570 | widen the check in a new migration |
| **Cash drops** (Kenserve's Cash Drop Book): an attendant drops cash in the safe during the shift, witnessed by a supervisor or manager of that station; a drop is never edited, only voided with a reason; none after the shift starts counting. At close, "cash" means what the attendant **still holds** — every drop is already counted | 580, `CashDropService.cs`, `CashDropsPanel.tsx` | — |
| The **cap** (default UGX 500,000, Administration → policy) is on the most cash an attendant **carried**: their largest drop (what they walked to the safe with) or the cash at close (carried since the last drop). Over it raises a WARN, CASH_HELD_OVER_CAP. Read from the record, not estimated | 580, 590 | set the cap, or 0 to turn it off |
| A stock variance within **dipstick noise** (default 10 L) is not raised, whatever its percentage — 0.5% of a quiet 400 L night is 2 L, finer than a stick reads | 590 | Administration → policy |
| **Agreed customer prices**: a credit customer may be billed a fixed price or the pump price ± a margin, set by a manager or head office, never edited or backdated. The attendant still answers for the pump value; the close settles the difference as a PRICE_AGREEMENT line. Below the pump it counts with discounts on the profit statement; a premium above it reduces them | 600, `CustomerPriceService.cs`, `CustomerPricesModal.tsx` | — |
| The **dev server** (`deploy/`) runs demo data only, with every operator on one password and no forced change | `deploy/` | never point it at real data |
| **The books**: a double-entry ledger posted by the operations themselves, in the same transaction; balanced, never edited (reversed instead), written only by its own functions. A shift posts when declared. Stock at moving average from the ledger, brought to the dip at every close. Every rule is in `docs/BOOKS.md` | 610, 620, `BooksService.cs`, `/books` | — |
| **Bank and mobile money against their statements**: CSV import (deduplicated), automatic matching (bank 1:1 within 5 days; MoMo by shift window, then by day), manual match only when both sides sum equal, charges posted from the statement line. Reconciled = nothing unmatched on the statement and no book item older than 5 days. MoMo withdrawals recorded as transfers, fee to 6100 | 630, `MoneyAccountService.cs`, Books → Bank & mobile money | — |
| **Year end**: refused until the year's months are closed; one 31 December journal empties income and expense into 3100 per site; closes once. The P&L reads trading entries only so a closed year still shows its profit | 640, `BooksService.cs` | — |
| **Security audit, Nov 2026** (docs/AUDIT-2026-11.md): the ledger's definer functions check company and role themselves; the actor is always the signed-in user; journals cannot name another company's records; the app cannot call the posting machinery; statements and transfers are append-only; company bank accounts belong to head office, station accounts to their station; wallets reconcile by shift window before amount | 650, 660, 670, `db/test/security.sql` | — |
| Type errors do not stop a production build of the web app (`ignoreBuildErrors`) | `web/next.config.mjs` | turn it off once `npx tsc --noEmit` is clean on your machine |
