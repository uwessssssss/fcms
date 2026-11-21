-- =============================================================================
-- FCMS v2 -- 510_app_can_delete.sql
--
-- THREE BUTTONS THAT FAILED EVERY TIME. fcms_app -- the role the API connects
-- as -- is granted SELECT, INSERT and UPDATE on every table, and DELETE on two.
-- Three features delete as part of their normal work, and PostgreSQL checks
-- the privilege even when no row matches, so each failed on its FIRST use:
--
--   Save roster      DELETE FROM roster_template_line  (replace the lines)
--   Revoke access    DELETE FROM staff_credential      (remove the sign-in)
--   Save calibration DELETE FROM tank_calibration      (replace the chart)
--
-- The integrity suite runs as the superuser outside one block, so it could not
-- see a missing privilege. Found by checking every DELETE the API runs against
-- the grants (tools/dbrules/grants.py, now part of verify.sh).
--
-- Granting DELETE on the first two is not enough on its own: they have no
-- tenant_id, so no row-level security -- the app could have deleted ANOTHER
-- company's sign-in by guessing a staff id. Each now has a policy that sees a
-- row only through its tenant-scoped parent. The same is done for
-- supplier_invoice_delivery, the third table without a tenant_id, so an
-- invoice cannot be linked to another company's delivery.
--
-- The sign-in roles are unaffected: fcms_auth, which signs people in and sets
-- passwords, has BYPASSRLS.
-- =============================================================================

GRANT DELETE ON roster_template_line, staff_credential, tank_calibration TO fcms_app;

-- Roster lines: visible through their template; written only with this
-- company's nozzle and person (a foreign key alone would accept another's).
ALTER TABLE roster_template_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_template_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_line_via_template ON roster_template_line;
CREATE POLICY roster_line_via_template ON roster_template_line
  USING (EXISTS (SELECT 1 FROM roster_template t WHERE t.id = template_id))
  WITH CHECK (EXISTS (SELECT 1 FROM roster_template t WHERE t.id = template_id)
          AND EXISTS (SELECT 1 FROM nozzle n WHERE n.id = nozzle_id)
          AND EXISTS (SELECT 1 FROM staff s WHERE s.id = attendant_id));

-- Sign-ins: visible only for this company's people.
ALTER TABLE staff_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_credential FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credential_via_staff ON staff_credential;
CREATE POLICY credential_via_staff ON staff_credential
  USING (EXISTS (SELECT 1 FROM staff s WHERE s.id = staff_id))
  WITH CHECK (EXISTS (SELECT 1 FROM staff s WHERE s.id = staff_id));

-- Invoice-to-delivery links: both ends must be this company's.
ALTER TABLE supplier_invoice_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_link_via_parents ON supplier_invoice_delivery;
CREATE POLICY invoice_link_via_parents ON supplier_invoice_delivery
  USING (EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.id = invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.id = invoice_id)
          AND EXISTS (SELECT 1 FROM delivery d WHERE d.id = delivery_id));

-- The revoke rule treated an unseen person's role as NULL, and NOT NULL is
-- NULL, so the refusal never fired. Policies now hide such rows, but the rule
-- refuses outright as well.
CREATE OR REPLACE FUNCTION trg_credential_revoke_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_role  staff_role;
BEGIN
  IF v_actor IS NULL OR v_actor = OLD.staff_id THEN
    RETURN OLD;
  END IF;
  SELECT role INTO v_role FROM staff WHERE id = OLD.staff_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'STAFF_NOT_FOUND: no such person in this company'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT COALESCE(fn_may_create_staff(v_actor, v_role), FALSE) THEN
    RAISE EXCEPTION
      'MAY_NOT_REVOKE: only someone who could appoint a % may take away their '
      'access. Otherwise a manager could lock out the other manager -- the '
      'person who approves their shifts.', lower(v_role::text)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
