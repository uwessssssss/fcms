#!/usr/bin/env bash
# =============================================================================
# Replay a month of Kiboga station's workbook through FCMS, and reconcile.
#
#   tools/replay/run.sh /path/to/KIBOGA_STATION_OCTOBER_2026.xlsx 2026-10
#
# Same throwaway server and moved clock as tools/sim (see its README). Writes
# tools/replay/out/station-<month>.md -- the reconciliation -- and
# db/sim/fcms_replay_<month>.dump. The workbook's figures stay on this machine.
# =============================================================================
set -euo pipefail
BOOK="$1"; MONTH="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || dirname "$(command -v pg_ctl)")}"
WORK="${SIM_WORK:-/tmp/fcms-replay}"; PORT="${SIM_PORT:-5547}"
export SIMCLOCK_FILE="$WORK/clock.offset" SIM_PORT="$PORT" REPLAY_DB=fcms_replay
AS=""; if [ "$(id -u)" = 0 ]; then AS="su postgres -c"; fi
run_pg() { if [ -n "$AS" ]; then $AS "$*"; else bash -c "$*"; fi; }
stop() { run_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -m fast stop" >/dev/null 2>&1 || true; }
trap stop EXIT
mkdir -p "$HERE/out"

echo "== reading the workbook"
python3 -I "$HERE/extract_station.py" "$BOOK" "$MONTH" > "$WORK.json.tmp"
rm -rf "$WORK"; mkdir -p "$WORK"; mv "$WORK.json.tmp" "$WORK/station.json"

echo "== a throwaway server, clock at the start of $MONTH"
gcc -shared -fPIC -O2 -o "$WORK/simclock.so" "$REPO/tools/sim/simclock.c" -ldl
python3 - "$SIMCLOCK_FILE" "$MONTH" <<'PY'
import datetime as dt, struct, sys, time
from zoneinfo import ZoneInfo
y, m = map(int, sys.argv[2].split("-"))
start = dt.datetime(y, m, 1, 3, tzinfo=ZoneInfo("Africa/Kampala")) - dt.timedelta(days=1)
open(sys.argv[1], "wb").write(struct.pack("<q", int((start.timestamp() - time.time()) * 1e6)))
PY
chmod -R a+rwX "$WORK"
run_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres -A trust >/dev/null"
run_pg "SIMCLOCK_FILE='$SIMCLOCK_FILE' LD_PRELOAD='$WORK/simclock.so' '$PGBIN/pg_ctl' -D '$WORK/data' \
        -o '-p $PORT -k $WORK -c timezone=Africa/Kampala' -l '$WORK/server.log' -w start" >/dev/null
export PGHOST=localhost PGPORT="$PORT" PGUSER=postgres; unset PGPASSWORD PGDATABASE
createdb fcms_replay
( cd "$REPO/db" && PGDATABASE=fcms_replay PGOPTIONS="-c client_min_messages=warning" ./migrate.sh 2>&1 | grep -v NOTICE | tail -1 )
psql -X -q -v ON_ERROR_STOP=1 -d fcms_replay -f "$HERE/kiboga_station_seed.sql" >/dev/null

echo "== replaying"
python3 "$HERE/replay_station.py" "$WORK/station.json" "$WORK/replay.json"

echo "== reconciling"
python3 - "$SIMCLOCK_FILE" <<'PY'
import struct, sys; open(sys.argv[1], "r+b").write(struct.pack("<q", 0))
PY
python3 "$HERE/reconcile.py" "$WORK/station.json" "$WORK/replay.json" "$MONTH" > "$HERE/out/station-$MONTH.md"
pg_dump -Fc -d fcms_replay -f "$REPO/db/sim/fcms_replay_$MONTH.dump"
echo "== wrote tools/replay/out/station-$MONTH.md"
sed -n '1,40p' "$HERE/out/station-$MONTH.md"
