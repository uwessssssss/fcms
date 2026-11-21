-- =============================================================================
-- FCMS v2 -- 340_equipment_wiring_frozen.sql
--
-- Once equipment has been USED, the parts that give its history meaning stop
-- being editable. Its settings do not.
--
-- Nothing protected this. With equipment.manage anyone could:
--   * move a tank that has held diesel to petrol -- its ledger would then
--     mix two fuels, and every reconciliation after that is wrong;
--   * rewire a used nozzle to a different tank -- the litres it has already
--     pumped were drawn from the old tank, and an open shift would reconcile
--     against the wrong one;
--   * change a used nozzle's digit count -- the rollover point is
--     10^digits, so an existing pair of readings could flip from "rolled
--     over" to "ran backwards", or the reverse.
--
-- The screen used to refuse ALL edits to hide this. That blocked the harmless
-- ones too -- a corrected serial number, a tank's dead stock from its chart.
-- The rule belongs here, where it holds whatever calls the database:
--
--   FREEZES once used   tank.product_id; nozzle.pump_id, tank_id, integer_digits
--   STAYS EDITABLE      codes, capacities, safe fill, dead stock, dip limits,
--                       make, serial, flow rate
--
-- A wrongly-wired nozzle is corrected the way the ledger corrects anything:
-- switch it off and add the right one, so both histories stay true.
-- =============================================================================

CREATE OR REPLACE FUNCTION trg_tank_product_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id
     AND (EXISTS (SELECT 1 FROM fuel_movement WHERE tank_id = OLD.id)
          OR EXISTS (SELECT 1 FROM dip_reading WHERE tank_id = OLD.id)
          -- A nozzle drawing from it has pumped: the tank has held the product
          -- even before any close posted a movement.
          OR EXISTS (SELECT 1 FROM meter_reading mr JOIN nozzle n ON n.id = mr.nozzle_id
                      WHERE n.tank_id = OLD.id)) THEN
    RAISE EXCEPTION
      'TANK_PRODUCT_FROZEN: tank % has already held fuel. Its product cannot '
      'change, or its ledger would mix two fuels. Switch it off and add a new tank.', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tank_product_frozen ON tank;
CREATE TRIGGER tank_product_frozen
  BEFORE UPDATE OF product_id ON tank
  FOR EACH ROW EXECUTE FUNCTION trg_tank_product_frozen();

CREATE OR REPLACE FUNCTION trg_nozzle_wiring_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pump_id IS DISTINCT FROM OLD.pump_id
      OR NEW.tank_id IS DISTINCT FROM OLD.tank_id
      OR NEW.integer_digits IS DISTINCT FROM OLD.integer_digits)
     AND EXISTS (SELECT 1 FROM meter_reading WHERE nozzle_id = OLD.id) THEN
    RAISE EXCEPTION
      'NOZZLE_WIRING_FROZEN: nozzle % has meter readings. Its pump, tank and '
      'digit count give those readings their meaning. Switch it off and add '
      'the correctly-wired nozzle instead.', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nozzle_wiring_frozen ON nozzle;
CREATE TRIGGER nozzle_wiring_frozen
  BEFORE UPDATE OF pump_id, tank_id, integer_digits ON nozzle
  FOR EACH ROW EXECUTE FUNCTION trg_nozzle_wiring_frozen();
