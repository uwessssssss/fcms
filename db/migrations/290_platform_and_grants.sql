-- =============================================================================
-- FCMS v2 -- 290_platform_and_grants.sql
--
-- The organisation from 230-280 had rules and no one able to use them.
--
-- Found by checking the seed against it rather than by any test:
--
--   * SYSTEM_ADMIN never held `system.admin`. It mirrors every permission some
--     other role holds, and no role held that one -- so the Companies screen
--     and every company and site endpoint refused everybody, including the
--     system administrator.
--   * HEAD_OFFICE held no permissions at all. The role whose one job is
--     appointing managers could not reach the endpoint that does it.
--   * `staff.manage` was ADMIN's alone, so a manager could not staff their own
--     station -- which fn_may_create_staff explicitly allows.
--   * fn_may_create_staff did not know ADMIN, so when 280 put it on the table
--     as a trigger, ADMIN silently lost the ability to appoint anyone.
--   * Row-level security on `tenant` refuses a row whose id is not the
--     caller's own. Creating a company is, by definition, creating a row that
--     is not yours -- so even with the permission it could never succeed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The grants.
-- ---------------------------------------------------------------------------
INSERT INTO role_permission (role, permission)
VALUES ('SYSTEM_ADMIN', 'system.admin')
ON CONFLICT DO NOTHING;

-- Head office runs the company: everything a manager may do, at any of its
-- sites, plus appointing people. The mirror trigger passes these to
-- SYSTEM_ADMIN, which already holds them.
INSERT INTO role_permission (role, permission)
SELECT 'HEAD_OFFICE', permission FROM role_permission WHERE role = 'MANAGER'
ON CONFLICT DO NOTHING;
INSERT INTO role_permission (role, permission)
VALUES ('HEAD_OFFICE', 'staff.manage')
ON CONFLICT DO NOTHING;

-- A manager staffs their station. Safe ONLY because of 280's trigger: with
-- this permission a manager reaches /api/admin/staff, and it is the trigger --
-- not the route -- that stops them appointing or unseating a manager.
INSERT INTO role_permission (role, permission)
VALUES ('MANAGER', 'staff.manage')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Who may appoint whom -- now knowing ADMIN.
--
-- ADMIN was the original staff administrator, and 280's trigger stopped it
-- appointing anyone because this function did not list it. It may appoint
-- every operational role; it closes and approves no shifts, so appointing a
-- manager creates no one who reviews their own work.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_may_create_staff(p_creator uuid, p_new_role staff_role)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_role staff_role;
BEGIN
  SELECT role INTO v_role FROM staff WHERE id = p_creator;

  RETURN CASE
    WHEN v_role = 'SYSTEM_ADMIN' THEN TRUE
    WHEN v_role = 'HEAD_OFFICE'  THEN p_new_role IN
      ('MANAGER', 'ACCOUNTANT', 'SUPERVISOR', 'ATTENDANT', 'AUDITOR')
    WHEN v_role = 'ADMIN'        THEN p_new_role IN
      ('MANAGER', 'ACCOUNTANT', 'SUPERVISOR', 'ATTENDANT', 'AUDITOR')
    -- A manager staffs their station but never appoints their own reviewer.
    WHEN v_role = 'MANAGER'      THEN p_new_role IN ('SUPERVISOR', 'ATTENDANT')
    ELSE FALSE
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Deactivating someone is a decision about their role, too.
--
-- 280 covered appointing and changing a role. With staff.manage, a manager
-- could still switch the OTHER manager off -- is_active = false -- and leave
-- the site with one manager. They still could not approve their own shift, but
-- the reviewer would be gone. Now changing whether someone is active needs the
-- same authority as appointing them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_staff_appointment_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_name  text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.role IS NOT DISTINCT FROM NEW.role
     AND OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM staff WHERE id = v_actor;

  -- Active status changed, role did not.
  IF TG_OP = 'UPDATE' AND OLD.role IS NOT DISTINCT FROM NEW.role THEN
    IF NOT fn_may_create_staff(v_actor, OLD.role) THEN
      RAISE EXCEPTION
        'MAY_NOT_CHANGE_STATUS: % cannot switch a % on or off. Only someone who '
        'could have appointed them may -- otherwise a manager could switch off '
        'the other manager and remove their reviewer.',
        COALESCE(v_name, 'this account'), lower(OLD.role::text)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT fn_may_create_staff(v_actor, NEW.role) THEN
    RAISE EXCEPTION
      'MAY_NOT_APPOINT: % cannot appoint a %. A manager cannot appoint another '
      'manager -- the second manager is who approves the first one''s shifts.',
      COALESCE(v_name, 'this account'), lower(NEW.role::text)
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NOT fn_may_create_staff(v_actor, OLD.role) THEN
    RAISE EXCEPTION
      'MAY_NOT_CHANGE_ROLE: % cannot change the role of a %. Only someone who '
      'could have appointed them may move them -- otherwise a manager could '
      'demote the other manager and remove their own reviewer.',
      COALESCE(v_name, 'this account'), lower(OLD.role::text)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS staff_appointment_rule ON staff;
CREATE TRIGGER staff_appointment_rule
  BEFORE INSERT OR UPDATE OF role, is_active ON staff
  FOR EACH ROW EXECUTE FUNCTION trg_staff_appointment_rule();

-- ---------------------------------------------------------------------------
-- 4. THE PLATFORM: operations above any one company.
--
-- Row-level security stays absolute for everyone. Creating a company is the
-- one legitimate need to write a tenant row that is not your own, so it goes
-- through three functions owned by a narrow role that can pass the policy --
-- the same pattern as fcms_auth in 090 -- and each checks, IN THE DATABASE,
-- that the person calling is a system administrator.
--
-- BYPASSRLS gets past the policies; it does not grant the tables. 090 learned
-- that on the first login attempt. So fcms_platform gets exactly the tables
-- it writes and nothing else: no fuel, no money, no other company's business.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcms_platform') THEN
    CREATE ROLE fcms_platform NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fcms_platform;
GRANT SELECT ON staff, tenant, site, tenant_policy, income_category TO fcms_platform;
GRANT INSERT ON tenant, tenant_policy, site, income_category TO fcms_platform;
GRANT UPDATE (head_office_id) ON tenant TO fcms_platform;

CREATE OR REPLACE FUNCTION fn_platform_assert_admin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_role  staff_role;
BEGIN
  SELECT role INTO v_role FROM staff WHERE id = v_actor AND is_active;
  IF v_role IS DISTINCT FROM 'SYSTEM_ADMIN' THEN
    RAISE EXCEPTION
      'PLATFORM_ONLY: only a system administrator creates companies and sites, '
      'or sees every company. This account runs a company, not the platform.'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_platform_companies()
RETURNS TABLE (id uuid, name text, legal_name text, registration_no text,
               country_code text, base_currency text, head_office_id uuid,
               head_office_name text, site_count int, staff_count int,
               is_active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  PERFORM fn_platform_assert_admin();
  RETURN QUERY
  SELECT t.id, t.name, t.legal_name, t.registration_no,
         t.country_code::text, t.base_currency::text, t.head_office_id, ho.name,
         (SELECT count(*) FROM site s
           WHERE s.tenant_id = t.id AND s.kind <> 'HEAD_OFFICE')::int,
         (SELECT count(*) FROM staff st
           WHERE st.tenant_id = t.id AND st.is_active)::int,
         t.is_active
    FROM tenant t
    LEFT JOIN site ho ON ho.id = t.head_office_id
   ORDER BY t.name;
END $$;

CREATE OR REPLACE FUNCTION fn_platform_create_company(
  p_name text, p_legal_name text, p_registration_no text, p_tax_id text,
  p_country text, p_currency text, p_timezone text,
  p_head_office_name text, p_head_office_address text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company uuid; v_ho uuid;
BEGIN
  PERFORM fn_platform_assert_admin();

  IF coalesce(btrim(p_head_office_name), '') = '' THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_REQUIRED: a company is created with its head office -- '
      'without one there is nobody who may appoint its managers.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO tenant (name, legal_name, registration_no, tax_id,
                      country_code, base_currency, default_tz, is_active)
  VALUES (p_name, p_legal_name, p_registration_no, p_tax_id,
          p_country, p_currency, p_timezone, true)
  RETURNING tenant.id INTO v_company;

  -- The industry variance bands as a starting point, not a blank form.
  INSERT INTO tenant_policy (tenant_id) VALUES (v_company)
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO site (tenant_id, code, name, kind, address, timezone, day_starts_at, is_active)
  VALUES (v_company, 'HO', p_head_office_name, 'HEAD_OFFICE', p_head_office_address,
          p_timezone, '00:00', true)
  RETURNING site.id INTO v_ho;

  UPDATE tenant SET head_office_id = v_ho WHERE tenant.id = v_company;

  INSERT INTO income_category (tenant_id, code, name)
  SELECT v_company, c.code, c.name
    FROM (VALUES ('CARWASH', 'Car wash'), ('TYRES', 'Tyre service'),
                 ('RENT', 'Rent received'), ('PARKING', 'Parking'),
                 ('OTHER', 'Other income')) AS c(code, name)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  RETURN v_company;
END $$;

CREATE OR REPLACE FUNCTION fn_platform_create_site(
  p_company uuid, p_code text, p_name text, p_kind text, p_address text,
  p_timezone text, p_day_starts_at time, p_revenue_target numeric)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site uuid;
BEGIN
  PERFORM fn_platform_assert_admin();

  IF upper(p_kind) = 'HEAD_OFFICE' THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_ALREADY_EXISTS: a company has exactly one head office, made '
      'with the company. This adds trading sites: STATION or DEPOT.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO site (tenant_id, code, name, kind, address, timezone,
                    day_starts_at, revenue_target, is_active)
  VALUES (p_company, p_code, p_name, upper(p_kind)::site_kind, p_address,
          p_timezone, p_day_starts_at, p_revenue_target, true)
  RETURNING site.id INTO v_site;

  RETURN v_site;
END $$;

ALTER FUNCTION fn_platform_assert_admin() OWNER TO fcms_platform;
ALTER FUNCTION fn_platform_companies() OWNER TO fcms_platform;
ALTER FUNCTION fn_platform_create_company(text, text, text, text, text, text, text, text, text) OWNER TO fcms_platform;
ALTER FUNCTION fn_platform_create_site(uuid, text, text, text, text, text, time, numeric) OWNER TO fcms_platform;

REVOKE ALL ON FUNCTION fn_platform_assert_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_platform_companies() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_platform_create_company(text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_platform_create_site(uuid, text, text, text, text, text, time, numeric) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION fn_platform_companies() TO fcms_app;
GRANT EXECUTE ON FUNCTION fn_platform_create_company(text, text, text, text, text, text, text, text, text) TO fcms_app;
GRANT EXECUTE ON FUNCTION fn_platform_create_site(uuid, text, text, text, text, text, time, numeric) TO fcms_app;
-- fn_platform_assert_admin is called by the three above, which run as its
-- owner; the application never needs to call it directly.
GRANT EXECUTE ON FUNCTION fn_platform_assert_admin() TO fcms_platform;
