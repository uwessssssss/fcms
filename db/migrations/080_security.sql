-- =============================================================================
-- FCMS v2 -- 080_security.sql
--
-- Row-level security that CANNOT be forgotten.
--
-- v1 enumerated the tables to protect in a hard-coded list in 011_rls.sql.
-- Thirteen tables created in later migrations -- the whole credit book, banking,
-- purchases, treasury -- were never added, and tenant A could read tenant B's
-- receivables. That is audit finding C1, and the reason it happened is that
-- the list was a thing a human had to remember.
--
-- Here, policy is applied by an event trigger at CREATE TABLE time, and a
-- self-test refuses to let the migration finish if any tenant-scoped table is
-- unprotected. Forgetting is no longer possible.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_apply_tenant_rls(p_schema text, p_table text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = p_schema AND table_name = p_table
       AND column_name = 'tenant_id'
  ) THEN
    RETURN;   -- not tenant-scoped; nothing to do
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = p_schema AND tablename = p_table
                AND policyname = p_table || '_tenant_isolation') THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', p_schema, p_table);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', p_schema, p_table);

  -- USING governs what you may READ; WITH CHECK governs what you may WRITE.
  -- They are the same predicate here on purpose: a row must belong to your
  -- tenant both to be seen and to be created.
  EXECUTE format(
    'CREATE POLICY %I ON %I.%I USING (tenant_id = app_tenant()) '
    'WITH CHECK (tenant_id = app_tenant())',
    p_table || '_tenant_isolation', p_schema, p_table);
END $$;

-- ---------------------------------------------------------------------------
-- The trigger. Any table created from now on with a tenant_id gets a policy
-- the moment it exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rls_on_create() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
             WHERE command_tag = 'CREATE TABLE' AND object_type = 'table'
  LOOP
    PERFORM fn_apply_tenant_rls(
      split_part(obj.object_identity, '.', 1),
      split_part(obj.object_identity, '.', 2));
  END LOOP;
END $$;

CREATE EVENT TRIGGER rls_on_create_table
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION fn_rls_on_create();

-- Retro-apply to everything already created in 010-070.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    PERFORM fn_apply_tenant_rls(r.schemaname, r.tablename);
  END LOOP;
END $$;

-- tenant itself is keyed on id, not tenant_id.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant
  USING (id = app_tenant()) WITH CHECK (id = app_tenant());

-- ---------------------------------------------------------------------------
-- THE SELF-TEST. This migration fails if any tenant-scoped table is exposed.
-- A schema that is not isolated does not get to deploy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=c.relname
                    AND column_name='tenant_id')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policies
                          WHERE schemaname='public' AND tablename=c.relname));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS_GAP: these tenant-scoped tables have no enforced isolation: %',
      array_to_string(v_bad, ', ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- The roles themselves are created in 010, because 020 hands function
-- ownership to fcms_auth and cannot wait until here. The GRANTs stay in this
-- file: they apply to ALL TABLES, so they must run after every table exists.
--
-- FORCE ROW LEVEL SECURITY matters alongside these: without it the table OWNER
-- bypasses its own policies, which quietly defeats the whole scheme for any
-- process connecting as the owner -- migrations, maintenance sweeps, a psql
-- session.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO fcms_app, fcms_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fcms_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fcms_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fcms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fcms_app;

-- ---------------------------------------------------------------------------
-- fcms_auth needs actual table privileges.
--
-- BYPASSRLS lets a role past row-level policies. It does NOT grant access to
-- the table in the first place - those are different mechanisms, and confusing
-- them meant fn_auth_lookup (SECURITY DEFINER, owned by fcms_auth) failed with
-- "permission denied for table staff" on the very first login attempt.
--
-- Kept as narrow as it can be. fcms_auth is the one role that operates before
-- a tenant is known, so it should be able to see exactly what authentication
-- needs and nothing else: no fuel, no money, no other tenant's business.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO fcms_auth;
GRANT SELECT ON staff, staff_credential TO fcms_auth;
GRANT UPDATE (failed_logins, locked_until, last_login_at)
   ON staff_credential TO fcms_auth;

-- No DELETE anywhere. Nothing in this system is deleted; things are corrected,
-- reversed or voided, and the trail survives. An auditor asking "what did the
-- station believe at 14:00 on the 3rd" must always have an answer.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM fcms_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO fcms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO fcms_readonly;

-- ---------------------------------------------------------------------------
-- Audit log. Insert-only, readable within tenant, immune to the application.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  site_id     uuid REFERENCES site(id),
  actor_id    uuid REFERENCES staff(id),
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL,
  before_data jsonb,
  after_data  jsonb,
  ip_address  inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_log (entity, entity_id);

CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
