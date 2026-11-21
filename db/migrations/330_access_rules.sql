-- =============================================================================
-- FCMS v2 -- 330_access_rules.sql
--
-- Found while wiring the administration screen:
--
--   * Revoking someone's access DELETES their credential, and needed only
--     staff.manage -- which a manager holds. So a manager could lock the OTHER
--     manager out, and remove their own reviewer by a third route. 280 closed
--     appointing one, 290 closed demoting or switching one off; this is the
--     same rule applied to the credential itself.
--
--   * Screens told people the trading policy is "changed by head office", but
--     only ADMIN held policy.configure. Head office could not change it.
--
--   * Head office could see who is signed in but not end a session.
-- =============================================================================

INSERT INTO role_permission (role, permission) VALUES
  ('HEAD_OFFICE', 'policy.configure'),
  ('HEAD_OFFICE', 'session.revoke')
ON CONFLICT DO NOTHING;

-- Taking away someone's ability to sign in needs the same authority as
-- appointing them. Revoking your OWN access is always allowed.
CREATE OR REPLACE FUNCTION trg_credential_revoke_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_role  staff_role;
  v_name  text;
BEGIN
  IF v_actor IS NULL OR v_actor = OLD.staff_id THEN
    RETURN OLD;
  END IF;
  SELECT role, full_name INTO v_role, v_name FROM staff WHERE id = OLD.staff_id;
  IF NOT fn_may_create_staff(v_actor, v_role) THEN
    RAISE EXCEPTION
      'MAY_NOT_REVOKE: only someone who could appoint a % may take away their '
      'access. Otherwise a manager could lock out the other manager -- the '
      'person who approves their shifts.', lower(v_role::text)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS credential_revoke_rule ON staff_credential;
CREATE TRIGGER credential_revoke_rule
  BEFORE DELETE ON staff_credential
  FOR EACH ROW EXECUTE FUNCTION trg_credential_revoke_rule();
