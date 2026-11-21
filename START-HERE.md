# FCMS — start here

The one guide to running FCMS on Ubuntu, from an empty machine to a closed
shift. `TEST.md` walks through the screens; `docs/BOOKS.md` is the accounting; `HANDOVER.md` lists what is
decided and what is not; `docs/LIVE-FUNCTIONS.md` says where each database
function really lives.

---

## 0. What you need (once)

```bash
sudo apt install postgresql-16 postgresql-client-16    # the database
# .NET 8 SDK:  https://learn.microsoft.com/dotnet/core/install/linux-ubuntu
# Node 20 or newer:  https://nodejs.org  (or: sudo apt install nodejs npm)
psql --version && dotnet --version && node --version
```

FCMS expects PostgreSQL on **port 5544**. If yours is on the default 5432,
use 5432 everywhere below (`PGPORT=5432`).

## 1. Unpack into a fresh folder

```bash
cd ~/Desktop/code/FORCOURT
mv fcms-v2 fcms-v2-old-$(date +%Y%m%d) 2>/dev/null   # keep the old one aside
tar -xzf ~/Downloads/fcms-v2-<NAME>.tar.gz
cp fcms-v2-old-*/api/.env fcms-v2/api/.env 2>/dev/null || cp fcms-v2/api/.env.example fcms-v2/api/.env
cd fcms-v2
```

A fresh folder, not on top of the old one: unpacking never deletes, so files
this version removed would linger and break the build.

If `api/.env` is new, edit it:

* `FCMS_DB` — the `fcms_app` password you use.
* `Auth__SigningKey` — at least 32 characters; make one with `openssl rand -base64 48`.
  A shorter key is refused at start-up, on purpose.
* `Errors__ShowDatabaseDetail=true` while testing (full database errors on
  screen); `false` before real stations use it.

## 2. Tell the tools where the database is (every new terminal)

```bash
export PGHOST=localhost PGPORT=5544 PGUSER=postgres
export PGPASSWORD='your-postgres-password'
```

Keep the single quotes. Test it with `psql -d postgres -c "select 1"` — it
should print `1`. "password authentication failed" means the password is wrong.

## 3. Check everything — one command

```bash
./check-all.sh
```

It builds a scratch database (`fcms_check`, your real one is untouched) and
runs, in order:

| step | what it proves |
|---|---|
| 1 | all migrations apply; **101 integrity tests** — every rule the database promises |
| 1b | every SQL statement in the API names only things the database has |
| 1c | every query returns exactly the columns its C# class expects |
| 1d | the demo data loads, and the demo day **carries on correctly**: cash is dropped to the safe and counted at close, a delivery is received, the night shift closes with every attendant balanced, a supervisor cannot approve and a manager can, the next shift sells at the price that fell due, and the books balance with every reconciliation agreeing |
| 1e | 14 simulated days trade through the real functions, and every planted loss and shortage is caught |
| 2 | 18 static checks on the code |
| 3–4 | the web app installs and type-checks |
| 5 | executed checks on the client, the costing, dates, buttons |
| 6 | the API compiles with warnings as errors |

It ends with a summary. **Paste the summary back**, and the log for anything
that failed.

## 4. Build your working database

Stop the API first if it is running.

```bash
cd db
dropdb --if-exists fcms && createdb fcms
./migrate.sh test                         # ends:  101 | 0 | 101
psql -d fcms -f seed/one_station.sql
psql -d fcms -f seed/depot.sql
psql -d fcms -f seed/demo_day.sql
psql -d fcms -f test/scenarios.sql        # optional: ALL SCENARIOS PASS (it rolls back)
psql -d fcms -f test/security.sql         # optional: ALL 19 ATTACKS BLOCKED (it rolls back)
cd ..
```

### Or: three months of trading instead of the one demo day

`db/sim/fcms_sim.dump` is 90 days at the demo station: 180 shifts, about 2,000
cash drops, deliveries, 7 price changes, credit customers paying, banking,
bills, three real fuel losses and eleven short cash-ups for the system to
catch. Every row went through the real functions at the moment it happened
(`tools/sim/README.md` says how).

```bash
dropdb --if-exists fcms && createdb fcms
pg_restore --no-owner -d fcms db/sim/fcms_sim.dump
```

Use it in place of the three seed files above. Its last shift closed the day
it was made, so its dates are a few days old by the time you load it; make a
fresh one up to yesterday with `tools/sim/run.sh 90` (about 3 minutes).

### Or: the whole thing in Docker, openable from anywhere

`deploy/README.md`: database, API, web and HTTPS on one server, with the
simulated months as demo data. Three commands once Docker is installed.

## 5. Passwords, then the API (terminal 1)

```bash
cd api
dotnet build --no-incremental
dotnet run -- --set-password ALL 'ChangeMe123!'
dotnet run                                 # "Now listening on: http://localhost:5000"
```

## 6. The web app (terminal 2)

```bash
cd ~/Desktop/code/FORCOURT/fcms-v2/web
npm install
rm -rf .next && npm run dev               # open http://localhost:3000
```

## 7. Sign in

Password `ChangeMe123!` — you choose your own the first time.

| who | sign in as | sees |
|---|---|---|
| Supervisor | `SUP01` | their own station only |
| Manager | `MGR01`, `MGR02` | their own station; approves shifts |
| Accountant | `ACC01` | their own station's money and reports |
| Head office | `HO01` | every station, the depot, policy |
| System administrator | `SYSADMIN` | companies and sites |

## 8. What the demo leaves for you to do

The demo has run yesterday's day shift. Four things are waiting — the same
four `check-all.sh` proves in step 1d:

1. **Receive the delivery** DN-88213 (4,000 L of PMS on the note). Dip before
   and after, in litres.
2. **Drop cash, then close the night shift** as `SUP01` or `SUP02`. On Shift
   Operations, record a cash drop or two ("Cash drops to the safe"). Then close:
   every meter, every tank, and for each attendant only the cash **still held**.
   The drops are already counted.
3. **Approve it** as `MGR01` — a supervisor is refused, and so is whoever
   closed it.
4. **Open the next shift.** The PMS rise to 5,240 fell due while no shift was
   open; the new shift sells at 5,240.

## When something fails

| you see | it means |
|---|---|
| `password authentication failed` | `PGPASSWORD` is wrong, or still the placeholder |
| `Auth:SigningKey is too short` | make a key with `openssl rand -base64 48` |
| `OTHER_STATION` | that person is based at another station; only its people, or head office, can do it |
| `METER_IMPLAUSIBLE` | a reading implies more fuel than the pump can deliver in that time — check it |
| `NO_COST_BASIS` | the sending tank has no recorded cost; record its opening balance or a delivery |
| "reference: …" instead of an error | `Errors__ShowDatabaseDetail` is false; the full error is in the API's terminal under that reference |
