-- =============================================================================
-- FCMS v2 -- 140_depot_day.sql
--
-- The depot needs closing too.
--
-- Bulk sales were being recorded and nothing ever checked them against the
-- ground. That quietly breaks the one promise this system makes: a station
-- cannot close without accounting for every litre, and a depot moving four
-- times the volume was closing on trust.
--
-- A depot day is the same idea as a shift, with different content:
--
--   a station shift reconciles METER READINGS against dips and CASH against
--   sales;
--
--   a depot day reconciles GANTRY LOADS against dips, and there is usually no
--   cash at all -- wholesale is invoiced.
--
-- So it reuses the shift table rather than inventing a parallel one. Same
-- opening dips, same closing dips, same refusal to close on an unexplained
-- variance. What differs is what sits in the middle.
-- =============================================================================

-- A depot day has no nozzles, so the roster requirement must not apply to it.
-- The existing constraint assumed every shift has attendants.
ALTER TABLE shift ADD COLUMN IF NOT EXISTS is_depot_day boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN shift.is_depot_day IS
  'A depot day: dips and gantry loads, no nozzles and no cash-ups. Reuses this '
  'table because the discipline is identical -- only the middle differs.';

-- ---------------------------------------------------------------------------
-- Open a depot day.
--
-- Opening dips are mandatory here for the same reason they are at a station:
-- the closing variance is measured against them, and a day opened without them
-- can be closed with any number at all.
-- ---------------------------------------------------------------------------
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

  v_date := COALESCE(p_date, fn_business_date(p_site_id));

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
                             captured_at, recorded_by)
    VALUES (v_tenant, p_site_id, v_tank.id, v_shift, 'SHIFT_OPEN',
            NULLIF(v_dip->>'dip_mm','')::numeric,
            NULLIF(v_dip->>'water_dip_mm','')::numeric,
            v_litres, v_water, now(), p_actor);
  END LOOP;

  RETURN v_shift;
END $$;

-- ---------------------------------------------------------------------------
-- Close a depot day.
--
-- The invariant is identical to a station close and worth stating plainly:
-- what the ledger says is in the ground must match what the dipstick found, or
-- somebody explains the difference in writing.
--
-- The arithmetic is simpler than a shift because there are no meters and no
-- cash. It is also less forgiving, because depot volumes are large enough that
-- a percentage tolerance alone would let thousands of litres pass -- so the
-- litre floor does the real work here.
-- ---------------------------------------------------------------------------
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
                             captured_at, recorded_by)
    VALUES (v_shift.tenant_id, v_shift.site_id, v_tank.id, p_shift_id, 'SHIFT_CLOSE',
            NULLIF(v_dip->>'dip_mm','')::numeric,
            NULLIF(v_dip->>'water_dip_mm','')::numeric,
            v_litres, v_water, now(), p_actor);

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

COMMENT ON FUNCTION fn_close_depot_day IS
  'Same invariant as a station close: the ledger and the dipstick must agree, '
  'or somebody explains the difference in writing.';

-- ---------------------------------------------------------------------------
-- What happened on a depot day, for the close screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_depot_day_activity AS
SELECT
  s.id                                   AS shift_id,
  s.site_id,
  s.business_date,
  s.state::text,
  s.opened_at,
  s.closed_at,
  COALESCE(l.loads, 0)                   AS loads,
  COALESCE(l.litres, 0)                  AS litres_out,
  COALESCE(l.revenue, 0)                 AS revenue,
  COALESCE(l.cost, 0)                    AS cost,
  COALESCE(l.revenue, 0) - COALESCE(l.cost, 0) AS margin,
  COALESCE(l.below_cost, 0)              AS loads_below_cost,
  COALESCE(t.transfers, 0)               AS transfers_out,
  COALESCE(t.litres, 0)                  AS transfer_litres,
  COALESCE(d.deliveries, 0)              AS deliveries_in,
  COALESCE(d.litres, 0)                  AS delivered_litres
FROM shift s
LEFT JOIN LATERAL (
  SELECT count(*) AS loads, SUM(bs.litres) AS litres, SUM(bs.amount) AS revenue,
         SUM(bs.litres * COALESCE(bs.unit_cost, 0)) AS cost,
         count(*) FILTER (WHERE bs.unit_price < bs.unit_cost) AS below_cost
    FROM bulk_sale bs
   WHERE bs.site_id = s.site_id AND bs.loaded_at::date = s.business_date
) l ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS transfers, SUM(st.litres) AS litres
    FROM stock_transfer st
   WHERE st.from_site_id = s.site_id AND st.moved_at::date = s.business_date
) t ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS deliveries, SUM(dl.received_litres) AS litres
    FROM delivery dv JOIN delivery_line dl ON dl.delivery_id = dv.id
   WHERE dv.site_id = s.site_id AND dv.decant_ended_at::date = s.business_date
) d ON TRUE
WHERE s.is_depot_day;
