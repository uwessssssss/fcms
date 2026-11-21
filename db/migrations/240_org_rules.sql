-- =============================================================================
-- FCMS v2 -- 240_org_rules.sql
--
-- The rules that make 230's shape mean something.
--
-- SEPARATE FILE ON PURPOSE. PostgreSQL will let you add a value to an enum
-- inside a transaction, but it will not let you USE that value in the same
-- transaction -- the new label is not visible to the snapshot that added it.
-- Every migration here runs in its own transaction, so 230 adds HEAD_OFFICE to
-- both enums and this file is the first that may refer to them.
--
-- Fold these two together and the migration fails with "unsafe use of new
-- value of enum type", which reads like a permissions problem and is not one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A head office does not trade.
--
-- It has no tanks, no pumps and no shifts. Without this, nothing would stop a
-- head office being rostered a nozzle, and every fuel figure in the company
-- would quietly include a site that sells nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_head_office_does_not_trade() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_kind site_kind;
BEGIN
  SELECT kind INTO v_kind FROM site WHERE id = NEW.site_id;

  IF v_kind = 'HEAD_OFFICE' THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_DOES_NOT_TRADE: a head office has no tanks, pumps or '
      'shifts. Create a STATION or a DEPOT for trading.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tank_not_at_head_office ON tank;
CREATE TRIGGER tank_not_at_head_office
  BEFORE INSERT OR UPDATE OF site_id ON tank
  FOR EACH ROW EXECUTE FUNCTION trg_head_office_does_not_trade();

DROP TRIGGER IF EXISTS pump_not_at_head_office ON pump;
CREATE TRIGGER pump_not_at_head_office
  BEFORE INSERT OR UPDATE OF site_id ON pump
  FOR EACH ROW EXECUTE FUNCTION trg_head_office_does_not_trade();

DROP TRIGGER IF EXISTS shift_not_at_head_office ON shift;
CREATE TRIGGER shift_not_at_head_office
  BEFORE INSERT OR UPDATE OF site_id ON shift
  FOR EACH ROW EXECUTE FUNCTION trg_head_office_does_not_trade();

-- ---------------------------------------------------------------------------
-- One head office per company.
--
-- Two would mean two answers to "who runs this company", and the question has
-- one answer or the hierarchy is decoration.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS one_head_office_per_company
  ON site (tenant_id)
  WHERE kind = 'HEAD_OFFICE';

ALTER TABLE tenant
  DROP CONSTRAINT IF EXISTS tenant_head_office_fk;
ALTER TABLE tenant
  ADD CONSTRAINT tenant_head_office_fk
  FOREIGN KEY (head_office_id) REFERENCES site(id);

-- ---------------------------------------------------------------------------
-- THE RULE THIS WHOLE MIGRATION EXISTS FOR.
--
-- A shift is closed by one manager and approved by ANOTHER MANAGER AT THE SAME
-- SITE.
--
-- The existing check only required the two people to differ. A supervisor and
-- a manager satisfy that -- and a supervisor approving the cash-up of the
-- supervisor who closed it is precisely the arrangement segregation of duties
-- exists to prevent. The letter held; the intent did not.
--
-- Three things are required, and each has cost somebody money somewhere:
--
--   DIFFERENT PERSON      the obvious one, and the only one that was enforced
--   BOTH MANAGERS         a junior cannot sign off a senior's shortage
--   SAME SITE             a manager at another station has not seen the cash,
--                         the tanks or the people, and their approval is a
--                         signature on something they cannot know
--
-- A site with one manager therefore cannot approve its own shifts. That is not
-- an oversight to work around -- it is the finding. Appoint a second manager,
-- or have head office approve.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_shift_approval_segregation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closer_role staff_role;
  v_approver_role staff_role;
  v_approver_site uuid;
  v_approver_name text;
BEGIN
  IF NEW.approved_by IS NULL THEN
    RETURN NEW;
  END IF;

  -- Unchanged approval: nothing to re-check.
  IF TG_OP = 'UPDATE' AND OLD.approved_by IS NOT DISTINCT FROM NEW.approved_by THEN
    RETURN NEW;
  END IF;

  IF NEW.closed_by IS NULL THEN
    RAISE EXCEPTION
      'APPROVAL_BEFORE_CLOSE: a shift cannot be approved before it is closed.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.approved_by = NEW.closed_by THEN
    RAISE EXCEPTION
      'SELF_APPROVAL: the person who closed this shift cannot approve it.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT role INTO v_closer_role FROM staff WHERE id = NEW.closed_by;
  SELECT role, site_id, full_name
    INTO v_approver_role, v_approver_site, v_approver_name
    FROM staff WHERE id = NEW.approved_by;

  IF v_approver_role NOT IN ('MANAGER', 'HEAD_OFFICE', 'SYSTEM_ADMIN') THEN
    RAISE EXCEPTION
      'APPROVER_NOT_A_MANAGER: % holds the % role. A shift is approved by a '
      'manager -- a junior signing off a senior''s shortage is not a review.',
      v_approver_name, v_approver_role
      USING ERRCODE = 'check_violation';
  END IF;

  -- Head office may approve any site in its company; a manager may approve
  -- only their own. A manager at another station has not seen the cash, the
  -- tanks or the people.
  IF v_approver_role = 'MANAGER' AND v_approver_site IS DISTINCT FROM NEW.site_id THEN
    RAISE EXCEPTION
      'APPROVER_AT_ANOTHER_SITE: % manages a different station and has not '
      'seen this one''s cash or tanks.',
      v_approver_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS shift_approval_segregation ON shift;
CREATE TRIGGER shift_approval_segregation
  BEFORE INSERT OR UPDATE OF approved_by ON shift
  FOR EACH ROW EXECUTE FUNCTION trg_shift_approval_segregation();

-- ---------------------------------------------------------------------------
-- Who may create whom.
--
-- Enforced in the database rather than only in the API, because an endpoint is
-- one path to a table and a constraint covers every path -- including the psql
-- session somebody opens at eleven at night to fix something.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_may_create_staff(p_creator uuid, p_new_role staff_role)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_role staff_role;
BEGIN
  SELECT role INTO v_role FROM staff WHERE id = p_creator;

  RETURN CASE
    -- Sets the company up; may create anyone.
    WHEN v_role = 'SYSTEM_ADMIN' THEN TRUE
    -- Runs the company; appoints its managers and the office roles, but is
    -- not the person who creates system administrators.
    WHEN v_role = 'HEAD_OFFICE'  THEN p_new_role IN
      ('MANAGER', 'ACCOUNTANT', 'SUPERVISOR', 'ATTENDANT')
    -- Runs a station; may staff it, but NOT appoint their own reviewer. A
    -- control that lets the controlled party choose who checks them is not a
    -- control.
    WHEN v_role = 'MANAGER'      THEN p_new_role IN ('SUPERVISOR', 'ATTENDANT')
    ELSE FALSE
  END;
END $$;

COMMENT ON FUNCTION fn_may_create_staff IS
  'Whether a person may create staff of a given role. A manager may staff '
  'their station but may not create another manager -- the second manager is '
  'who approves their shifts, and appointing your own reviewer defeats the '
  'segregation entirely.';

-- ---------------------------------------------------------------------------
-- A site needs two managers before it can approve its own shifts.
--
-- A view rather than a constraint: a company setting up its first station has
-- one manager for a while, and refusing to save the site would be absurd. The
-- shortfall surfaces where it matters -- at approval, and on this list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_site_approval_readiness AS
SELECT s.id                                 AS site_id,
       s.tenant_id,
       s.code,
       s.name,
       s.kind,
       count(m.id)                          AS manager_count,
       count(m.id) >= 2                     AS can_self_approve,
       CASE
         WHEN s.kind = 'HEAD_OFFICE' THEN
           'Head office does not trade, so it closes no shifts.'
         WHEN count(m.id) = 0 THEN
           'No manager at this site. Shifts cannot be approved here at all.'
         WHEN count(m.id) = 1 THEN
           'One manager. They can close a shift but cannot approve their own '
           || '-- head office must approve, or appoint a second manager.'
         ELSE
           'Two or more managers. Shifts can be closed and approved here.'
       END                                  AS note
  FROM site s
  LEFT JOIN staff m
         ON m.site_id = s.id AND m.role = 'MANAGER' AND m.is_active
 GROUP BY s.id, s.tenant_id, s.code, s.name, s.kind;

COMMENT ON VIEW v_site_approval_readiness IS
  'Whether each site has enough managers to approve its own shifts. A site '
  'with one manager is not broken -- it simply needs head office to approve, '
  'and this says so rather than leaving somebody to discover it at close.';

GRANT SELECT ON v_site_approval_readiness TO fcms_app;
