#!/usr/bin/env bash
# =============================================================================
# FCMS v2 — migrate.sh
#
# Applies migrations in order, once each, inside a transaction, and records a
# checksum of every file it applied. If a file that has already run is edited,
# the next run STOPS rather than silently applying a schema that no longer
# matches what the database was built from.
#
# Usage:
#   ./migrate.sh up          apply pending migrations
#   ./migrate.sh status      show what has run
#   ./migrate.sh test        apply, then run the integrity suite
#   ./migrate.sh reset       drop and rebuild (development only)
# =============================================================================
set -euo pipefail

DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"
DB_NAME="${PGDATABASE:-fcms}"
DB_USER="${PGUSER:-postgres}"
SCHEMA_DIR="$(cd "$(dirname "$0")" && pwd)/migrations"
TEST_DIR="$(cd "$(dirname "$0")" && pwd)/test"

# Force UTF-8 on the client. On Windows, psql defaults to the console code page
# (WIN1252), and any non-ASCII byte in a migration then fails with
# "character with byte sequence 0x.. has no equivalent in encoding UTF8".
# The migrations are pure ASCII now, but this makes the runner correct even if
# somebody adds a comment with an em-dash in it later.
export PGCLIENTENCODING=UTF8
# Never page. This script is run in CI as often as by a person.
export PAGER=cat

PSQL="psql -v ON_ERROR_STOP=1 -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -q"

# Order is explicit, not alphabetical. Alphabetical ordering is how a schema
# ends up with a file that references a table three migrations in its future.
MIGRATIONS=(
  010_foundation.sql
  020_people.sql
  040_shift.sql
  042_pricing.sql       # after 040: price_change and shift_price reference shift
  045_dry_stock.sql
  050_fuel_ledger.sql
  060_money_ledger.sql
  070_operations.sql
  080_security.sql      # RLS self-test must see every table
  090_admin.sql         # admin functions that run before a tenant is known
  100_directors_and_losses.sql   # DIRECTOR role, stock-loss views
  110_expenses_and_payables.sql  # what the station spends and owes
  120_credit_ageing.sql          # FIFO ageing and customer statements
  130_depot_and_transfers.sql    # depot bulk sales, internal transfers
  140_depot_day.sql              # depot open/close with the same invariant
  150_fixes_and_performance.sql  # depot receivables, credit limits, indexes
  160_system_admin.sql           # unrestricted role, and its limits
  170_draft_cashup_rebuild.sql   # a draft cash-up may be rebuilt, nothing else
  180_duty_period_links.sql      # shift ids on duty periods, tender breakdown
  190_dips_in_litres.sql         # dips entered in litres, no chart lookup
  200_supervisor_manager.sql     # manager covers supervisor, plus banking
  210_credit_limit_race.sql      # two sales at once cannot both pass the limit
  220_site_details.sql           # address, named manager, revenue target
  230_org_hierarchy.sql          # company, head office, the new roles
  240_org_rules.sql              # who creates whom; two managers to approve
  250_other_income.sql           # car wash, rent, tyres -- income that is not fuel
  260_rtt_types.sql              # RTT enum values (own file: cannot use them in the same tx)
  270_return_to_tank.sql         # RTT document, sign, and the close that deducts it
  280_controls_closed.sql        # appointment rule on the table; no over-recovery; water in litres
  290_platform_and_grants.sql    # grants the roles lacked; company creation past RLS, safely
  300_company_first_person.sql   # a company is created with the person who runs it
  310_auth_diagnosis.sql         # the log says WHY a login failed; the reply never does
  320_role_alignment.sql         # head office sets up equipment; approval matches the rule
  330_access_rules.sql           # revoking access follows the appointment rule; head office owns policy
  340_equipment_wiring_frozen.sql  # used tanks keep their product; used nozzles keep their wiring
  350_hot_path_indexes.sql       # four indexes the triggers and book stock read on every call
  360_cash_accountability.sql    # cash counted every way it moves; everyone who sold is cashed up
  370_credit_switch.sql          # "allow credit sales" is enforced, at the pump and the depot
  380_moving_average_cost.sql    # fuel costed by moving average, each past day as it ended
  390_shop_moving_average.sql    # shop stock costed by moving average, per station, as at the sale day
  400_price_break_timing.sql     # a price executed early takes effect when executed
  410_handover_billed.sql        # the attendant who handed over is billed for their litres
  420_daily_loss_is_a_change.sql  # a day's loss is the change in the gap, not the gap again
  430_close_variance_is_a_change.sql  # a shift is flagged for what IT lost, not for earlier losses
  440_one_account_per_customer.sql  # pump and depot credit are one account: limit, ageing, statement
  450_paid_ahead.sql             # money paid ahead is kept, and counts as room to buy
  460_shortage_carry_warning.sql  # rostering an attendant who owes over the limit warns
  470_handover_rollover.sql      # a handover rollover is ticked, never inferred
  480_credit_trigger_per_table.sql  # the credit switch no longer breaks every pump credit sale
  490_depot_day_opens.sql        # a depot day can be opened and closed at all
  500_depot_day_closes.sql       # ...and closed: a real state, a real column
  510_app_can_delete.sql         # roster, revoke and calibration saves work; their tables isolated
  520_credit_sale_attendant.sql  # credit is set against the attendant who pumped it
  530_station_scope.sql          # station staff write only their own station's records
  540_cost_includes_opening_stock.sql  # opening stock carries cost; nothing transfers at 0
  550_variance_severity.sql      # a small variance inside the cap is a warning, not critical
  560_due_price_applies_at_open.sql  # a price change due before a shift opens is its price
  570_mid_shift.sql              # DAY, MID and NIGHT shifts, as Kiboga runs them
  580_cash_drop.sql              # witnessed cash drops to the safe; cap on cash held
  590_close_rules_from_simulation.sql # cash carried between drops; dip noise floor
  600_customer_price.sql         # agreed prices for credit customers
  610_general_ledger.sql         # the books: chart, journals, postings from every event
  620_books_reports.sql          # trial balance, ledgers, receivables, controls, period close
  630_bank_reconciliation.sql    # bank and mobile money: accounts, transfers, statements, matching
  640_year_end.sql               # closing a year into retained earnings
  650_security_hardening.sql     # audit Nov 2026: tenant and actor checks in the books, append-only records
  660_money_scope.sql            # audit Nov 2026: bank and wallet accounts keep to their station
  670_wallet_match_order.sql     # audit Nov 2026: wallets matched by shift window before amount
  680_credit_ageing_depot.sql    # audit Nov 2026: customer balances count depot credit sales
)

ensure_ledger() {
  $PSQL <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migration (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user,
  duration_ms int
);
SQL
}

checksum() { sha256sum "$1" | cut -d' ' -f1; }

cmd_up() {
  ensure_ledger
  local applied=0
  for f in "${MIGRATIONS[@]}"; do
    local path="$SCHEMA_DIR/$f"
    [[ -f "$path" ]] || { echo "  ✗ missing: $f" >&2; exit 1; }
    local sum; sum=$(checksum "$path")
    local recorded
    recorded=$($PSQL -tA -c \
      "SELECT checksum FROM schema_migration WHERE filename = '$f'" || true)

    if [[ -n "$recorded" ]]; then
      if [[ "$recorded" != "$sum" ]]; then
        cat >&2 <<EOF

  ✗ $f has changed since it was applied.

    The database was built from a different version of this file. Applying it
    again would not undo what the old version did. Either restore the file, or
    write a new migration that makes the change you intended.
EOF
        exit 1
      fi
      echo "  · $f (already applied)"
      continue
    fi

    echo -n "  → $f "
    local start; start=$(date +%s%3N)
    $PSQL -1 -f "$path"
    local ms=$(( $(date +%s%3N) - start ))
    $PSQL -c "INSERT INTO schema_migration (filename, checksum, duration_ms)
              VALUES ('$f', '$sum', $ms)"
    echo "(${ms}ms)"
    applied=$((applied + 1))
  done
  echo
  echo "  $applied applied, ${#MIGRATIONS[@]} total."
}

cmd_status() {
  ensure_ledger
  $PSQL -c "SELECT filename, applied_at, duration_ms
              FROM schema_migration ORDER BY applied_at"
}

cmd_test() {
  cmd_up
  echo
  echo "  Running integrity suite…"
  psql -q -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
       -d "$DB_NAME" -f "$TEST_DIR/integrity.sql"
}

cmd_reset() {
  read -rp "  Drop and rebuild $DB_NAME? This destroys all data. [y/N] " ok
  [[ "$ok" == "y" ]] || { echo "  cancelled."; exit 0; }
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
       -c "DROP DATABASE IF EXISTS $DB_NAME" \
       -c "CREATE DATABASE $DB_NAME"
  cmd_up
}

case "${1:-up}" in
  up)     cmd_up ;;
  status) cmd_status ;;
  test)   cmd_test ;;
  reset)  cmd_reset ;;
  *)      echo "usage: $0 {up|status|test|reset}" >&2; exit 2 ;;
esac
