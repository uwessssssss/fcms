-- =============================================================================
-- FCMS v2 -- 170_draft_cashup_rebuild.sql
--
-- The shift close could not run:
--
--   permission denied for table money_movement
--   Where: SQL statement "DELETE FROM money_movement WHERE cash_up_id = v_cashup"
--
-- Two correct rules collided.
--
-- 080 revokes DELETE from fcms_app on every table, because nothing in this
-- system is deleted -- things are corrected, reversed or voided, and the trail
-- survives. An auditor asking what the station believed at two o'clock on the
-- third must always have an answer.
--
-- And fn_close_shift deletes a DRAFT cash-up's money movements before writing
-- them again, so that recomputing a close is idempotent rather than additive.
-- That is the fix for the v1 fault where re-running a cash-up charged an
-- attendant the same shortage twice.
--
-- Both are right. A blanket GRANT DELETE would settle the argument by
-- abandoning the first, which is the more valuable of the two.
--
-- So: grant the DELETE, then constrain it with a RESTRICTIVE policy that only
-- permits removing rows belonging to a cash-up still in DRAFT. Restrictive
-- policies are ANDed with the permissive tenant policy rather than ORed, so
-- this genuinely narrows rather than widens.
--
-- The guarantee that survives: once a cash-up is DECLARED, its money movements
-- can never be deleted by the application, by any role, in any code path.
-- =============================================================================

GRANT DELETE ON money_movement, staff_shortage TO fcms_app;

-- ---------------------------------------------------------------------------
-- money_movement: deletable only while the cash-up is a draft.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS money_movement_delete_draft_only ON money_movement;
CREATE POLICY money_movement_delete_draft_only
  ON money_movement
  AS RESTRICTIVE
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM cash_up c
       WHERE c.id = money_movement.cash_up_id
         AND c.status = 'DRAFT'
    )
  );

COMMENT ON POLICY money_movement_delete_draft_only ON money_movement IS
  'A draft cash-up may be rebuilt from scratch, which is what makes recomputing '
  'a close idempotent. Once declared, its movements are permanent.';

-- ---------------------------------------------------------------------------
-- staff_shortage: same reasoning, same window.
--
-- A shortage attached to a draft cash-up is a working figure. Once the cash-up
-- is declared it becomes a receivable against a named person, and a receivable
-- that can be deleted is not a receivable.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS staff_shortage_delete_draft_only ON staff_shortage;
CREATE POLICY staff_shortage_delete_draft_only
  ON staff_shortage
  AS RESTRICTIVE
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM cash_up c
       WHERE c.id = staff_shortage.cash_up_id
         AND c.status = 'DRAFT'
    )
  );

COMMENT ON POLICY staff_shortage_delete_draft_only ON staff_shortage IS
  'Deletable only while its cash-up is a draft. Once declared it is a debt '
  'owed by a named person, and a debt that can be deleted is not a debt.';

-- ---------------------------------------------------------------------------
-- Prove it, here, rather than trusting the policy was written correctly.
--
-- The event trigger in 080 attaches a permissive tenant policy to every table
-- with a tenant_id. Permissive policies are ORed together, so a second
-- permissive policy would have widened this instead of narrowing it. This
-- checks the ones just created are RESTRICTIVE, and fails the migration if a
-- later edit changes that.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE v_bad text[];
BEGIN
  -- The grant itself, verified. 080 revokes DELETE from fcms_app on every
  -- table, and this file grants it back on two. If that ordering ever changed,
  -- the DELETE would silently remove nothing -- row-level security filters
  -- rows rather than raising -- and the close would go back to double-counting
  -- a recomputed cash-up with no error anywhere.
  IF NOT has_table_privilege('fcms_app', 'money_movement', 'DELETE') THEN
    RAISE EXCEPTION
      'GRANT_LOST: fcms_app cannot DELETE from money_movement, so a draft '
      'cash-up cannot be rebuilt and recomputing a close would double-count.';
  END IF;
  IF NOT has_table_privilege('fcms_app', 'staff_shortage', 'DELETE') THEN
    RAISE EXCEPTION 'GRANT_LOST: fcms_app cannot DELETE from staff_shortage';
  END IF;
END $verify$;

DO $verify$
DECLARE v_bad text[];
BEGIN
  SELECT array_agg(policyname)
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('money_movement_delete_draft_only',
                        'staff_shortage_delete_draft_only')
     AND permissive <> 'RESTRICTIVE';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POLICY_TOO_PERMISSIVE: % would be ORed with the tenant policy and allow '
      'any row to be deleted. They must be RESTRICTIVE.',
      array_to_string(v_bad, ', ');
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN ('money_movement_delete_draft_only',
                            'staff_shortage_delete_draft_only')) <> 2 THEN
    RAISE EXCEPTION 'POLICIES_MISSING: both delete policies must exist';
  END IF;
END $verify$;
