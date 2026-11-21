#!/usr/bin/env bash
# =============================================================================
# Runs once, the first time the database container starts with an empty
# volume (the postgres image runs /docker-entrypoint-initdb.d/*.sh).
#
#   1. the roles the migrations expect -- fcms_app with FCMS_APP_PASSWORD
#   2. the database, restored from the simulated months (db/sim/fcms_sim.dump):
#      demo data only, made by tools/sim -- never a real station's
#   3. every operator's password set to DEMO_PASSWORD, with "change it at first
#      sign-in" OFF: on a shared demo, the first visitor would otherwise lock
#      everyone else out
# =============================================================================
set -euo pipefail
: "${FCMS_APP_PASSWORD:?set FCMS_APP_PASSWORD}"
: "${DEMO_PASSWORD:?set DEMO_PASSWORD}"
DUMP="${FCMS_DEMO_DUMP:-/fcms/fcms_sim.dump}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -v app_pw="$FCMS_APP_PASSWORD" <<'SQL'
CREATE ROLE fcms_app LOGIN PASSWORD :'app_pw';
CREATE ROLE fcms_auth NOLOGIN BYPASSRLS;
CREATE ROLE fcms_readonly NOLOGIN;
CREATE ROLE fcms_platform NOLOGIN BYPASSRLS;
CREATE ROLE fcms_ledger NOLOGIN BYPASSRLS;   -- owns the books' posting functions (610)
CREATE DATABASE fcms;
SQL

# With owners: SECURITY DEFINER functions belong to fcms_auth / fcms_platform,
# and must stay theirs.
pg_restore --exit-on-error --username "$POSTGRES_USER" -d fcms "$DUMP"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d fcms -v pw="$DEMO_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- bcrypt, cost 12, as the API's own --set-password makes them.
SELECT fn_set_password('ALL', crypt(:'pw', gen_salt('bf', 12))) AS operators;
UPDATE staff_credential SET must_change = FALSE;
SELECT 'demo ready: ' || count(*) || ' shifts, ' || min(business_date) || ' to ' || max(business_date)
  FROM shift;
SQL
