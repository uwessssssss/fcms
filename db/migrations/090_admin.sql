-- =============================================================================
-- FCMS v2 -- 090_admin.sql
--
-- Administrative operations that must run BEFORE a tenant is known.
--
-- Setting an operator's first password is a chicken-and-egg problem: the tool
-- connects as fcms_app, which is subject to row-level security, and
-- app.tenant_id cannot be set because nobody has signed in yet. Every row in
-- staff is therefore invisible, and "--set-password ALL" cheerfully reports
-- that no operator matched -- which is RLS working exactly as designed on a
-- request that never told it who it was.
--
-- Same shape as authentication, and solved the same way: one narrow
-- SECURITY DEFINER function owned by fcms_auth. It can set a password hash and
-- do nothing else -- no fuel, no money, no reading of anything a tenant owns.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_set_password(p_who text, p_hash text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    -- Refuse anything that is not a bcrypt hash. The first version of the seed
    -- shipped a hand-written string that looked plausible and was not valid,
    -- and it surfaced hours later as "SaltParseException: Invalid salt version"
    -- on a login screen. Catch it at the point of entry instead.
    RAISE EXCEPTION
      'NOT_A_BCRYPT_HASH: refusing to store a password hash that is not bcrypt. '
      'Generate one with: dotnet run -- --hash ''yourpassword'''
      USING ERRCODE = 'check_violation';
  END IF;

  IF upper(p_who) = 'ALL' THEN
    INSERT INTO staff_credential (staff_id, password_hash, must_change)
    SELECT id, p_hash, TRUE
      FROM staff
     WHERE role <> 'ATTENDANT' AND is_active
    ON CONFLICT (staff_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          password_set_at = now(),
          must_change = TRUE,
          failed_logins = 0,
          locked_until = NULL;
  ELSE
    INSERT INTO staff_credential (staff_id, password_hash, must_change)
    SELECT id, p_hash, TRUE
      FROM staff
     WHERE employee_no = p_who AND role <> 'ATTENDANT' AND is_active
    ON CONFLICT (staff_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          password_set_at = now(),
          must_change = TRUE,
          failed_logins = 0,
          locked_until = NULL;
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION fn_set_password IS
  'Sets an operator password before any tenant context exists. SECURITY '
  'DEFINER because RLS would otherwise hide every staff row from the tool '
  'doing the setting. Refuses anything that is not a bcrypt hash.';

-- fcms_auth owns it, so fcms_auth needs to be able to write the row. BYPASSRLS
-- gets past the policy; it does not grant access to the table.
GRANT INSERT ON staff_credential TO fcms_auth;
GRANT UPDATE (password_hash, password_set_at, must_change,
              failed_logins, locked_until, last_login_at)
   ON staff_credential TO fcms_auth;

ALTER FUNCTION fn_set_password(text, text) OWNER TO fcms_auth;
REVOKE ALL ON FUNCTION fn_set_password(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_set_password(text, text) TO fcms_app;

-- ---------------------------------------------------------------------------
-- How many operators still have no password? Used by the API at startup to say
-- so where it is actionable, rather than letting it surface as a failed login.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_operators_without_password()
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM staff s
   WHERE s.role <> 'ATTENDANT' AND s.is_active
     AND NOT EXISTS (SELECT 1 FROM staff_credential c WHERE c.staff_id = s.id);
$$;

ALTER FUNCTION fn_operators_without_password() OWNER TO fcms_auth;
REVOKE ALL ON FUNCTION fn_operators_without_password() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_operators_without_password() TO fcms_app;
