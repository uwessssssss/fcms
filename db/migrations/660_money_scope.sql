-- =============================================================================
-- 660 Money accounts keep to their station (audit November 2026, A1)
--
-- Bank reconciliation (630) was gated by the banking.record and report.view
-- permissions, which a station MANAGER holds. So a manager at one station could
-- see every bank and wallet balance of the company, open accounts, record
-- transfers between the company's accounts, and import and match its bank
-- statements -- while the books (620) show that same manager their own station
-- only. And 530's station rule passes any record with no site, which is exactly
-- what a company-level bank account is.
--
-- The rule now, for writes (triggers) and reads (the API filters with it):
--   an account of a station   that station's people, or head office (530)
--   a company account         head office, a director, the platform, or anyone
--   (no site)                 based at the head office (an accountant there)
-- No acting person (a seed, a migration, a background job) is not judged.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_company_scope_ok()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_role staff_role; v_home_kind site_kind;
BEGIN
  IF v_actor IS NULL THEN RETURN TRUE; END IF;
  SELECT s.role, si.kind INTO v_role, v_home_kind
    FROM staff s LEFT JOIN site si ON si.id = s.site_id WHERE s.id = v_actor;
  RETURN v_role IN ('HEAD_OFFICE', 'DIRECTOR', 'SYSTEM_ADMIN', 'ADMIN', 'AUDITOR') OR v_home_kind = 'HEAD_OFFICE';
END $$;

CREATE OR REPLACE FUNCTION fn_money_scope_ok(p_account uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid;
BEGIN
  SELECT site_id INTO v_site FROM money_account WHERE id = p_account;
  IF v_site IS NULL THEN RETURN fn_company_scope_ok(); END IF;
  RETURN fn_station_scope_ok(v_site);
END $$;

CREATE OR REPLACE FUNCTION trg_money_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  IF TG_TABLE_NAME = 'money_account' THEN
    ok := CASE WHEN NEW.site_id IS NULL THEN fn_company_scope_ok() ELSE fn_station_scope_ok(NEW.site_id) END;
  ELSIF TG_TABLE_NAME = 'money_transfer' THEN
    ok := fn_money_scope_ok(NEW.from_account) AND fn_money_scope_ok(NEW.to_account);
  ELSE   -- bank_statement, bank_statement_line, bank_match
    ok := fn_money_scope_ok(NEW.money_account_id);
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'OTHER_STATION: this bank or mobile-money account belongs to another station, or to the company; '
      'its owners or head office keep it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['money_account', 'money_transfer', 'bank_statement', 'bank_statement_line', 'bank_match'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_money_scope ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_money_scope BEFORE INSERT OR UPDATE ON %1$I '
                   'FOR EACH ROW EXECUTE FUNCTION trg_money_scope()', t);
  END LOOP;
END $$;
