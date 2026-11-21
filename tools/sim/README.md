# The simulator

Months of trading at the demo station, made by the system's own rules.

```bash
tools/sim/run.sh 90        # 90 days up to yesterday, about 3 minutes
```

Writes `db/sim/fcms_sim.dump`. Load it with
`createdb fcms && pg_restore --no-owner -d fcms db/sim/fcms_sim.dump`.

## Why a moved clock

Every function stamps rows with the database clock, and many rules depend on it:
a meter reading cannot rise faster than a pump delivers, a drop can be recorded
only while its shift is open, a price falls due at a time. Simulating 90 days
in one sitting would put every shift on the same afternoon, and the rules would
rightly refuse it. Backdating rows afterwards would edit history behind the
functions' backs.

So `run.sh` starts a **throwaway PostgreSQL server** (port 5546, its own data
folder under `/tmp/fcms-sim`) with `simclock.so` preloaded. It is about 40
lines of C that add an offset to the server's wall clock, read from a small
file. Before each action, `simulate.py` sets the offset to the moment the action
happened, and the real functions run unchanged. The server is stopped and
discarded at the end. **Your own server and data are never touched**, and
`simclock.so` must never be loaded into a server with real data.

## What runs

Each action runs as the app role (`fcms_app`), with `app.tenant_id` and
`app.staff_id` set, as the API does. Row-level security, the station scope,
grants and triggers all apply. Where the API calls a function, so does the
simulator: `fn_open_shift`, `fn_close_shift`, `fn_record_cash_drop` and
`fn_receive_delivery`. Where the API runs an INSERT, the simulator runs the same
INSERT, column for column. `simulate.py` names the service each one comes from.

A day: a DAY and a NIGHT shift, two attendants each, in rotation; hourly sales
on nine nozzles; cash dropped on reaching about 400,000; mobile money, card and
credit; a morning pump test; shop sales and a weekly restock; deliveries when
a tank runs low; price changes every 9–15 days; banking, bills and customer
payments the next morning.

It plants trouble: a fuel loss in about 1 shift in 40, a short cash-up in about
1 in 20, and an attendant who stops dropping cash in about 1 in 20. At the end
it checks that the system caught every loss and every shortage, raised no
stock alarm on dip noise alone, and raised no more over-cap flags than were
planted. `check.sql` then checks the books: every shift approved, every cash-up
balanced, every drop settled once, every litre costed, no tank negative, and
nothing banked that was not taken.

`check-all.sh` step 1e runs 14 days of this.

## Limits

* The depot only trades as its seed sets it up. Depot days, bulk sales and
  transfers are not simulated yet.
* Volumes and prices are shaped on Kiboga's August 2026 figures, at roughly
  2,100 L a day. The Kiboga replay checks against the real books. This
  simulator checks that the rules hold over time.
* Needs `gcc`, `python3` and the PostgreSQL 16 server binaries
  (`sudo apt install postgresql-16 gcc python3`).
