-- =============================================================================
-- 650 Security hardening (audit November 2026, docs/AUDIT-2026-11.md)
--
-- Each attack below succeeded before this migration; db/test/security.sql runs
-- them as the API's role with a real session and now expects every one refused.
--
--  S1  fn_gl_reverse reversed ANY journal, of any company, for any caller: it
--      had no tenant check and no role check. Now: accountant or head office,
--      own company only. Triggers use fn_gl_reverse_internal.
--  S2  fn_bank_post_statement_line posted another company's statement line.
--  S3  p_actor was whoever the caller said: a supervisor could post a journal or
--      close a month in head office's name. fn_ledger_actor binds the actor to
--      the signed-in user (app.staff_id) and to the session's company.
--  S4  a journal could carry another company's site, customer, tank... (any
--      dimension): checked on every journal and line now.
--  S5  the app could run the posting machinery directly (backfill across every
--      company, re-seed a chart, post any record). Execute revoked; the triggers
--      that need it run as the ledger owner.
--  S6  an imported bank statement (its lines and amounts) and a recorded
--      money transfer could be rewritten afterwards (080 grants UPDATE on every
--      table; these had no rule or trigger against it). They refuse UPDATE now,
--      and an account's code, type and control cannot change once it has
--      postings. (The movement tables and the audit log were already
--      append-only, by rules.)
-- =============================================================================

-- ---- S3: who is acting -----------------------------------------------------
-- Inside a request (app.staff_id set) the actor must be the signed-in user and
-- belong to the session's company. Outside one, only a superuser (migrations,
-- maintenance, tests) may name an actor.
-- Returns the actor's company.
CREATE OR REPLACE FUNCTION fn_ledger_actor(p_actor uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sess   uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  o_role   staff_role;
  o_tenant uuid;
BEGIN
  IF v_sess IS NOT NULL AND v_sess IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: the books act only in the name of the signed-in user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_sess IS NULL AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: no signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT role, tenant_id INTO o_role, o_tenant FROM staff WHERE id = p_actor AND is_active;
  IF o_role IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: unknown or inactive user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NOT NULL AND o_tenant IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: that user belongs to another company' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN o_tenant;
END $$;
ALTER FUNCTION fn_ledger_actor(uuid) OWNER TO fcms_ledger;

-- ---- S1: reversing a journal -----------------------------------------------
-- The old body, unchanged, for the triggers (a voided shift reverses its own
-- journal whoever voided it; the void itself is permission-checked).
CREATE OR REPLACE FUNCTION fn_gl_reverse_internal(p_journal uuid, p_reason text, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v gl_journal%ROWTYPE;
BEGIN
  SELECT * INTO v FROM gl_journal WHERE id = p_journal;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_JOURNAL: %', p_journal USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM gl_journal WHERE reverses_id = p_journal) THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: journal % is reversed already', p_journal USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: say why the journal is reversed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN fn_gl_post(v.tenant_id, v.site_id, v.source, v.source_id, now(), 'Reversal: ' || trim(p_reason) || ' -- ' || v.memo,
    (SELECT jsonb_agg(jsonb_build_object('code', a.code, 'amount', -l.amount, 'qty', -l.qty, 'site_id', l.site_id,
              'customer_id', l.customer_id, 'supplier_id', l.supplier_id, 'staff_id', l.staff_id, 'tank_id', l.tank_id,
              'item_id', l.item_id, 'channel_id', l.channel_id, 'product_id', l.product_id, 'memo', l.memo))
       FROM gl_line l JOIN gl_account a ON a.id = l.account_id WHERE l.journal_id = p_journal),
    p_actor, p_journal);
END $function$;
ALTER FUNCTION fn_gl_reverse_internal(uuid, text, uuid) OWNER TO fcms_ledger;

CREATE OR REPLACE FUNCTION fn_gl_reverse(p_journal uuid, p_reason text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_role staff_role;
BEGIN
  v_tenant := fn_ledger_actor(p_actor);
  SELECT role INTO v_role FROM staff WHERE id = p_actor;
  IF v_role NOT IN ('ACCOUNTANT', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a journal is reversed by an accountant or head office'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_journal WHERE id = p_journal AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'UNKNOWN_JOURNAL: %', p_journal USING ERRCODE = 'no_data_found';
  END IF;
  RETURN fn_gl_reverse_internal(p_journal, p_reason, p_actor);
END $$;
ALTER FUNCTION fn_gl_reverse(uuid, text, uuid) OWNER TO fcms_ledger;

-- ---- S2, S3: the other ledger actions bind their actor -----------------------
CREATE OR REPLACE FUNCTION fn_gl_manual_journal(p_site uuid, p_date date, p_memo text, p_lines jsonb, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_role staff_role; v_tenant uuid;
BEGIN
  PERFORM fn_ledger_actor(p_actor);   -- (650) the actor is the signed-in user, in that company
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'MANAGER', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a manual journal is posted by an accountant, manager or head office'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_memo IS NULL OR length(trim(p_memo)) < 5 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: say what the journal is for' USING ERRCODE = 'check_violation';
  END IF;
  RETURN fn_gl_post(v_tenant, p_site, 'manual', gen_random_uuid()::text,
                    (p_date + time '12:00') AT TIME ZONE 'Africa/Kampala', trim(p_memo), p_lines, p_actor);
END $function$;
CREATE OR REPLACE FUNCTION fn_gl_close_period(p_month date, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_role staff_role; v_tenant uuid; v_start date := date_trunc('month', p_month)::date; n int;
BEGIN
  PERFORM fn_ledger_actor(p_actor);   -- (650) the actor is the signed-in user, in that company
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a month is closed by an accountant or head office' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO n FROM shift
   WHERE tenant_id = v_tenant AND state IN ('OPEN', 'COUNTING')
     AND business_date >= v_start AND business_date < v_start + interval '1 month';
  IF n > 0 THEN
    RAISE EXCEPTION 'SHIFTS_STILL_OPEN: % shift(s) of that month are not closed yet', n USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_period WHERE tenant_id = v_tenant AND period_start = v_start AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: % is closed already', to_char(v_start, 'Mon YYYY') USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO gl_period (tenant_id, period_start, closed_at, closed_by) VALUES (v_tenant, v_start, now(), p_actor)
  ON CONFLICT (tenant_id, period_start) DO UPDATE SET closed_at = now(), closed_by = p_actor;
END $function$;
CREATE OR REPLACE FUNCTION fn_gl_close_year(p_year integer, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_role staff_role; v_tenant uuid; v_from date := make_date(p_year, 1, 1); v_to date := make_date(p_year, 12, 31);
        v_open text; v_id uuid; v_re uuid; r record; v_n int := 0;
BEGIN
  PERFORM fn_ledger_actor(p_actor);   -- (650) the actor is the signed-in user, in that company
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a year is closed by an accountant or head office' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_journal WHERE tenant_id = v_tenant AND source = 'year_end' AND source_id = p_year::text) THEN
    RAISE EXCEPTION 'YEAR_CLOSED: % is closed already', p_year USING ERRCODE = 'check_violation';
  END IF;
  -- Every month with postings, and December, closed.
  SELECT string_agg(to_char(m, 'Mon'), ', ' ORDER BY m) INTO v_open
    FROM (SELECT DISTINCT date_trunc('month', posting_date)::date AS m FROM gl_journal
           WHERE tenant_id = v_tenant AND posting_date BETWEEN v_from AND v_to
          UNION SELECT make_date(p_year, 12, 1)) months
   WHERE NOT EXISTS (SELECT 1 FROM gl_period p WHERE p.tenant_id = v_tenant AND p.period_start = months.m
                        AND p.closed_at IS NOT NULL);
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'MONTHS_STILL_OPEN: close % % first', v_open, p_year USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_re FROM gl_account WHERE tenant_id = v_tenant AND code = '3100';
  -- Written here, not through fn_gl_post: December is closed by now, and this
  -- journal belongs in it.
  INSERT INTO gl_journal (tenant_id, site_id, posting_date, event_at, source, source_id, memo, posted_by)
  VALUES (v_tenant, NULL, v_to, (v_to + time '23:59') AT TIME ZONE 'Africa/Kampala', 'year_end', p_year::text,
          'Year ' || p_year || ' closed: income and expenses to retained earnings', p_actor)
  RETURNING id INTO v_id;

  FOR r IN
    SELECT l.account_id, l.site_id, SUM(l.amount) AS balance
      FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id JOIN gl_account a ON a.id = l.account_id
     WHERE l.tenant_id = v_tenant AND a.type IN ('INCOME', 'EXPENSE') AND j.posting_date BETWEEN v_from AND v_to
     GROUP BY l.account_id, l.site_id HAVING SUM(l.amount) <> 0
  LOOP
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, site_id, memo)
    VALUES (v_tenant, v_id, r.account_id, -r.balance, r.site_id, 'Closed to retained earnings');
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, site_id, memo)
    VALUES (v_tenant, v_id, v_re, r.balance, r.site_id, 'Year ' || p_year || ' result');
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_CLOSE: % has no income or expense', p_year USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_id;
END $function$;
CREATE OR REPLACE FUNCTION fn_bank_post_statement_line(p_line uuid, p_code text, p_memo text, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sl bank_statement_line%ROWTYPE; v_role staff_role; v_j uuid; v_book bigint; v_site uuid;
BEGIN
  PERFORM fn_ledger_actor(p_actor);   -- (650) the actor is the signed-in user, in that company
  SELECT role INTO v_role FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'MANAGER', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: statement items are posted by an accountant, manager or head office'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO sl FROM bank_statement_line WHERE id = p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_LINE: %', p_line USING ERRCODE = 'no_data_found'; END IF;
  IF sl.tenant_id IS DISTINCT FROM (SELECT tenant_id FROM staff WHERE id = p_actor) THEN   -- (650) another company's line
    RAISE EXCEPTION 'UNKNOWN_LINE: %', p_line USING ERRCODE = 'no_data_found';
  END IF;
  IF p_line IN (SELECT line_id FROM v_bank_matched_statement) THEN
    RAISE EXCEPTION 'ALREADY_MATCHED: that statement line is matched already' USING ERRCODE = 'check_violation';
  END IF;
  IF p_code IN ('1010', '1020', '1100', '2000', '1200', '1210', '1110') THEN
    RAISE EXCEPTION 'USE_ITS_SCREEN: a % item is recorded on its own screen (payment, banking, transfer), then matched', p_code
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT site_id INTO v_site FROM money_account WHERE id = sl.money_account_id;
  v_j := fn_gl_post(sl.tenant_id, v_site, 'bank_statement_line', p_line::text,
                    (sl.txn_date + time '12:00') AT TIME ZONE 'Africa/Kampala',
                    COALESCE(NULLIF(trim(p_memo), ''), sl.description),
                    jsonb_build_array(
                      fn_money_account_line(sl.money_account_id, sl.amount, sl.description),
                      jsonb_build_object('code', p_code, 'amount', -sl.amount, 'memo', sl.description)),
                    p_actor);
  SELECT l.id INTO v_book FROM gl_line l JOIN gl_account a ON a.id = l.account_id
   WHERE l.journal_id = v_j AND a.code IN ('1010', '1020');
  PERFORM fn_bank_match(sl.money_account_id, ARRAY[p_line], ARRAY[v_book], 'POSTED', p_actor, p_memo);
  RETURN v_j;
END $function$;

-- ---- S4: every dimension of a journal belongs to its company ----------------
CREATE OR REPLACE FUNCTION trg_gl_same_company() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'gl_journal' THEN
    IF NEW.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'OTHER_COMPANY: site % is not in this company', NEW.site_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'gl_line' THEN
  IF (NEW.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id))
  OR (NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credit_customer WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id))
  OR (NEW.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier WHERE id = NEW.supplier_id AND tenant_id = NEW.tenant_id))
  OR (NEW.staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff WHERE id = NEW.staff_id AND tenant_id = NEW.tenant_id))
  OR (NEW.tank_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tank WHERE id = NEW.tank_id AND tenant_id = NEW.tenant_id))
  OR (NEW.item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dry_item WHERE id = NEW.item_id AND tenant_id = NEW.tenant_id))
  OR (NEW.channel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_channel WHERE id = NEW.channel_id AND tenant_id = NEW.tenant_id))
  OR (NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product WHERE id = NEW.product_id AND tenant_id = NEW.tenant_id))
  OR (NEW.money_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM money_account WHERE id = NEW.money_account_id AND tenant_id = NEW.tenant_id))
  THEN
    RAISE EXCEPTION 'OTHER_COMPANY: a journal line names a site, customer, supplier, staff, tank, item, channel, product or account of another company'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_gl_same_company() OWNER TO fcms_ledger;
DROP TRIGGER IF EXISTS trg_gl_journal_same_company ON gl_journal;
CREATE TRIGGER trg_gl_journal_same_company BEFORE INSERT ON gl_journal FOR EACH ROW EXECUTE FUNCTION trg_gl_same_company();
DROP TRIGGER IF EXISTS trg_gl_line_same_company ON gl_line;
CREATE TRIGGER trg_gl_line_same_company BEFORE INSERT ON gl_line FOR EACH ROW EXECUTE FUNCTION trg_gl_same_company();

-- ---- S5: the posting machinery is not the app's to call ----------------------
-- The triggers that drive it run as the ledger owner, so the app no longer
-- needs (or has) EXECUTE on what they call.
CREATE OR REPLACE FUNCTION trg_gl_shift()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_j uuid;
BEGIN
  IF NEW.state = 'DECLARED' AND OLD.state IS DISTINCT FROM 'DECLARED' THEN
    PERFORM fn_gl_post_shift(NEW.id);
  ELSIF NEW.state = 'VOID' AND OLD.state IN ('DECLARED', 'APPROVED', 'POSTED') THEN
    SELECT id INTO v_j FROM gl_journal WHERE source = 'shift' AND source_id = NEW.id::text AND reverses_id IS NULL;
    IF v_j IS NOT NULL THEN PERFORM fn_gl_reverse_internal(v_j, 'shift voided', NULL); END IF;
  END IF;
  RETURN NULL;
END $function$;
ALTER FUNCTION trg_gl_shift() OWNER TO fcms_ledger;
CREATE OR REPLACE FUNCTION trg_gl_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF    TG_TABLE_NAME = 'fuel_movement'     THEN PERFORM fn_gl_post_fuel_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'dry_movement'      THEN PERFORM fn_gl_post_dry_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'banking'           THEN PERFORM fn_gl_post_banking(NEW.id);
  ELSIF TG_TABLE_NAME = 'credit_payment'    THEN PERFORM fn_gl_post_credit_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'expense'           THEN PERFORM fn_gl_post_expense(NEW.id);
  ELSIF TG_TABLE_NAME = 'other_income'      THEN PERFORM fn_gl_post_other_income(NEW.id);
  ELSIF TG_TABLE_NAME = 'shortage_recovery' THEN PERFORM fn_gl_post_shortage_recovery(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_invoice'  THEN PERFORM fn_gl_post_supplier_invoice(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_payment'  THEN PERFORM fn_gl_post_supplier_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'bulk_sale'         THEN PERFORM fn_gl_post_bulk_sale(NEW.id);
  ELSIF TG_TABLE_NAME = 'money_transfer'    THEN PERFORM fn_gl_post_money_transfer(NEW.id);
  END IF;
  RETURN NULL;
END $function$;
ALTER FUNCTION trg_gl_post() OWNER TO fcms_ledger;
CREATE OR REPLACE FUNCTION trg_tenant_chart()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM fn_gl_seed_chart(NEW.id);
  RETURN NEW;
END $function$;
ALTER FUNCTION trg_tenant_chart() OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_backfill() SET search_path = public, pg_temp;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND (p.proname LIKE 'fn_gl_post\_%' OR p.proname IN ('fn_gl_post', 'fn_gl_backfill', 'fn_gl_seed_chart',
                                                                'fn_gl_reverse_internal', 'fn_ledger_actor'))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, fcms_app, fcms_readonly', f.sig);
  END LOOP;
END $$;

-- ---- S6: the records the books were posted from do not change ----------------
CREATE OR REPLACE FUNCTION trg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % rows are not edited; record a correction or a reversal instead', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;
DO $$
DECLARE t text;
BEGIN
  -- fuel_movement, dry_movement, money_movement and audit_log are append-only
  -- already (DO INSTEAD NOTHING rules, 050/045/060/080). These were not.
  FOREACH t IN ARRAY ARRAY['money_transfer', 'bank_statement', 'bank_statement_line']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_append_only ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION trg_append_only()', t);
  END LOOP;
END $$;

-- An account keeps its meaning once it has postings: name and active flag may
-- change; code, type and control may not.
CREATE OR REPLACE FUNCTION trg_gl_account_keeps_meaning() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.code, NEW.type, NEW.control, NEW.tenant_id) IS DISTINCT FROM (OLD.code, OLD.type, OLD.control, OLD.tenant_id)
     AND EXISTS (SELECT 1 FROM gl_line WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'ACCOUNT_IN_USE: account % has postings; its code, type and control stay as they are', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION trg_gl_account_keeps_meaning() OWNER TO fcms_ledger;
DROP TRIGGER IF EXISTS trg_gl_account_keeps_meaning ON gl_account;
CREATE TRIGGER trg_gl_account_keeps_meaning BEFORE UPDATE ON gl_account FOR EACH ROW EXECUTE FUNCTION trg_gl_account_keeps_meaning();
