-- =============================================================================
-- FCMS v2 -- 400_price_break_timing.sql
--
-- fn_execute_price_break as in 070, with one rule added (marked 400): a
-- change executed before its scheduled time takes effect when executed.
-- Re-issued whole: PL/pgSQL cannot patch a function body.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_execute_price_break(
  p_price_change_id uuid, p_actor uuid,
  p_readings jsonb, p_dips jsonb, p_cashups jsonb, p_next_roster jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pc price_change%ROWTYPE; v_live uuid; v_next uuid; v_closed jsonb;
BEGIN
  SELECT * INTO v_pc FROM price_change WHERE id = p_price_change_id FOR UPDATE;
  IF v_pc.status <> 'PENDING' THEN
    RAISE EXCEPTION 'PRICE_NOT_PENDING: change is %', v_pc.status USING ERRCODE='check_violation';
  END IF;

  PERFORM 1 FROM site WHERE id = v_pc.site_id FOR UPDATE;

  -- Executed EARLY: the new price took effect NOW, when the pumps changed. A
  -- change scheduled for 18:00 and executed at 17:58 kept effective_from at
  -- 18:00, so the segment opened at 17:58 captured the OLD price -- and the
  -- change, marked executed, never came due again. The pumps showed the new
  -- price for the whole segment while attendants were billed at the old one:
  -- on a price cut, every attendant charged a shortage on every litre (400).
  -- Executed late is already right: the old segment sold at the old price.
  IF v_pc.effective_from > now() THEN
    UPDATE price_change SET effective_from = now() WHERE id = p_price_change_id;
    v_pc.effective_from := now();
  END IF;

  SELECT id INTO v_live FROM shift
   WHERE site_id = v_pc.site_id AND state IN ('OPEN','COUNTING');

  IF v_live IS NULL THEN
    -- Station closed: nothing to cut, and the schema says so explicitly rather
    -- than leaving the executed change with dangling shift references.
    UPDATE price_change SET status='EXECUTED', executed_at=now(), no_shift_to_break=TRUE
     WHERE id = p_price_change_id;
    RETURN jsonb_build_object('executed', TRUE, 'broke_shift', FALSE);
  END IF;

  v_closed := fn_close_shift(v_live, p_actor, 'PRICE_CHANGE',
                             p_readings, p_dips, p_cashups);

  UPDATE price_change SET status='EXECUTED', executed_at=now(), shift_closed_id=v_live
   WHERE id = p_price_change_id;

  -- The new price must be executed BEFORE the successor opens, so that
  -- fn_capture_shift_prices stamps the new figure onto it.
  v_next := fn_open_shift(v_pc.site_id,
              (SELECT label FROM shift WHERE id = v_live),
              p_actor,
              (SELECT jsonb_agg(jsonb_build_object('tank_id', d->>'tank_id',
                                                   'dip_mm', d->>'dip_mm',
                                                   'water_dip_mm', d->>'water_dip_mm'))
                 FROM jsonb_array_elements(p_dips) d),
              p_next_roster, v_live);

  UPDATE price_change SET shift_opened_id = v_next WHERE id = p_price_change_id;

  RETURN jsonb_build_object('executed', TRUE, 'broke_shift', TRUE,
    'shift_closed', v_live, 'shift_opened', v_next, 'close', v_closed);
END $$;

