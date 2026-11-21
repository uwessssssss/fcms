-- =============================================================================
-- FCMS v2 -- 010_foundation.sql
-- Extensions, enums, tenancy, sites, products, equipment.
--
-- Design rule for the whole schema: a wrong state should be UNREPRESENTABLE,
-- not merely detected. Where that is impossible in DDL, it is a deferred
-- constraint trigger. Application code is never the last line of defence.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles, first.
--
-- These must exist before ANY migration can grant to them or hand a function's
-- ownership over -- 020 makes fn_auth_lookup owned by fcms_auth, and that fails
-- outright if the role is not there yet. They lived in 080 originally, which is
-- last, so the schema could not build from empty.
--
--   fcms_app       runs the application, subject to every RLS policy
--   fcms_auth      NOLOGIN, BYPASSRLS, owns only the two SECURITY DEFINER
--                  functions that authentication needs before a tenant is known
--   fcms_readonly  reporting and audit
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcms_app') THEN
    CREATE ROLE fcms_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcms_auth') THEN
    CREATE ROLE fcms_auth NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcms_readonly') THEN
    CREATE ROLE fcms_readonly LOGIN;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE staff_role AS ENUM (
  'ATTENDANT',      -- pumps fuel; does not sign in to the system
  'SUPERVISOR',     -- opens/closes shifts, assigns nozzles, takes cash
  'MANAGER',        -- approves shifts, price breaks, write-offs
  'ACCOUNTANT',     -- posts, reconciles, banks
  'AUDITOR',        -- read-only, everything, forever
  'ADMIN'           -- tenant configuration
);

CREATE TYPE shift_state AS ENUM (
  'OPEN',           -- fuel is flowing
  'COUNTING',       -- closing readings being captured; dispensing halted
  'DECLARED',       -- readings + cash in, arithmetic complete
  'APPROVED',       -- a manager accepted the variances
  'POSTED',         -- immutable; feeds the ledgers downstream
  'VOID'            -- opened in error, never traded
);

CREATE TYPE close_reason AS ENUM (
  'SCHEDULED', 'PRICE_CHANGE', 'STOCK_TAKE', 'DELIVERY', 'INCIDENT', 'HANDOVER'
);

-- Every way a litre can enter or leave a tank. Adding a value here forces you
-- to decide its sign in fn_movement_sign() -- you cannot add an unaccounted
-- movement kind by accident.
CREATE TYPE movement_kind AS ENUM (
  'OPENING_BALANCE',   -- + commissioning / first stock take only
  'DELIVERY_IN',       -- + received from depot
  'METER_OUT',         -- - through a nozzle (sales, tests and metered own-use)
  'TEST_RETURN_IN',    -- + test can decanted back
  'BULK_OUT',          -- - drawn without passing a meter (generator, transfer)
  'BULK_IN',           -- + received from another station, not via depot
  'WATER_DRAW_OUT',    -- - water pumped out during maintenance
  'STOCK_TAKE_ADJUST', -- +/- the counted truth replaces the book
  'CORRECTION'         -- +/- reverses a prior movement, always paired
);

-- How metered fuel is classified once it has left the tank. The three must
-- sum to exactly the metered volume: that is the "every drop" invariant.
CREATE TYPE disposition_kind AS ENUM ('SALE', 'PUMP_TEST', 'OWN_USE');

CREATE TYPE settlement_kind AS ENUM (
  'CASH', 'MOBILE_MONEY', 'CARD', 'VOUCHER',
  'CREDIT',            -- fuel billed to a named customer account
  'DISCOUNT',          -- value forgiven at the pump
  'SHORTAGE',          -- attendant owes it; raises a receivable
  'OVERAGE'            -- attendant handed in more than sold
);

CREATE TYPE reading_source AS ENUM ('MANUAL', 'ELECTRONIC', 'ATG', 'IMPORT');
CREATE TYPE dip_context   AS ENUM ('SHIFT_OPEN','SHIFT_CLOSE','PRE_DELIVERY',
                                   'POST_DELIVERY','STOCK_TAKE','SPOT_CHECK');
CREATE TYPE evidence_state AS ENUM ('PRESENT','PENDING','WAIVED');
CREATE TYPE severity       AS ENUM ('INFO','WARN','CRITICAL');

-- ---------------------------------------------------------------------------
-- Request context. Set transaction-locally by the application:
--   SELECT set_config('app.tenant_id', $1, TRUE);   -- TRUE = txn-local
-- The v1 bug was passing FALSE here, which leaks across pooled connections.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.staff_id', TRUE), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  country_code   char(2) NOT NULL CHECK (country_code IN ('UG','KE','TZ','RW','SS','BI','CD')),
  base_currency  char(3) NOT NULL,
  default_tz     text NOT NULL DEFAULT 'Africa/Kampala',
  is_active      boolean NOT NULL DEFAULT TRUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every tolerance an auditor might argue about, in one row per tenant.
-- Nothing operational is hard-coded anywhere else in the system.
CREATE TABLE tenant_policy (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,

  -- wet stock: a variance must breach BOTH the percentage and the litre floor
  -- before it is tolerated. v1 checked percentage only, so a 400-litre loss on
  -- a zero-throughput tank passed.
  shift_variance_pct        numeric(6,4) NOT NULL DEFAULT 0.50,
  shift_variance_litres     numeric(10,2) NOT NULL DEFAULT 50.00,
  monthly_variance_pct      numeric(6,4) NOT NULL DEFAULT 0.20,

  -- dips
  dip_agreement_mm          numeric(6,1) NOT NULL DEFAULT 5.0,
  water_alarm_mm            numeric(6,1) NOT NULL DEFAULT 25.0,
  allow_dip_above_chart     boolean NOT NULL DEFAULT FALSE,  -- v1 silently invented 2%

  -- meters
  meter_divergence_pct      numeric(6,4) NOT NULL DEFAULT 0.10,
  pump_test_tolerance_pct   numeric(6,4) NOT NULL DEFAULT 0.50,

  -- deliveries
  transit_loss_pct          numeric(6,4) NOT NULL DEFAULT 0.30,
  post_decant_settle_min    int NOT NULL DEFAULT 30,

  -- cash
  cash_variance_alert       numeric(16,2) NOT NULL DEFAULT 20000,
  max_shortage_carry        numeric(16,2) NOT NULL DEFAULT 200000,
  require_second_approver_above numeric(16,2) NOT NULL DEFAULT 500000,

  -- policy switches
  break_shift_on_price_change  boolean NOT NULL DEFAULT TRUE,
  allow_credit_sales           boolean NOT NULL DEFAULT TRUE,
  evidence_grace_hours         int NOT NULL DEFAULT 24,

  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  ownership     text NOT NULL DEFAULT 'COCO' CHECK (ownership IN ('COCO','CODO','DODO')),
  timezone      text NOT NULL DEFAULT 'Africa/Kampala',
  -- The trading day boundary. A night shift that runs to 06:00 belongs to the
  -- previous business date; this is where that is decided, per site.
  day_starts_at time NOT NULL DEFAULT '06:00',
  is_active     boolean NOT NULL DEFAULT TRUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX ON site (tenant_id) WHERE is_active;

CREATE TABLE product (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,               -- PMS AGO IK LPG
  name         text NOT NULL,
  uom          text NOT NULL DEFAULT 'L' CHECK (uom IN ('L','KG')),
  is_wet_stock boolean NOT NULL DEFAULT TRUE,
  is_active    boolean NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- Equipment
-- ---------------------------------------------------------------------------
CREATE TABLE tank (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  product_id     uuid NOT NULL REFERENCES product(id),
  code           text NOT NULL,
  nominal_litres numeric(12,2) NOT NULL CHECK (nominal_litres > 0),
  safe_fill      numeric(12,2) NOT NULL CHECK (safe_fill > 0),
  dead_stock     numeric(12,2) NOT NULL DEFAULT 0 CHECK (dead_stock >= 0),
  max_dip_mm     numeric(7,1) NOT NULL,
  has_atg        boolean NOT NULL DEFAULT FALSE,
  atg_ref        text,
  commissioned_on date,
  is_active      boolean NOT NULL DEFAULT TRUE,
  UNIQUE (site_id, code),
  CHECK (safe_fill <= nominal_litres),
  CHECK (dead_stock < safe_fill)
);
CREATE INDEX ON tank (site_id) WHERE is_active;

-- Straight from the calibration certificate. Interpolation NEVER extrapolates
-- past the ends: a dip outside the chart is a misread or an overfill, and
-- inventing volume for it is how phantom stock is born.
CREATE TABLE tank_calibration (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  tank_id   uuid NOT NULL REFERENCES tank(id) ON DELETE CASCADE,
  dip_mm    numeric(7,1) NOT NULL CHECK (dip_mm >= 0),
  litres    numeric(12,2) NOT NULL CHECK (litres >= 0),
  PRIMARY KEY (tank_id, dip_mm)
);

CREATE TABLE pump (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  site_id    uuid NOT NULL REFERENCES site(id),
  code       text NOT NULL,
  make       text,
  serial_no  text,
  is_active  boolean NOT NULL DEFAULT TRUE,
  UNIQUE (site_id, code)
);

CREATE TABLE nozzle (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  pump_id       uuid NOT NULL REFERENCES pump(id),
  tank_id       uuid NOT NULL REFERENCES tank(id),
  code          text NOT NULL,
  -- Integer digits on the mechanical totalizer, EXCLUDING decimals. The
  -- rollover point is 10^integer_digits. v1 conflated this with the stored
  -- numeric scale and computed wraps wrong.
  integer_digits  int NOT NULL DEFAULT 6 CHECK (integer_digits BETWEEN 4 AND 10),
  decimal_digits  int NOT NULL DEFAULT 2 CHECK (decimal_digits BETWEEN 0 AND 3),
  max_flow_lpm  numeric(6,2) NOT NULL DEFAULT 50 CHECK (max_flow_lpm > 0),
  is_active     boolean NOT NULL DEFAULT TRUE,
  UNIQUE (pump_id, code)
);
CREATE INDEX ON nozzle (tank_id);
CREATE INDEX ON nozzle (site_id) WHERE is_active;

-- A nozzle dispenses whatever its tank holds. There is no separate product on
-- the nozzle to fall out of step -- v1 had one and needed a trigger to keep the
-- two in agreement. Removing the column removes the class of bug.
CREATE VIEW nozzle_product AS
  SELECT n.id AS nozzle_id, n.tenant_id, n.site_id, n.tank_id,
         t.product_id, p.code AS product_code
    FROM nozzle n
    JOIN tank t    ON t.id = n.tank_id
    JOIN product p ON p.id = t.product_id;

-- A nozzle and its tank must sit at the same site.
CREATE OR REPLACE FUNCTION trg_nozzle_site_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT site_id FROM tank WHERE id = NEW.tank_id) IS DISTINCT FROM NEW.site_id
  OR (SELECT site_id FROM pump WHERE id = NEW.pump_id) IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION 'NOZZLE_SITE_MISMATCH: nozzle %, tank and pump must be at the same site', NEW.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER nozzle_site_matches
  AFTER INSERT OR UPDATE OF tank_id, pump_id, site_id ON nozzle
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION trg_nozzle_site_matches();
