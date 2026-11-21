-- =============================================================================
-- FCMS v2 -- 190_dips_in_litres.sql
--
-- A dip is entered in LITRES.
--
-- The system asked for millimetres and converted through a calibration chart.
-- That was wrong for this operation, for a reason worth writing down: the
-- number an operator actually has in front of them is litres. They read the
-- stick, they look it up on the chart taped to the office wall, and the figure
-- they carry to the office IS the volume. Asking them to type the millimetres
-- so the system can redo a conversion they have already done adds a step, adds
-- a place to mistype, and makes every figure depend on a chart that was seeded
-- as a straight line and never replaced.
--
-- Worse: a linear placeholder chart makes every converted litre WRONG in a way
-- that looks entirely plausible. A real tank is a cylinder -- the ends are
-- curved, so litres per millimetre changes with depth. Removing the conversion
-- removes that whole class of quiet error.
--
-- So litres are now what is recorded and what everything downstream reads.
-- dip_mm becomes optional -- kept, because a station that does record the
-- stick reading should be able to, and because the history already has them.
-- =============================================================================

ALTER TABLE dip_reading ALTER COLUMN dip_mm DROP NOT NULL;
ALTER TABLE dip_reading ALTER COLUMN water_dip_mm DROP NOT NULL;

COMMENT ON COLUMN dip_reading.dip_mm IS
  'The stick reading, if it was recorded. Optional: litres are what the system '
  'uses. Converting mm to litres needs a calibration chart, and a chart that is '
  'wrong makes every litre wrong in a way that looks plausible.';

COMMENT ON COLUMN dip_reading.product_litres IS
  'What is in the tank. This is the figure entered by the operator and the '
  'figure every reconciliation reads.';

-- ---------------------------------------------------------------------------
-- Read a dip from whichever form was given.
--
-- Litres win when present. Millimetres still work, so nothing already written
-- breaks and a station with a real certificate can keep using it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_dip_litres(p_tank_id uuid, p_row jsonb)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v numeric;
BEGIN
  v := NULLIF(p_row->>'product_litres', '')::numeric;
  IF v IS NOT NULL THEN
    RETURN v;
  END IF;

  v := NULLIF(p_row->>'litres', '')::numeric;
  IF v IS NOT NULL THEN
    RETURN v;
  END IF;

  v := NULLIF(p_row->>'dip_mm', '')::numeric;
  IF v IS NOT NULL THEN
    RETURN fn_dip_to_litres(p_tank_id, v);
  END IF;

  RAISE EXCEPTION
    'DIP_MISSING: a dip needs either product_litres or dip_mm. Nothing was given '
    'for this tank.'
    USING ERRCODE = 'check_violation';
END $$;

CREATE OR REPLACE FUNCTION fn_water_litres(p_tank_id uuid, p_row jsonb)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v numeric;
BEGIN
  v := NULLIF(p_row->>'water_litres', '')::numeric;
  IF v IS NOT NULL THEN
    RETURN v;
  END IF;

  v := NULLIF(p_row->>'water_dip_mm', '')::numeric;
  IF v IS NOT NULL AND v > 0 THEN
    RETURN fn_dip_to_litres(p_tank_id, v);
  END IF;

  RETURN 0;
END $$;

COMMENT ON FUNCTION fn_dip_litres IS
  'Litres from a dip row, however it was given. Litres directly if present, '
  'otherwise converted from millimetres. Litres are the preferred form.';

-- ---------------------------------------------------------------------------
-- A litres figure still has to be possible.
--
-- Losing the chart lookup loses the check it carried: a stick reading above
-- the chart was refused as an overfill or a misread. Entering litres needs the
-- same guard, against the tank's own safe fill.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_dip_litres_plausible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_tank tank%ROWTYPE;
BEGIN
  SELECT * INTO v_tank FROM tank WHERE id = NEW.tank_id;

  IF NEW.product_litres > v_tank.nominal_litres THEN
    RAISE EXCEPTION
      'DIP_ABOVE_CAPACITY: % litres in %, which holds % at absolute capacity. '
      'That is an overfill or a misread -- both need a person, not a number.',
      round(NEW.product_litres, 1), v_tank.code, v_tank.nominal_litres
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.product_litres > v_tank.safe_fill THEN
    -- Above safe fill but below capacity is possible and worth flagging: it
    -- means the last delivery went in further than it should have.
    PERFORM fn_raise_flag(NEW.tenant_id, NEW.site_id, NEW.shift_id,
      'tank', NEW.tank_id::text, 'ABOVE_SAFE_FILL', 'WARN',
      jsonb_build_object('litres', round(NEW.product_litres, 1),
                         'safe_fill', v_tank.safe_fill,
                         'tank', v_tank.code));
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dip_litres_plausible ON dip_reading;
CREATE TRIGGER dip_litres_plausible
  BEFORE INSERT ON dip_reading
  FOR EACH ROW EXECUTE FUNCTION trg_dip_litres_plausible();

COMMENT ON FUNCTION trg_dip_litres_plausible IS
  'Replaces the check the chart lookup used to carry. A dip above the tank''s '
  'capacity is impossible; above safe fill is possible and worth a flag.';
