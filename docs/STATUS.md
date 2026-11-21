# FCMS v2 — Build Status

## What exists

| Layer | Files | Lines | Verified by |
|---|---|---|---|
| Schema | 9 migrations | ~3,400 | `check_schema.py` — clean |
| Integrity tests | 1 | ~430 | 26 tests, all assert refusal |
| Seed | 1 | ~250 | column-checked against schema |
| API | 10 C# files | ~2,200 | `check_api.py` — clean |
| Tooling | migrate.sh, 2 checkers | ~450 | self-running |

## API surface

| Endpoint | Purpose | Audit finding closed |
|---|---|---|
| `POST /api/auth/login` | rate-limited, session-backed JWT | H11 (12h tokens, no revocation) |
| `POST /api/auth/logout` | revokes the session row | H11 |
| `POST /api/auth/change-password` | kills all other sessions | — |
| `POST /api/shifts/open` | shift + prices + dips + roster, atomic | C8, C9 |
| `POST /api/shifts/{id}/close-preview` | real close in a SAVEPOINT | preview/actual drift |
| `POST /api/shifts/{id}/close` | one transaction, both ledgers | C3, C5, C6, C7, C9, H6 |
| `POST /api/shifts/{id}/approve` | segregation enforced | — |
| `GET /api/shifts/{id}` | derived totals, no stored copies | root fault |
| **`POST /api/credit/shifts/{id}/sales`** | **record credit sale** | **H1 — the big one** |
| `GET /api/credit/customers` | ageing + headroom | — |
| `POST /api/credit/payments` | receipts against the book | — |
| `GET /api/credit/customers/{id}/statement` | running statement | — |
| `POST /api/forecourt/shifts/{id}/pump-tests` | measured, not can size | C6 |
| `POST /api/forecourt/shifts/{id}/own-use` | metered vs bulk split | C5 |
| `POST /api/forecourt/dips` | refuses to extrapolate | dip clamping |
| `POST /api/forecourt/handover` | one reading, used twice | H5 |
| `GET /api/forecourt/exceptions` | what needs a human | H4 |

## Not built yet

- Deliveries, dry stock, banking, stock count endpoints (schema + functions exist;
  no HTTP surface)
- The entire Next.js frontend
- Offline outbox on the client (server side is ready — idempotency works)
- Reports beyond the shift detail view

## Verification honestly stated

Two static checkers run clean. Between them they have caught **two real bugs**
that would have failed on first run:

1. `030_pricing.sql` referenced `shift`, created in `040` → renumbered `042`
2. `ShiftEndpoints.cs` mixed a file-scoped and a block namespace (CS8955)

What they CANNOT catch, and what the first real run will:

- **SQL**: type mismatches, expression validity, trigger firing order, whether
  the deferred constraints actually fire where intended
- **C#**: type errors, nullable flow, Dapper's mapping of positional records
  (`AuthRow`, and the tuple-returning queries in `ForecourtService`/`CreditService`
  are the most likely to need adjustment), enum registration against real
  Postgres enum OIDs
- **Both**: anything about behaviour under concurrency

`TreatWarningsAsErrors` is on, so expect a first-build round.

## Run order

```bash
createdb fcms
./migrate.sh test                      # migrations + 26 integrity tests
psql -d fcms -f seed/one_station.sql   # one station, ready to trade

cp api/.env.example api/.env           # set FCMS_DB and Auth__SigningKey
cd api && dotnet build && dotnet run
```

A red integrity run means the schema does not enforce what it claims. Do not
deploy past one.
