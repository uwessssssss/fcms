-- =============================================================================
-- FCMS v2 -- 500_depot_day_closes.sql
--
-- Found by the second real run (89 | 1 | 90): with 490, a depot day OPENED, but
-- closing it still failed, twice over in one statement:
--   * it set shift.state = 'CLOSED' -- shift_state has no such value; a closed
--     shift is DECLARED (figures in, awaiting approval), as at a station;
--   * it set close_note -- shift has no such column; the note goes in `notes`.
-- Reading the whole function after that found two logic faults as well:
--   * the variance was the standing tank-against-book gap -- after one loss,
--     every later day was critical and REFUSED to close without a reason for
--     it; it is now the change since the previous close, as at a station (430);
--   * either tolerance passing was enough; a station needs both, so a large
--     loss cannot hide inside a small percentage of depot volumes.
-- My value check had combined allowed values across tables by column name, so
-- nozzle_assignment's 'CLOSED' hid this; and updates were never checked for
-- columns that do not exist. Both checks are now per table.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_close_depot_day(
  p_shift_id uuid,
  p_actor    uuid,
  p_dips     jsonb,          -- [{tank_id, dip_mm, water_dip_mm, variance_reason}]
  p_reason   close_reason DEFAULT 'SCHEDULED',
  p_note     text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_shift shift%ROWTYPE; v_policy tenant_policy%ROWTYPE;
  v_dip jsonb; v_tank tank%ROWTYPE;
  v_litres numeric; v_water numeric; v_book numeric; v_variance numeric;
  v_sold numeric; v_pct numeric; v_within boolean;
  v_result jsonb := '[]'::jsonb; v_unexplained text[] := '{}';
BEGIN
  SELECT * INTO v_shift FROM shift WHERE id = p_shift_id FOR UPDATE;
  IF v_shift.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_SHIFT' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT v_shift.is_depot_day THEN
    RAISE EXCEPTION
      'NOT_A_DEPOT_DAY: that is a station shift. Close it on the shift screen.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_shift.state <> 'OPEN' THEN
    RAISE EXCEPTION 'ALREADY_CLOSED: this day is %.', lower(v_shift.state::text)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_policy FROM tenant_policy WHERE tenant_id = v_shift.tenant_id;

  FOR v_dip IN SELECT * FROM jsonb_array_elements(p_dips) LOOP
    SELECT * INTO v_tank FROM tank WHERE id = (v_dip->>'tank_id')::uuid;

    -- Litres if given, converted from millimetres if not.
    v_litres := fn_dip_litres(v_tank.id, v_dip);
    v_water  := fn_water_litres(v_tank.id, v_dip);

    INSERT INTO dip_reading (tenant_id, site_id, tank_id, shift_id, context,
                             dip_mm, water_dip_mm, product_litres, water_litres,
                             gross_litres, captured_at, recorded_by)
    VALUES (v_shift.tenant_id, v_shift.site_id, v_tank.id, p_shift_id, 'SHIFT_CLOSE',
            NULLIF(v_dip->>'dip_mm','')::numeric,
            NULLIF(v_dip->>'water_dip_mm','')::numeric,
            v_litres, v_water,
            -- (490) gross is required: product + water, as every other dip writes it.
            v_litres + COALESCE(v_water, 0), now(), p_actor);

    v_book     := fn_book_stock(v_tank.id);
    -- (500) What THIS day lost -- the change since the tank's previous close --
    -- as at a station (430). The standing gap made every day after one real
    -- loss critical, and this close REFUSES an unexplained variance: each later
    -- day would have demanded a reason for that one old loss.
    v_variance := fn_close_variance(v_tank.id, v_litres, now(), p_shift_id);

    -- Everything that left this tank today, however it left.
    SELECT COALESCE(SUM(bs.litres), 0) INTO v_sold
      FROM bulk_sale bs
     WHERE bs.tank_id = v_tank.id
       AND bs.loaded_at::date = v_shift.business_date;

    v_pct := CASE WHEN v_sold > 0 THEN abs(v_variance) / v_sold * 100 END;

    -- Both tests must pass. A percentage alone lets a large loss hide behind a
    -- busy day; a litre floor alone punishes a quiet one.
    -- (500) BOTH limits, as at a station. Either-or let a loss hide inside a
    -- small percentage -- at depot volumes, 0.5% of 200,000 L is 1,000 L.
    v_within := abs(v_variance) <= v_policy.shift_variance_litres
                AND (v_pct IS NULL OR v_pct <= v_policy.shift_variance_pct);

    IF NOT v_within AND COALESCE(trim(v_dip->>'variance_reason'), '') = '' THEN
      v_unexplained := v_unexplained || v_tank.code;
    END IF;

    IF NOT v_within THEN
      PERFORM fn_raise_flag(v_shift.tenant_id, v_shift.site_id, p_shift_id,
        'tank', v_tank.id::text, 'STOCK_VARIANCE', 'CRITICAL',
        jsonb_build_object('tank', v_tank.code, 'book', round(v_book, 3),
                           'dipped', round(v_litres, 3),
                           'variance', round(v_variance, 3),
                           'loaded_out', v_sold,
                           'reason', v_dip->>'variance_reason'));
    END IF;

    v_result := v_result || jsonb_build_object(
      'tank', v_tank.code, 'book', round(v_book, 3), 'dipped', round(v_litres, 3),
      'variance', round(v_variance, 3), 'loaded_out', v_sold,
      'variance_pct', round(v_pct, 4), 'within_tolerance', v_within);
  END LOOP;

  IF array_length(v_unexplained, 1) > 0 THEN
    RAISE EXCEPTION
      'UNEXPLAINED_VARIANCE: % is outside tolerance and no reason was given. '
      'At depot volumes a difference this size is thousands of litres of fuel '
      'somebody has to account for.',
      array_to_string(v_unexplained, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE shift
     -- (500) DECLARED, as a station close: closed, figures in, awaiting approval.
     -- 'CLOSED' is not a shift state, and the note's column is `notes`.
     SET state = 'DECLARED', closed_at = now(), closed_by = p_actor,
         closed_reason = p_reason, notes = p_note
   WHERE id = p_shift_id;

  RETURN jsonb_build_object(
    'shift_id', p_shift_id,
    'business_date', v_shift.business_date,
    'tanks', v_result);
END $$;
