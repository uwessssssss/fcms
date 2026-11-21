-- =============================================================================
-- FCMS v2 -- 460_shortage_carry_warning.sql
--
-- "Most an attendant may owe" (max_shortage_carry) was a setting nothing read.
-- It now WARNS -- it does not block. Putting an attendant who already owes
-- more than the limit on a nozzle raises SHORTAGE_CARRY_EXCEEDED, visible to
-- the manager, and the assignment goes ahead.
--
-- Whether to STOP such an attendant working is a decision about people and
-- about who runs the pumps tonight; it is recorded in HANDOVER as the owner's
-- to make. Turning this into a refusal is one line below: RAISE EXCEPTION in
-- place of fn_raise_flag.
--
-- A handover creates an assignment too, so it warns there as well. A limit of
-- zero means the check is off.
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_shortage_carry_warn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_owed numeric; v_max numeric; v_name text;
BEGIN
  SELECT max_shortage_carry INTO v_max FROM tenant_policy WHERE tenant_id = NEW.tenant_id;
  IF COALESCE(v_max, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT b.outstanding, b.full_name INTO v_owed, v_name
    FROM v_staff_shortage_balance b WHERE b.staff_id = NEW.attendant_id;
  IF COALESCE(v_owed, 0) > v_max THEN
    PERFORM fn_raise_flag(NEW.tenant_id, NEW.site_id, NEW.shift_id, 'nozzle_assignment', NEW.id::text,
                          'SHORTAGE_CARRY_EXCEEDED', 'WARN',
                          jsonb_build_object('attendant', v_name, 'owes', v_owed, 'limit', v_max));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS shortage_carry_warn ON nozzle_assignment;
CREATE TRIGGER shortage_carry_warn AFTER INSERT ON nozzle_assignment
  FOR EACH ROW EXECUTE FUNCTION trg_shortage_carry_warn();
