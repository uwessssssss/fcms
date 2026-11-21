-- =============================================================================
-- FCMS v2 -- 380_moving_average_cost.sql
--
-- Fuel is costed the way the books cost it: MOVING weighted average.
--
-- fn_weighted_avg_cost took a SIMPLE average of every delivery the tank ever
-- received, as at now. The company's accounts run moving average -- proven in
-- QuickBooks when transferred PMS released at exactly its moving average. The
-- two agree only while the price never moves. Fuel bought at 4,000 last year
-- and 5,000 now averaged 4,500, so today's sales were costed 500/L too low and
-- margin overstated by 500/L. At depot margins measured in tens of shillings a
-- litre, that decides whether a load is flagged as sold below cost.
--
-- Moving average: each costed inflow re-averages what is in the tank; every
-- other movement changes the quantity at the current average. When the tank
-- has run dry or negative, the next delivery sets the average outright --
-- averaging against stock that is not there would carry a ghost cost.
--
-- Same signature, so every caller improves at once. Callers valuing something
-- NOW (a load, a transfer, a dip) were already asking the right question;
-- those valuing the PAST now ask as at the right time (below, and the profit
-- statement in AccountsService).
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_weighted_avg_cost(p_tank_id uuid,
                                                p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_stock numeric := 0;
  v_avg   numeric := NULL;
  r       record;
BEGIN
  FOR r IN SELECT kind, signed_litres, unit_cost
             FROM fuel_movement
            WHERE tank_id = p_tank_id AND occurred_at <= p_at
            ORDER BY occurred_at, id
  LOOP
    IF r.kind IN ('DELIVERY_IN', 'BULK_IN') AND r.unit_cost IS NOT NULL AND r.signed_litres > 0 THEN
      IF v_avg IS NULL OR v_stock <= 0 THEN
        v_avg := r.unit_cost;
      ELSE
        v_avg := (v_stock * v_avg + r.signed_litres * r.unit_cost) / (v_stock + r.signed_litres);
      END IF;
    END IF;
    v_stock := v_stock + r.signed_litres;
  END LOOP;
  RETURN round(v_avg, 4);
END $$;

-- The depot-against-station report, costing each past day as it ended.
CREATE OR REPLACE VIEW v_site_performance AS
WITH retail_lines AS (
  SELECT s.site_id, s.business_date, me.tank_id,
         SUM(md.litres)                 AS litres,
         SUM(md.litres * md.unit_price) AS revenue
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
  SELECT bs.site_id, bs.loaded_at::date AS business_date,
         SUM(bs.litres)                             AS litres,
         SUM(bs.amount)                             AS revenue,
         -- Cost captured at the moment of sale, never recomputed: a later
         -- delivery must not rewrite what an old load was worth.
         SUM(bs.litres * COALESCE(bs.unit_cost, 0)) AS cost
    FROM bulk_sale bs
   GROUP BY bs.site_id, bs.loaded_at::date
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
