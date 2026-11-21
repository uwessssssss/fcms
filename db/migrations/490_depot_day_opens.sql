-- =============================================================================
-- FCMS v2 -- 490_depot_day_opens.sql
--
-- Found by checking the code against the database's own rules, after the
-- first real run showed which bugs only appear at runtime. A depot day could
-- never be opened or closed through the app, for two reasons, each enough:
--
--   1. fn_open_depot_day called fn_business_date(site) with ONE argument. The
--      function takes two (site, moment) with no default, so it does not exist
--      in that form -- resolved when the expression is planned, so even the
--      COALESCE around it did not help.
--   2. Both functions inserted a dip without gross_litres, which is required
--      (and must equal product + water). Every other dip in the system writes it.
--
-- Nothing caught either: no test opened a depot day, and the depot seed writes
-- its day directly rather than through these functions. Both are re-issued
-- from 140 with only those changes, marked (490).
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_open_depot_day(
  p_site_id  uuid,
  p_actor    uuid,
  p_dips     jsonb,          -- [{tank_id, dip_mm, water_dip_mm}]
  p_date     date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_date date; v_shift uuid; v_dip jsonb;
  v_tank tank%ROWTYPE; v_litres numeric; v_water numeric; v_kind site_kind;
BEGIN
  SELECT tenant_id, kind INTO v_tenant, v_kind FROM site WHERE id = p_site_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_SITE: %', p_site_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_kind <> 'DEPOT' THEN
    RAISE EXCEPTION
      'NOT_A_DEPOT: that site sells through nozzles. Open a shift instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (490) fn_business_date takes the moment too; called with one argument it
  -- does not exist, and this failed before it did anything else.
  v_date := COALESCE(p_date, fn_business_date(p_site_id, now()));

  IF jsonb_array_length(COALESCE(p_dips, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION
      'DIPS_REQUIRED: dip every tank before opening. The closing variance is '
      'measured against these, so a day opened without them can be closed '
      'with any figure at all.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO shift (tenant_id, site_id, business_date, label, segment,
                     state, opened_at, opened_by, is_depot_day)
  VALUES (v_tenant, p_site_id, v_date, 'DAY', 1, 'OPEN', now(), p_actor, true)
  RETURNING id INTO v_shift;

  FOR v_dip IN SELECT * FROM jsonb_array_elements(p_dips) LOOP
    SELECT * INTO v_tank FROM tank WHERE id = (v_dip->>'tank_id')::uuid;
    IF v_tank.id IS NULL OR v_tank.site_id <> p_site_id THEN
      RAISE EXCEPTION 'TANK_NOT_AT_SITE: %', v_dip->>'tank_id'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Litres if given, converted from millimetres if not.
    v_litres := fn_dip_litres(v_tank.id, v_dip);
    v_water  := fn_water_litres(v_tank.id, v_dip);

    INSERT INTO dip_reading (tenant_id, site_id, tank_id, shift_id, context,
                             dip_mm, water_dip_mm, product_litres, water_litres,
                             gross_litres, captured_at, recorded_by)
    VALUES (v_tenant, p_site_id, v_tank.id, v_shift, 'SHIFT_OPEN',
            NULLIF(v_dip->>'dip_mm','')::numeric,
            NULLIF(v_dip->>'water_dip_mm','')::numeric,
            v_litres, v_water,
            -- (490) gross is required: product + water, as every other dip writes it.
            v_litres + COALESCE(v_water, 0), now(), p_actor);
  END LOOP;

  RETURN v_shift;
END $$;

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
    v_variance := v_litres - v_book;

    -- Everything that left this tank today, however it left.
    SELECT COALESCE(SUM(bs.litres), 0) INTO v_sold
      FROM bulk_sale bs
     WHERE bs.tank_id = v_tank.id
       AND bs.loaded_at::date = v_shift.business_date;

    v_pct := CASE WHEN v_sold > 0 THEN abs(v_variance) / v_sold * 100 END;

    -- Both tests must pass. A percentage alone lets a large loss hide behind a
    -- busy day; a litre floor alone punishes a quiet one.
    v_within := abs(v_variance) <= v_policy.shift_variance_litres
                OR (v_pct IS NOT NULL AND v_pct <= v_policy.shift_variance_pct);

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
     SET state = 'CLOSED', closed_at = now(), closed_by = p_actor,
         closed_reason = p_reason, close_note = p_note
   WHERE id = p_shift_id;

  RETURN jsonb_build_object(
    'shift_id', p_shift_id,
    'business_date', v_shift.business_date,
    'tanks', v_result);
END $$;
