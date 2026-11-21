#!/usr/bin/env bash
# One command, one report. Runs every check this project has, in order, keeps
# going past a failure, and ends with a summary to paste back.
#
#   ./check-all.sh                    # needs PostgreSQL on localhost:5544 (as in START-HERE.md)
#   PGPORT=5432 ./check-all.sh        # if yours is elsewhere
set -u
cd "$(dirname "$0")"
export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-5544} PGUSER=${PGUSER:-postgres}
LOG="check-all-$(date +%Y%m%d-%H%M).log"
# Plain indexed arrays: macOS ships bash 3.2, which has no associative arrays.
NAMES=(); RESULTS=()
step() {  # name, command...
  local name=$1; shift
  echo; echo "================ $name ================" | tee -a "$LOG"
  NAMES+=("$name")
  if "$@" >>"$LOG" 2>&1; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); fi
  tail -n 4 "$LOG" | sed 's/^/   /'
}
step "1 database: fresh, migrate, 101 tests" bash -c '
  dropdb --if-exists fcms_check && createdb fcms_check &&
  cd db && PGDATABASE=fcms_check ./migrate.sh test'
step "1b every API statement prepares"      python3 tools/dbrun/prepare_all.py fcms_check
step "1c every query fills its class"        python3 tools/dbrun/columns.py fcms_check
step "1d demo data + business scenarios"     bash -c '
  cd db && for f in one_station depot demo_day; do
    psql -d fcms_check -v ON_ERROR_STOP=1 -q -f seed/$f.sql >/dev/null || exit 1
  done && psql -d fcms_check -X -v ON_ERROR_STOP=1 -f test/scenarios.sql'
step "1d2 attacks that must fail (security)" psql -d fcms_check -X -v ON_ERROR_STOP=1 -f db/test/security.sql
step "1e 14 simulated days, detection"   bash -c 'SIM_NO_DUMP=1 tools/sim/run.sh 14'
step "2 static checks (18)"               ./verify.sh
step "3 web: install"                     bash -c 'cd web && npm install --no-audit --no-fund'
step "4 web: type check"                  bash -c 'cd web && npx tsc --noEmit'
step "5 runtime checks (executed)"        tools/runtime/run.sh
step "6 api: dotnet build"                bash -c 'cd api && dotnet build -warnaserror'
echo; echo "================ SUMMARY ================" | tee -a "$LOG"
for i in "${!NAMES[@]}"; do
  printf "  %-40s %s\n" "${NAMES[$i]}" "${RESULTS[$i]}" | tee -a "$LOG"
done
echo; echo "Full output: $LOG -- paste the summary, and the log for anything that FAILED."
