# FCMS v2 — Forecourt Control Management System

Built for petroleum stations in East Africa. Two guarantees, enforced by the
database rather than promised by the application:

- **Every drop of fuel is accounted for.** Fuel through a meter must be
  classified, to the litre, as a sale, a pump test or an authorised own-use
  draw. An unaccounted litre cannot be committed.
- **Every transaction reconciles.** A cash-up is a ledger that must sum to
  zero. Sales = cash + mobile money + card + credit + discounts + a declared
  shortage. If it does not balance, the shift does not close.

## Layout

```
db/
  migrations/   9 files, run in the order in migrate.sh (NOT alphabetical)
  seed/         one working station — Kiboga, 2 tanks, 4 nozzles, 10 dry SKUs
  test/         101 integrity tests; most assert a REFUSAL, some that legitimate work goes through
  migrate.sh    checksummed runner — edits to applied files stop the run
api/            .NET 8 minimal API
web/            Next.js client, offline-capable
tools/          five static checkers
docs/           audit, architecture, decisions, status
verify.sh       everything checkable without a database
```

## Running it

See **START-HERE.md** — one guide, from an empty machine to a closed shift.
`./check-all.sh` runs every check and prints a summary.

## Verification status — read this

`./verify.sh` runs four static checks and they all pass. That is **not** a
build. Honestly stated:

| | Verified how | Actually compiled? |
|---|---|---|
| SQL | reference/order checker | **no** — no Postgres available |
| C# | structure + SQL identifier checker | **no** — no .NET SDK available |
| `web/lib/*.ts` | `tsc --strict --noUncheckedIndexedAccess` | **yes** |
| `web/**/*.tsx` | reviewed only | **no** — React types unavailable |

The checkers caught six real bugs that would have failed on first run:

1. `030_pricing.sql` referenced `shift`, created in `040` → renumbered `042`
2. `ShiftEndpoints.cs` mixed a file-scoped and a block namespace (CS8955)
3. The dashboard linked to three routes that had no page — 404 on tap
4. The web app had no `package.json`, `next.config`, `tailwind.config` or
   `app/layout.tsx`. Eight correct screens; the application could not boot
5. The close screen had no mobile-money field, so an attendant would be short
   by exactly the MoMo amount every shift — v1's credit bug in a new coat
6. Two invented endpoints (`/api/setup/station`, `/api/shifts`) caught the
   moment the calling screen was written

Expect a first-build round on the C# — `TreatWarningsAsErrors` is on. The most
likely spots are Dapper's mapping of positional records and tuples
(`AuthRow`, and the tuple queries in `CreditService`/`ForecourtService`), and
the Npgsql enum registrations in `Program.cs`.

`tools/check_contract.py` is the one to put in CI. It does three comparisons no
single-sided check can do:

- **broken calls** — the frontend calls an endpoint that does not exist (a
  runtime 404). Fails the build.
- **dead links** — an `href` points at a route with no `page.tsx` (a 404 on tap).
  Fails the build.
- **uncalled endpoints** — the backend exposes something nothing calls. A
  warning, because it is legitimate mid-build, but it must never be invisible.

That last one is v1's worst bug: the credit-sale endpoint existed, was correct,
and had no caller — so no station selling on credit could ever close a balanced
shift. Both sides passed review. Only the comparison finds it.

## Deferred

Government compliance (URA/EFRIS, EPRA/eTIMS) is phase 2, by decision.
