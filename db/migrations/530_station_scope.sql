-- =============================================================================
-- FCMS v2 -- 530_station_scope.sql
--
-- ONE STATION COULD WRITE ANOTHER'S RECORDS. Row-level security keeps each
-- company apart, but within a company nothing kept stations apart: a supervisor
-- at station A could close station B's shift, record its credit sales, receive
-- its deliveries or post its stock count, by changing an id in the request. 22
-- API endpoints took an id and checked no station; only approval did (240).
--
-- Fixed here once, for every way in -- today's endpoints and any added later:
-- a person based at a station may write that station's records only.
--
--   anywhere      HEAD_OFFICE, DIRECTOR, SYSTEM_ADMIN, ADMIN, AUDITOR, and
--                 anyone based at the head office (an accountant there, say)
--   own station   everyone else
--   a depot       also a MANAGER or SUPERVISOR from a station of the same
--                 company -- the depot is run on the shift permissions today,
--                 by the station's people. A depot with its own staff can
--                 drop this line.
--
-- No acting person (a seed, a migration, a background job) is not judged.
-- Reading across stations is unchanged here: the API scopes the station views
-- it serves (RequireSiteView).
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_station_scope_ok(p_site uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  v_role staff_role; v_home uuid; v_home_kind site_kind; v_target_kind site_kind;
BEGIN
  IF v_actor IS NULL OR p_site IS NULL THEN
    RETURN TRUE;
  END IF;
  SELECT s.role, s.site_id, si.kind INTO v_role, v_home, v_home_kind
    FROM staff s LEFT JOIN site si ON si.id = s.site_id
   WHERE s.id = v_actor;
  IF v_role IS NULL THEN
    RETURN FALSE;                    -- an acting person this company cannot see
  END IF;
  IF v_role IN ('HEAD_OFFICE', 'DIRECTOR', 'SYSTEM_ADMIN', 'ADMIN', 'AUDITOR')
     OR v_home_kind = 'HEAD_OFFICE' OR v_home = p_site THEN
    RETURN TRUE;
  END IF;
  SELECT kind INTO v_target_kind FROM site WHERE id = p_site;
  RETURN v_target_kind = 'DEPOT' AND v_role IN ('MANAGER', 'SUPERVISOR');
END $$;

CREATE OR REPLACE FUNCTION trg_station_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_who text; v_here text; v_there text;
BEGIN
  IF fn_station_scope_ok(NEW.site_id) THEN
    RETURN NEW;
  END IF;
  SELECT s.full_name, si.name INTO v_who, v_here
    FROM staff s LEFT JOIN site si ON si.id = s.site_id
   WHERE s.id = NULLIF(current_setting('app.staff_id', true), '')::uuid;
  SELECT name INTO v_there FROM site WHERE id = NEW.site_id;
  RAISE EXCEPTION 'OTHER_STATION: % works at %, and this belongs to %. Only that '
    'station''s people, or head office, can record it.',
    COALESCE(v_who, 'This person'), COALESCE(v_here, 'another site'), COALESCE(v_there, 'another site')
    USING ERRCODE = 'check_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shift', 'nozzle_assignment', 'meter_reading', 'dip_reading', 'credit_sale',
    'dry_sale', 'discount_grant', 'pump_test', 'own_use', 'return_to_tank',
    'cash_up', 'delivery', 'stock_count', 'dry_count', 'expense', 'banking',
    'other_income', 'bulk_sale', 'price_change', 'supplier_payment', 'exception_flag']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS station_scope ON %I', t);
    EXECUTE format('CREATE TRIGGER station_scope BEFORE INSERT OR UPDATE ON %I '
                   'FOR EACH ROW EXECUTE FUNCTION trg_station_scope()', t);
  END LOOP;
END $$;
