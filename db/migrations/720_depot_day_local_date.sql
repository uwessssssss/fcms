-- 720: a depot day counts the loads of ITS day.
--
-- fn_close_depot_day (500) took the day's loads with loaded_at::date -- the
-- date in the database server's zone, which is UTC. A truck loaded at 01:00
-- in Kampala (22:00 UTC the day before) counted toward the previous day, so
-- each day's tolerance percentage was worked out on the wrong litres. The
-- site's own business date (its zone and the hour its day starts) decides.
-- The same fault dated loads, transfers and deliveries in the depot day
-- screen (v_depot_day_activity) and the per-site performance report
-- (v_site_performance): both now use fn_business_date, and the latter counts
-- fuel revenue line by line as the attendants were charged.

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
       AND fn_business_date(bs.site_id, bs.loaded_at) = v_shift.business_date;   -- (720) the depot's day, not UTC's

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
   WHERE bs.site_id = s.site_id AND fn_business_date(bs.site_id, bs.loaded_at) = s.business_date
) l ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS transfers, SUM(st.litres) AS litres
    FROM stock_transfer st
   WHERE st.from_site_id = s.site_id AND fn_business_date(st.from_site_id, st.moved_at) = s.business_date
) t ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS deliveries, SUM(dl.received_litres) AS litres
    FROM delivery dv JOIN delivery_line dl ON dl.delivery_id = dv.id
   WHERE dv.site_id = s.site_id AND fn_business_date(dv.site_id, dv.decant_ended_at) = s.business_date
) d ON TRUE
WHERE s.is_depot_day;

CREATE OR REPLACE VIEW v_site_performance AS
WITH retail_lines AS (
  SELECT s.site_id, s.business_date, me.tank_id,
         SUM(md.litres)                 AS litres,
         SUM(round(md.litres * md.unit_price, 2)) AS revenue   -- (720) as charged
    FROM meter_event me
    JOIN metered_disposition md
      ON md.meter_event_id = me.id AND md.kind = 'SALE'
    JOIN shift s ON s.id = me.shift_id
   GROUP BY s.site_id, s.business_date, me.tank_id
), retail AS (
  -- Each tank-DAY costed once, at its moving average as that day ended. This
  -- used one cost per tank AS AT NOW for every past day: a delivery today
  -- rewrote what last month's sales cost -- the very thing the bulk-sale
  -- comment below forbids for loads.
  SELECT site_id, business_date,
         SUM(litres)  AS litres,
         SUM(revenue) AS revenue,
         SUM(litres * COALESCE(fn_weighted_avg_cost(tank_id, (business_date + 1)::timestamptz), 0)) AS cost
    FROM retail_lines
   GROUP BY site_id, business_date
), wholesale AS (
  SELECT bs.site_id, fn_business_date(bs.site_id, bs.loaded_at) AS business_date,
         SUM(bs.litres)                             AS litres,
         SUM(bs.amount)                             AS revenue,
         -- Cost captured at the moment of sale, never recomputed: a later
         -- delivery must not rewrite what an old load was worth.
         SUM(bs.litres * COALESCE(bs.unit_cost, 0)) AS cost
    FROM bulk_sale bs
   GROUP BY bs.site_id, fn_business_date(bs.site_id, bs.loaded_at)
), dates AS (
  SELECT site_id, business_date FROM retail
  UNION
  SELECT site_id, business_date FROM wholesale
)
SELECT
  si.id AS site_id, si.code AS site_code, si.name AS site_name,
  si.kind::text AS site_kind, d.business_date,
  COALESCE(r.litres, 0)  AS retail_litres,
  COALESCE(r.revenue, 0) AS retail_revenue,
  COALESCE(r.cost, 0)    AS retail_cost,
  COALESCE(w.litres, 0)  AS bulk_litres,
  COALESCE(w.revenue, 0) AS bulk_revenue,
  COALESCE(w.cost, 0)    AS bulk_cost,
  COALESCE(r.revenue, 0) + COALESCE(w.revenue, 0) AS revenue,
  COALESCE(r.cost, 0)    + COALESCE(w.cost, 0)    AS cost,
  COALESCE(r.revenue, 0) + COALESCE(w.revenue, 0)
    - COALESCE(r.cost, 0) - COALESCE(w.cost, 0)   AS margin
FROM dates d
JOIN site si ON si.id = d.site_id
LEFT JOIN retail    r ON r.site_id = d.site_id AND r.business_date = d.business_date
LEFT JOIN wholesale w ON w.site_id = d.site_id AND w.business_date = d.business_date;
