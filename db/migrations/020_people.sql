-- =============================================================================
-- FCMS v2 -- 020_people.sql
--
-- ATTENDANTS DO NOT SIGN IN.
--
-- That is not a UI decision, it is a data model decision, and it has a
-- consequence people usually miss: if an attendant never touches a keyboard,
-- then an attendant can never be the AUTHOR of a record either. Every reading,
-- every dip, every declaration is written by a supervisor ABOUT an attendant.
--
-- So this schema separates two ideas that v1 ran together in one `staff` table:
--
--   SUBJECT -- who the fuel and the money belong to.  Attendants. No password.
--   AUTHOR  -- who recorded it.  Supervisors and up.   Password, session, lockout.
--
-- The separation is enforced by a composite foreign key (see fn note below),
-- not by application checks -- so a bug in the API cannot produce a meter
-- reading signed by a man who has never logged in.
-- =============================================================================

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid REFERENCES site(id),        -- NULL = works across sites
  employee_no   text NOT NULL,
  full_name     text NOT NULL,
  role          staff_role NOT NULL,
  phone         text,
  national_id   text,
  hired_on      date,
  is_active     boolean NOT NULL DEFAULT TRUE,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- The whole rule, in one generated column. Change the role and the sign-in
  -- capability follows automatically; there is no second flag to fall out of
  -- step with the first.
  is_operator   boolean GENERATED ALWAYS AS (role <> 'ATTENDANT') STORED,

  UNIQUE (tenant_id, employee_no),

  -- This is what makes the composite FK below possible. Postgres will not
  -- reference a partial unique index, but it will reference this.
  UNIQUE (id, is_operator)
);

CREATE INDEX ON staff (site_id) WHERE is_active;
CREATE INDEX ON staff (tenant_id, role) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Credentials live in their own table, and only operators can have a row.
-- An attendant has no credential record to leak, reset, or brute-force.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_credential (
  staff_id        uuid PRIMARY KEY,
  is_operator     boolean NOT NULL DEFAULT TRUE CHECK (is_operator),
  password_hash   text NOT NULL,
  password_set_at timestamptz NOT NULL DEFAULT now(),
  must_change     boolean NOT NULL DEFAULT TRUE,
  last_login_at   timestamptz,
  failed_logins   int NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until    timestamptz,

  -- The composite FK. `is_operator` is pinned TRUE by the CHECK above, so this
  -- can only resolve against a staff row whose is_operator is also TRUE.
  -- Demote someone to ATTENDANT and the update fails while they still hold a
  -- credential -- which is the correct, loud behaviour.
  FOREIGN KEY (staff_id, is_operator) REFERENCES staff (id, is_operator)
);

COMMENT ON TABLE staff_credential IS
  'Only operators (role <> ATTENDANT) can hold credentials. Enforced by the '
  'composite FK against staff(id, is_operator), not by application code.';

-- ---------------------------------------------------------------------------
-- Sessions, so a dismissed supervisor can be cut off immediately.
--
-- v1 issued a 720-minute JWT with no refresh and no revocation list: someone
-- walked off the forecourt with up to twelve hours of valid access. Here the
-- token carries a session id, and killing the row kills the token.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  staff_id     uuid NOT NULL REFERENCES staff(id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES staff(id),
  revoke_reason text,
  ip_address   inet,
  user_agent   text,
  CHECK (expires_at > issued_at)
);
CREATE INDEX ON staff_session (staff_id, issued_at DESC);
CREATE INDEX ON staff_session (expires_at) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION fn_session_is_live(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM staff_session
                  WHERE id = p_session_id
                    AND revoked_at IS NULL
                    AND expires_at > now());
$$;

-- ---------------------------------------------------------------------------
-- AUTHORSHIP GUARD
--
-- Any table recording "who wrote this" carries a pinned TRUE column and a
-- composite FK to staff(id, is_operator). Apply it with this helper so every
-- table gets identical treatment and none is forgotten.
--
-- Used by 040 (assignments), 045 (dry stock), 050 (readings, ledger),
-- 060 (money), 070 (deliveries, counts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_require_operator_author(p_table text, p_column text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_flag text := p_column || '_is_operator';
BEGIN
  EXECUTE format(
    'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I boolean '
    'GENERATED ALWAYS AS (TRUE) STORED', p_table, v_flag);
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, %I) '
    'REFERENCES staff (id, is_operator)',
    p_table, p_table || '_' || p_column || '_is_operator_fk', p_column, v_flag);
END $$;

COMMENT ON FUNCTION fn_require_operator_author IS
  'Makes it structurally impossible for a non-signing-in attendant to appear '
  'as the author of a record.';

-- ---------------------------------------------------------------------------
-- Permissions. Read as: what can this role DO, not what screens can it see.
-- Kept in the database so an auditor can read the matrix without a build.
-- ---------------------------------------------------------------------------
CREATE TABLE role_permission (
  role       staff_role NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO role_permission (role, permission) VALUES
  ('SUPERVISOR','shift.open'), ('SUPERVISOR','shift.close'),
  ('SUPERVISOR','assignment.manage'), ('SUPERVISOR','reading.record'),
  ('SUPERVISOR','dip.record'), ('SUPERVISOR','pump_test.record'),
  ('SUPERVISOR','cashup.declare'), ('SUPERVISOR','credit_sale.record'),
  ('SUPERVISOR','delivery.receive'), ('SUPERVISOR','dry_sale.record'),

  ('MANAGER','shift.open'), ('MANAGER','shift.close'), ('MANAGER','shift.approve'),
  ('MANAGER','assignment.manage'), ('MANAGER','reading.record'),
  ('MANAGER','dip.record'), ('MANAGER','pump_test.record'),
  ('MANAGER','cashup.declare'), ('MANAGER','cashup.approve'),
  ('MANAGER','credit_sale.record'), ('MANAGER','credit_customer.manage'),
  ('MANAGER','discount.authorise'), ('MANAGER','shortage.approve'),
  ('MANAGER','price.execute'), ('MANAGER','delivery.receive'),
  ('MANAGER','delivery.approve'), ('MANAGER','stock_count.conduct'),
  ('MANAGER','exception.resolve'), ('MANAGER','dry_sale.record'),
  ('MANAGER','dry_stock.manage'),

  ('ACCOUNTANT','shift.approve'), ('ACCOUNTANT','cashup.approve'),
  ('ACCOUNTANT','banking.record'), ('ACCOUNTANT','credit_payment.record'),
  ('ACCOUNTANT','shortage.approve'), ('ACCOUNTANT','shortage.write_off'),
  ('ACCOUNTANT','stock_count.approve'), ('ACCOUNTANT','stock_count.post'),
  ('ACCOUNTANT','report.view'), ('ACCOUNTANT','exception.resolve'),

  ('AUDITOR','report.view'), ('AUDITOR','audit.view'),

  ('ADMIN','staff.manage'), ('ADMIN','equipment.manage'),
  ('ADMIN','site.configure'), ('ADMIN','policy.configure'),
  ('ADMIN','payment_channel.manage'), ('ADMIN','session.revoke'),
  ('ADMIN','report.view');

-- ATTENDANT appears nowhere on purpose. They hold no permissions because they
-- hold no session. Their name is on the fuel and the cash, not on the record.

CREATE OR REPLACE FUNCTION fn_has_permission(p_staff_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM staff s
      JOIN role_permission rp ON rp.role = s.role
     WHERE s.id = p_staff_id AND s.is_active AND rp.permission = p_permission);
$$;

-- ---------------------------------------------------------------------------
-- Authentication lookup.
--
-- Login is the one request that runs BEFORE a tenant is known, so it cannot be
-- filtered by tenant -- which means it cannot run under RLS. v1 solved this
-- with a BYPASSRLS role owning a narrow set of functions, and that was the
-- right call; it is kept here, deliberately as small as it can be.
--
-- These return only what authentication needs. Nothing here can read fuel,
-- money, or another tenant's business data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_auth_lookup(p_employee_no text)
RETURNS TABLE (
  staff_id uuid, tenant_id uuid, site_id uuid, full_name text,
  role staff_role, password_hash text, must_change boolean,
  failed_logins int, locked_until timestamptz, is_active boolean
) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT s.id, s.tenant_id, s.site_id, s.full_name, s.role,
         c.password_hash, c.must_change, c.failed_logins, c.locked_until, s.is_active
    FROM staff s
    JOIN staff_credential c ON c.staff_id = s.id
   WHERE s.employee_no = p_employee_no AND s.is_active;
$$;

CREATE OR REPLACE FUNCTION fn_auth_record_attempt(p_staff_id uuid, p_ok boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_ok THEN
    UPDATE staff_credential
       SET failed_logins = 0, locked_until = NULL, last_login_at = now()
     WHERE staff_id = p_staff_id;
  ELSE
    -- Exponential backoff after five failures. v1 had the columns and never
    -- wrote to them, so the login endpoint had no rate limit at all.
    UPDATE staff_credential
       SET failed_logins = failed_logins + 1,
           locked_until = CASE
             WHEN failed_logins + 1 >= 5
             THEN now() + (least(power(2, failed_logins - 3), 60) || ' minutes')::interval
           END
     WHERE staff_id = p_staff_id;
  END IF;
END $$;

ALTER FUNCTION fn_auth_lookup(text) OWNER TO fcms_auth;
ALTER FUNCTION fn_auth_record_attempt(uuid, boolean) OWNER TO fcms_auth;
REVOKE ALL ON FUNCTION fn_auth_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_auth_record_attempt(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_auth_lookup(text) TO fcms_app;
GRANT EXECUTE ON FUNCTION fn_auth_record_attempt(uuid, boolean) TO fcms_app;

DO $$
BEGIN
  PERFORM fn_require_operator_author('staff_session', 'revoked_by');
END $$;
