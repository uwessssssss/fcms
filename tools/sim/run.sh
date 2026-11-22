#!/usr/bin/env bash
# =============================================================================
# FCMS -- months of simulated trading, through the real functions.
#
#   tools/sim/run.sh [days]            (default 90)
#
# Starts a THROWAWAY PostgreSQL server on port 5546 with a movable clock
# (simclock.so), builds a fresh database there from the migrations and the
# station + depot seeds, then trades day by day up to yesterday. Every action
# runs as the app role at the moment it "happened". At the end it checks the
# books (check.sql) and writes:
#
#   db/sim/fcms_sim.dump     -- pg_dump -Fc; load it into any PostgreSQL 16:
#                               createdb fcms_sim && pg_restore -d fcms_sim db/sim/fcms_sim.dump
#
# The clock trick touches ONLY this server, which is deleted afterwards. Your
# own database and server are never involved.
#
# Needs: PostgreSQL 16 server binaries, gcc, python3.  On Ubuntu:
#   sudo apt install postgresql-16 gcc python3
# =============================================================================
set -euo pipefail
DAYS="${1:-90}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || dirname "$(command -v pg_ctl)")}"
WORK="${SIM_WORK:-/tmp/fcms-sim}"
PORT="${SIM_PORT:-5546}"
export SIMCLOCK_FILE="$WORK/clock.offset" SIM_PORT="$PORT"

# Run the server as an ordinary user. As root (a container), use 'postgres'.
AS=""; if [ "$(id -u)" = 0 ]; then AS="su postgres -c"; fi
run_pg() { if [ -n "$AS" ]; then $AS "$*"; else bash -c "$*"; fi; }

stop() { run_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -m fast stop" >/dev/null 2>&1 || true; }
trap stop EXIT

echo "== building the clock"
rm -rf "$WORK"; mkdir -p "$WORK"
gcc -shared -fPIC -O2 -o "$WORK/simclock.so" "$HERE/simclock.c" -ldl
python3 - "$SIMCLOCK_FILE" "$DAYS" <<'PY'
import struct, sys, time
# Start the clock DAYS+2 days ago, 04:00 Kampala, for migrations and seeds.
days = int(sys.argv[2])
now = time.time()
start = now - (days + 2) * 86400
start = start - (start + 3 * 3600) % 86400 + 4 * 3600
open(sys.argv[1], "wb").write(struct.pack("<q", int((start - now) * 1e6)))
PY
chmod -R a+rwX "$WORK"

echo "== a throwaway server on port $PORT"
run_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres -A trust >/dev/null"
run_pg "SIMCLOCK_FILE='$SIMCLOCK_FILE' LD_PRELOAD='$WORK/simclock.so' '$PGBIN/pg_ctl' -D '$WORK/data' \
        -o '-p $PORT -k $WORK -c timezone=Africa/Kampala' -l '$WORK/server.log' -w start" >/dev/null
export PGHOST=localhost PGPORT="$PORT" PGUSER=postgres
unset PGPASSWORD PGDATABASE
psql -X -Atc "SELECT 'server clock: ' || now()"

echo "== database: migrations and the station + depot seeds"
createdb fcms_sim
( cd "$REPO/db" && PGDATABASE=fcms_sim PGOPTIONS="-c client_min_messages=warning" ./migrate.sh 2>&1 | grep -v NOTICE | tail -1 )
psql -X -q -v ON_ERROR_STOP=1 -d fcms_sim -f "$REPO/db/seed/one_station.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d fcms_sim -f "$REPO/db/seed/depot.sql" >/dev/null

echo "== trading $DAYS days"
python3 "$HERE/simulate.py" --days "$DAYS" --db fcms_sim --port "$PORT" --seed "${SIM_SEED:-2026}"

echo "== checking the books"
python3 - "$SIMCLOCK_FILE" <<'PY'
import struct, sys
open(sys.argv[1], "r+b").write(struct.pack("<q", 0))   # back to real time
PY
psql -X -v ON_ERROR_STOP=1 -d fcms_sim -f "$HERE/check.sql"

echo "== every closed shift recomputed from its readings"
psql -X -q -v ON_ERROR_STOP=1 -d fcms_sim -f "$REPO/tools/audit/shift_math.sql" | grep -E "SHIFT MATH|^ [A-Z][0-9]+b? " 

if [ -n "${SIM_NO_DUMP:-}" ]; then exit 0; fi
mkdir -p "$REPO/db/sim"
pg_dump -Fc -d fcms_sim -f "$REPO/db/sim/fcms_sim.dump"
echo "== wrote db/sim/fcms_sim.dump ($(du -h "$REPO/db/sim/fcms_sim.dump" | cut -f1))"
