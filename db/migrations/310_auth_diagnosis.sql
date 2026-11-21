-- =============================================================================
-- FCMS v2 -- 310_auth_diagnosis.sql
--
-- Say WHY a login failed, in the log.
--
-- fn_auth_lookup joins staff to staff_credential. That join is right -- an
-- account with no password must not sign in -- but it collapses three very
-- different situations into one empty result, and the log line for all three
-- reads "unknown or inactive":
--
--   * nobody has that employee number
--   * the account exists and is switched off
--   * the account exists and has NEVER BEEN GIVEN A PASSWORD
--
-- The third is what a freshly seeded database looks like before
-- `--set-password` is run, and it is indistinguishable from a typo. That cost
-- a real debugging round: the seed was fine and the account was fine.
--
-- The REPLY to the person signing in does not change -- it stays "that
-- employee number or password is not right", because telling a stranger which
-- employee numbers exist is how an attacker enumerates staff. Only the
-- server's own log learns the difference.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_auth_diagnose(p_employee_no text)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM staff WHERE employee_no = p_employee_no)
      THEN 'no such employee number'
    WHEN NOT EXISTS (SELECT 1 FROM staff WHERE employee_no = p_employee_no AND is_active)
      THEN 'the account is switched off'
    WHEN NOT EXISTS (
      SELECT 1 FROM staff s JOIN staff_credential c ON c.staff_id = s.id
       WHERE s.employee_no = p_employee_no)
      THEN 'no password has ever been set for this account -- run --set-password'
    ELSE 'the password did not match'
  END;
$$;

ALTER FUNCTION fn_auth_diagnose(text) OWNER TO fcms_auth;
REVOKE ALL ON FUNCTION fn_auth_diagnose(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_auth_diagnose(text) TO fcms_app;

COMMENT ON FUNCTION fn_auth_diagnose IS
  'Why a login failed, for the server log only. Never returned to the caller: '
  'a stranger who can tell "no such employee" from "wrong password" can '
  'enumerate every employee number you have.';
