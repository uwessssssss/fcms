-- =============================================================================
-- FCMS -- attacks that must fail.   psql -d fcms -f db/test/security.sql
--
-- Run after the seeds (one_station). A second company, B, is made inside a
-- transaction that is rolled back, so nothing is left behind. Every attack runs
-- as the API's own role (fcms_app) with a real session (app.tenant_id,
-- app.staff_id), exactly as a request would -- the case being guarded is a bug
-- or an injection in the API, or its credentials in the wrong hands.
--
-- Found in the November 2026 audit (docs/AUDIT-2026-11.md, S1-S7); each attack
-- succeeded before migration 650.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;

-- Company A is the seed. Company B, its accountant and a statement line in A.
INSERT INTO tenant (id, name, country_code, base_currency, default_tz, is_active)
VALUES ('0c000000-0000-4000-8000-000000000001', 'Other Fuels Ltd', 'UG', 'UGX', 'Africa/Kampala', true);
INSERT INTO site (id, tenant_id, code, name, kind)
VALUES ('0c000000-0000-4000-8000-0000000000f0', '0c000000-0000-4000-8000-000000000001', 'HO', 'Other head office', 'HEAD_OFFICE');
INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role, is_active)
VALUES ('0c000000-0000-4000-8000-0000000000a4', '0c000000-0000-4000-8000-000000000001', '0c000000-0000-4000-8000-0000000000f0',
        'B-ACC', 'B accountant', 'ACCOUNTANT', true);
INSERT INTO money_account (id, tenant_id, kind, name, institution)
VALUES ('0a000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-000000000001', 'BANK', 'A bank', 'A bank Ltd');
INSERT INTO bank_statement (id, tenant_id, money_account_id, period_from, period_to, imported_by)
VALUES ('0a000000-0000-4000-8000-0000000000b2', '0a000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-0000000000b1',
        current_date - 7, current_date, '10000000-0000-4000-8000-000000000004');
INSERT INTO bank_statement_line (id, tenant_id, statement_id, money_account_id, txn_date, amount, line_no, description)
VALUES ('0a000000-0000-4000-8000-0000000000b3', '0a000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-0000000000b2',
        '0a000000-0000-4000-8000-0000000000b1', current_date - 1, -25000, 1, 'BANK CHARGES');

INSERT INTO money_account (id, tenant_id, kind, name, institution)
VALUES ('0a000000-0000-4000-8000-0000000000b4', '0a000000-0000-4000-8000-000000000001', 'BANK', 'A second bank', 'A bank Ltd');
INSERT INTO money_transfer (tenant_id, from_account, to_account, amount, recorded_by)
VALUES ('0a000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-0000000000b4',
        100000, '10000000-0000-4000-8000-000000000004');
INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id)
VALUES ('0a000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', 'probe', 'probe', 'probe');

DO $probe$
DECLARE
  a_tenant  uuid := '0a000000-0000-4000-8000-000000000001';
  a_site    uuid := '0b000000-0000-4000-8000-000000000001';
  a_acc     uuid := '10000000-0000-4000-8000-000000000004';   -- A's accountant
  a_ho      uuid := '10000000-0000-4000-8000-0000000000a1';   -- A's head office
  a_sup     uuid := '10000000-0000-4000-8000-000000000002';   -- A's supervisor
  b_tenant  uuid := '0c000000-0000-4000-8000-000000000001';
  b_acc     uuid := '0c000000-0000-4000-8000-0000000000a4';
  a_journal uuid;
  a_line    uuid := '0a000000-0000-4000-8000-0000000000b3';
  a_shift   uuid;
  a_fuel    bigint;
  ok int := 0; bad text[] := '{}'; n bigint;
  -- attack name, session tenant, session staff, statement
  att record;
BEGIN
  SELECT id INTO a_journal FROM gl_journal j WHERE tenant_id = a_tenant
     AND NOT EXISTS (SELECT 1 FROM gl_journal r WHERE r.reverses_id = j.id) AND reverses_id IS NULL LIMIT 1;
  SELECT id INTO a_shift FROM shift WHERE tenant_id = a_tenant LIMIT 1;
  SELECT id INTO a_fuel FROM fuel_movement WHERE tenant_id = a_tenant LIMIT 1;
  IF a_journal IS NULL OR a_shift IS NULL OR a_fuel IS NULL THEN
    RAISE EXCEPTION 'security.sql needs the seeds (one_station, demo_day) loaded first';
  END IF;

  FOR att IN SELECT * FROM (VALUES
    -- S1: one company reverses another's journal
    ('S1 company B reverses a journal of company A', b_tenant, b_acc,
       format('SELECT fn_gl_reverse(%L, %L, %L)', a_journal, 'attack', b_acc)),
    -- S1b: within one company, a supervisor reverses a journal
    ('S1b a supervisor reverses a journal', a_tenant, a_sup,
       format('SELECT fn_gl_reverse(%L, %L, %L)', a_journal, 'attack', a_sup)),
    -- S2: one company posts into another's books through a statement line
    ('S2 company B posts company A''s statement line', b_tenant, b_acc,
       format('SELECT fn_bank_post_statement_line(%L, %L, %L, %L)', a_line, '6100', 'attack', b_acc)),
    -- S3: the actor is whoever the caller says
    ('S3 a supervisor posts a journal in the name of head office', a_tenant, a_sup,
       format('SELECT fn_gl_manual_journal(%L, current_date, %L, %L::jsonb, %L)', a_site, 'attack journal',
              '[{"code":"6100","amount":1000},{"code":"1000","amount":-1000,"site_id":"' || a_site || '"}]', a_ho)),
    ('S3b company B closes company A''s month in A''s accountant''s name', b_tenant, b_acc,
       format('SELECT fn_gl_close_period(date_trunc(''month'', current_date)::date - 365, %L)', a_acc)),
    -- S4: a journal for another company's site
    ('S4 company B posts a manual journal to company A''s site', b_tenant, b_acc,
       format('SELECT fn_gl_manual_journal(%L, current_date, %L, %L::jsonb, %L)', a_site, 'attack journal',
              '[{"code":"6100","amount":1000},{"code":"1000","amount":-1000,"site_id":"' || a_site || '"}]', b_acc)),
    -- S5: internal posting machinery called directly
    ('S5 the app runs the ledger backfill (every company)', b_tenant, b_acc, 'SELECT fn_gl_backfill()'),
    ('S5b the app re-seeds a chart for another company', b_tenant, b_acc, format('SELECT fn_gl_seed_chart(%L)', a_tenant)),
    ('S5c the app posts a shift of another company', b_tenant, b_acc, format('SELECT fn_gl_post_shift(%L)', a_shift)),
    -- S6: records the ledger was posted from, rewritten afterwards
    ('S6 a posted fuel movement is rewritten', a_tenant, a_ho,
       format('UPDATE fuel_movement SET litres = litres + 1000 WHERE id = %s', a_fuel)),
    ('S6b an imported statement line is rewritten', a_tenant, a_acc,
       format('UPDATE bank_statement_line SET amount = amount - 1 WHERE id = %L', a_line)),
    ('S6e a recorded money transfer is rewritten', a_tenant, a_ho,
       'UPDATE money_transfer SET amount = amount + 1 WHERE true'),
    ('S6c the audit log is rewritten', a_tenant, a_ho,
       'UPDATE audit_log SET action = ''rewritten'' WHERE action = ''probe'''),
    ('S6d an account''s type is changed after it has postings', a_tenant, a_acc,
       'UPDATE gl_account SET type = ''EXPENSE'' WHERE code = ''4000''')
  ) v(name, tenant, staff, stmt) LOOP
    BEGIN
      PERFORM set_config('app.tenant_id', att.tenant::text, true);
      PERFORM set_config('app.staff_id', att.staff::text, true);
      SET LOCAL ROLE fcms_app;
      EXECUTE att.stmt;
      GET DIAGNOSTICS n = ROW_COUNT;
      RESET ROLE;
      -- An UPDATE that touched no row proves nothing (RLS may have hidden it).
      -- A table made append-only by a DO INSTEAD NOTHING rule ignores the
      -- update silently: that is blocked too.
      IF att.stmt LIKE 'UPDATE%' AND n = 0 AND EXISTS (SELECT 1 FROM pg_rules r
           WHERE r.tablename = split_part(att.stmt, ' ', 2) AND r.definition LIKE '%ON UPDATE%DO INSTEAD NOTHING%') THEN
        RAISE EXCEPTION 'ignored by an append-only rule';
      END IF;
      IF att.stmt LIKE 'UPDATE%' AND n = 0 THEN
        RAISE EXCEPTION 'SECURITY: probe "%" changed no row, so it tested nothing -- fix the probe', att.name;
      END IF;
      bad := bad || att.name;
      RAISE EXCEPTION 'attack_succeeded';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      IF SQLERRM LIKE 'SECURITY: probe%' THEN
        RAISE;
      ELSIF SQLERRM = 'attack_succeeded' THEN
        RAISE NOTICE 'OPEN    %', att.name;
      ELSE
        ok := ok + 1;
        RAISE NOTICE 'blocked % -- %', att.name, left(SQLERRM, 90);
      END IF;
    END;
  END LOOP;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'SECURITY: % attack(s) succeeded: %', array_length(bad, 1), array_to_string(bad, '; ');
  END IF;
  RAISE NOTICE 'ALL % ATTACKS BLOCKED', ok;
END $probe$;
ROLLBACK;
