-- =============================================================================
-- FCMS v2 -- 300_company_first_person.sql
--
-- A company is created with the person who runs it.
--
-- 290 created the company, its policy, its head office and its income
-- categories -- and nobody. The result was a company no one could sign into,
-- and no way to fix it from the application: appointing someone into another
-- company is exactly the write row-level security refuses, so the system
-- administrator could create companies and never staff them.
--
-- The head office person is created in the SAME transaction. There is no
-- moment where a company exists without someone who may appoint its managers.
-- =============================================================================

GRANT INSERT ON staff TO fcms_platform;

DROP FUNCTION IF EXISTS fn_platform_create_company(
  text, text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION fn_platform_create_company(
  p_name text, p_legal_name text, p_registration_no text, p_tax_id text,
  p_country text, p_currency text, p_timezone text,
  p_head_office_name text, p_head_office_address text,
  p_admin_employee_no text, p_admin_full_name text, p_admin_phone text)
RETURNS TABLE (company_id uuid, head_office_id uuid, admin_staff_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_company uuid; v_ho uuid; v_admin uuid;
BEGIN
  PERFORM fn_platform_assert_admin();

  IF coalesce(btrim(p_head_office_name), '') = '' THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_REQUIRED: a company is created with its head office -- '
      'without one there is nobody who may appoint its managers.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(btrim(p_admin_employee_no), '') = ''
     OR coalesce(btrim(p_admin_full_name), '') = '' THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_PERSON_REQUIRED: name the person who will run this company. '
      'A company with no one in it cannot be signed into, and nobody can be '
      'added to it afterwards from inside the application.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO tenant (name, legal_name, registration_no, tax_id,
                      country_code, base_currency, default_tz, is_active)
  VALUES (p_name, p_legal_name, p_registration_no, p_tax_id,
          p_country, p_currency, p_timezone, true)
  RETURNING tenant.id INTO v_company;

  INSERT INTO tenant_policy (tenant_id) VALUES (v_company)
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO site (tenant_id, code, name, kind, address, timezone, day_starts_at, is_active)
  VALUES (v_company, 'HO', p_head_office_name, 'HEAD_OFFICE', p_head_office_address,
          p_timezone, '00:00', true)
  RETURNING site.id INTO v_ho;

  UPDATE tenant SET head_office_id = v_ho WHERE tenant.id = v_company;

  -- The person who runs it. HEAD_OFFICE, at the head office, in the same
  -- transaction: there is no moment where the company has nobody.
  INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role, phone)
  VALUES (v_company, v_ho, upper(btrim(p_admin_employee_no)), btrim(p_admin_full_name),
          'HEAD_OFFICE', nullif(btrim(p_admin_phone), ''))
  RETURNING staff.id INTO v_admin;

  INSERT INTO income_category (tenant_id, code, name)
  SELECT v_company, c.code, c.name
    FROM (VALUES ('CARWASH', 'Car wash'), ('TYRES', 'Tyre service'),
                 ('RENT', 'Rent received'), ('PARKING', 'Parking'),
                 ('OTHER', 'Other income')) AS c(code, name)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  RETURN QUERY SELECT v_company, v_ho, v_admin;
END $$;

ALTER FUNCTION fn_platform_create_company(
  text, text, text, text, text, text, text, text, text, text, text, text)
  OWNER TO fcms_platform;
REVOKE ALL ON FUNCTION fn_platform_create_company(
  text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_platform_create_company(
  text, text, text, text, text, text, text, text, text, text, text, text) TO fcms_app;

COMMENT ON FUNCTION fn_platform_create_company(
  text, text, text, text, text, text, text, text, text, text, text, text) IS
  'Creates a company, its policy, its head office, its first head office '
  'person and its income categories in one transaction. The password is set '
  'separately -- this function never touches credentials.';
