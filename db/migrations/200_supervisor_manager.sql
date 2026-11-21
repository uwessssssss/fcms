-- =============================================================================
-- FCMS v2 -- 200_supervisor_manager.sql
--
-- The split between supervisor and manager was wrong, and wrong in a way that
-- would have been obvious on the first morning:
--
--   A MANAGER COULD NOT SEE A SINGLE REPORT, and could not record taking cash
--   to the bank. Those are the two things a manager at this station actually
--   does. Under the arrangement being replaced here, a manager signing in had
--   almost no reason to.
--
-- The real division of labour:
--
--   SUPERVISOR runs the forecourt. Opens and closes shifts, assigns nozzles,
--   dips tanks, records readings, takes cash-ups, sells on credit, receives
--   deliveries. Everything that happens between the canopy and the office.
--
--   MANAGER does all of that TOO -- a manager covers a shift when a supervisor
--   is away, and a system that cannot let them is a system that gets shared
--   passwords. On top of it: oversight, approvals, banking, pricing,
--   discounts, and the customer relationships that come with marketing.
--
-- So manager is a strict superset of supervisor. The one thing that does NOT
-- follow from being a superset is the segregation rule, and it survives
-- untouched: shift_segregation still refuses an approval by the person who
-- closed it. A manager who covers a shift cannot sign off their own work --
-- that is a table constraint, not a permission, and no grant can loosen it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- What a manager was missing.
-- ---------------------------------------------------------------------------
INSERT INTO role_permission (role, permission) VALUES
  -- Overall sight. A manager who cannot open a report is a manager who asks
  -- the accountant to print one, which is how a station ends up managed from
  -- a week-old spreadsheet.
  ('MANAGER','report.view'),

  -- Taking the cash to the bank. This is literally the job, and it belonged
  -- only to the accountant.
  ('MANAGER','banking.record'),

  -- Following the money afterwards: which customers owe, and chasing them.
  -- Marketing at a station is largely credit relationships.
  ('MANAGER','credit_payment.record'),

  -- A manager signs off a stock count they did not conduct.
  ('MANAGER','stock_count.approve')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- What a supervisor was missing.
--
-- Dry stock and stock counts are forecourt work. A supervisor who can sell a
-- lubricant but cannot count the shelf, or receive the delivery that filled
-- it, has to fetch a manager for an ordinary Tuesday task.
-- ---------------------------------------------------------------------------
INSERT INTO role_permission (role, permission) VALUES
  ('SUPERVISOR','dry_stock.manage'),
  ('SUPERVISOR','stock_count.conduct'),
  ('SUPERVISOR','exception.resolve')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Manager is a superset of supervisor. Enforced, not assumed.
--
-- Anything granted to a supervisor from now on is granted to a manager too, so
-- the two cannot drift apart the next time a permission is added and only one
-- role is remembered.
-- ---------------------------------------------------------------------------
INSERT INTO role_permission (role, permission)
SELECT 'MANAGER', permission
  FROM role_permission
 WHERE role = 'SUPERVISOR'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION trg_manager_covers_supervisor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'SUPERVISOR' THEN
    INSERT INTO role_permission (role, permission)
    VALUES ('MANAGER', NEW.permission)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS manager_covers_supervisor ON role_permission;
CREATE TRIGGER manager_covers_supervisor
  AFTER INSERT ON role_permission
  FOR EACH ROW EXECUTE FUNCTION trg_manager_covers_supervisor();

COMMENT ON FUNCTION trg_manager_covers_supervisor IS
  'A manager can do anything a supervisor can -- they cover shifts. Enforced '
  'so the two roles cannot drift apart when a permission is added to one.';

-- ---------------------------------------------------------------------------
-- Prove it here, so a later edit cannot quietly break the relationship.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE v_missing text[];
BEGIN
  SELECT array_agg(s.permission)
    INTO v_missing
    FROM role_permission s
   WHERE s.role = 'SUPERVISOR'
     AND NOT EXISTS (SELECT 1 FROM role_permission m
                      WHERE m.role = 'MANAGER' AND m.permission = s.permission);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'MANAGER_NOT_A_SUPERSET: a supervisor can do % and a manager cannot. A '
      'manager covering a shift would be blocked from ordinary work.',
      array_to_string(v_missing, ', ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM role_permission
                  WHERE role = 'MANAGER' AND permission = 'banking.record') THEN
    RAISE EXCEPTION 'MANAGER_CANNOT_BANK: taking cash to the bank is the job';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM role_permission
                  WHERE role = 'MANAGER' AND permission = 'report.view') THEN
    RAISE EXCEPTION 'MANAGER_CANNOT_SEE: overall sight is the job';
  END IF;
END $verify$;
