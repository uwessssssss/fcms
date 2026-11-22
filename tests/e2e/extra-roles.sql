-- =============================================================================
-- The roles the 90-day demo has nobody in, so the end-to-end test can sign in
-- as each: a director and an auditor at head office, and a manager at the
-- depot. Run after deploy/db/10-fcms-demo.sh; -v pw=the demo password.
-- =============================================================================
\set ON_ERROR_STOP 1
INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role, is_active)
SELECT s.tenant_id, s.id, v.no, v.name, v.role::staff_role, TRUE
  FROM (VALUES ('DIR01', 'Demo Director', 'DIRECTOR', 'HEAD_OFFICE'),
               ('AUD01', 'Demo Auditor', 'AUDITOR', 'HEAD_OFFICE'),
               ('DEP01', 'Demo Depot Manager', 'MANAGER', 'DEPOT')) v(no, name, role, kind)
  JOIN site s ON s.kind = v.kind::site_kind
ON CONFLICT DO NOTHING;
SELECT fn_set_password('ALL', crypt(:'pw', gen_salt('bf', 12)));
UPDATE staff_credential SET must_change = FALSE;
SELECT 'e2e roles: ' || string_agg(employee_no || ' ' || role, ', ' ORDER BY employee_no)
  FROM staff WHERE employee_no IN ('DIR01', 'AUD01', 'DEP01');
