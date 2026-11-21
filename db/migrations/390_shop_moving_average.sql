-- =============================================================================
-- FCMS v2 -- 390_shop_moving_average.sql
--
-- Shop stock costed like fuel (380): MOVING weighted average, per item, per
-- station, as at a moment.
--
-- The profit statement costed a shop sale at the most recent purchase price
-- EVER RECORDED for the item -- after the sale as readily as before it, and at
-- any station. A price rise today re-costed last month's lubricant sales, and
-- one station's purchase priced another's sales. The books run moving average
-- for every inventory item, not only fuel.
--
-- Purchases carry a cost; every other movement changes quantity at the
-- current average; a delivery into an empty or negative shelf sets it outright.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_dry_avg_cost(p_item_id uuid, p_site_id uuid,
                                           p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_qty numeric := 0;
  v_avg numeric := NULL;
  r     record;
BEGIN
  FOR r IN SELECT kind::text AS kind, signed_qty, unit_cost
             FROM dry_movement
            WHERE item_id = p_item_id AND site_id = p_site_id AND occurred_at <= p_at
            ORDER BY occurred_at, id
  LOOP
    IF r.kind = 'PURCHASE_IN' AND r.unit_cost IS NOT NULL AND r.signed_qty > 0 THEN
      IF v_avg IS NULL OR v_qty <= 0 THEN
        v_avg := r.unit_cost;
      ELSE
        v_avg := (v_qty * v_avg + r.signed_qty * r.unit_cost) / (v_qty + r.signed_qty);
      END IF;
    END IF;
    v_qty := v_qty + r.signed_qty;
  END LOOP;
  RETURN round(v_avg, 4);
END $$;
