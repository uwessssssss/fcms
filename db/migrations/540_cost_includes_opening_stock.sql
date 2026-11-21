-- =============================================================================
-- FCMS v2 -- 540_cost_includes_opening_stock.sql
--
-- FUEL WAS COSTED AT ZERO. The moving average (380, 390) counted deliveries and
-- transfers in, but not OPENING_BALANCE -- so a tank whose stock was all
-- opening balance had no cost, the statement showed "Fuel at cost: 0", and the
-- whole of the takings read as margin. The depot was the same, so a transfer
-- out of it took cost "unknown", which fn_transfer_stock turned into 0: the
-- station received the fuel free.
--
-- Found by running the demo seed on a real database: both tanks' average cost
-- came back 0.0000 with 12,400 L and 18,900 L opened at 4,720 and 4,560.
--
-- Now opening stock carries its cost, a recorded cost of 0 counts as unknown
-- (no fuel is free, so the old 0-cost transfers stop dragging averages down),
-- the shop's average counts opening stock and transfers in, and a transfer with
-- no cost basis is refused instead of being given away.
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
    -- (540) Opening stock was paid for too. Leaving it out gave a tank whose
    -- stock is all opening balance NO cost -- every shilling of sales read as
    -- margin. No fuel is free: a cost of 0 (an old transfer) is unknown, not zero.
    IF r.kind IN ('OPENING_BALANCE', 'DELIVERY_IN', 'BULK_IN') AND r.unit_cost > 0 AND r.signed_litres > 0 THEN
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
    -- (540) Opening stock and stock moved in from another site carry cost too.
    IF r.kind IN ('OPENING_BALANCE', 'PURCHASE_IN', 'TRANSFER_IN') AND r.unit_cost > 0 AND r.signed_qty > 0 THEN
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

CREATE OR REPLACE FUNCTION fn_transfer_stock(
  p_reference   text,
  p_from_tank   uuid,
  p_to_tank     uuid,
  p_litres      numeric,
  p_actor       uuid,
  p_truck_reg   text DEFAULT NULL,
  p_moved_at    timestamptz DEFAULT now()
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_from tank%ROWTYPE; v_to tank%ROWTYPE;
  v_cost numeric; v_id uuid; v_available numeric;
BEGIN
  SELECT * INTO v_from FROM tank WHERE id = p_from_tank;
  SELECT * INTO v_to   FROM tank WHERE id = p_to_tank;

  IF v_from.id IS NULL OR v_to.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_TANK' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_from.product_id <> v_to.product_id THEN
    RAISE EXCEPTION
      'PRODUCT_MISMATCH: cannot move fuel from a % tank into a % tank.',
      (SELECT code FROM product WHERE id = v_from.product_id),
      (SELECT code FROM product WHERE id = v_to.product_id)
      USING ERRCODE = 'check_violation';
  END IF;

  -- Dead stock cannot be pumped out, so it is not available to move.
  v_available := fn_book_stock(p_from_tank) - v_from.dead_stock;
  IF p_litres > v_available THEN
    RAISE EXCEPTION
      'NOT_ENOUGH_TO_MOVE: % holds % sellable litres; % were requested.',
      v_from.code, round(v_available, 1), p_litres
      USING ERRCODE = 'check_violation';
  END IF;

  IF fn_book_stock(p_to_tank) + p_litres > v_to.safe_fill THEN
    RAISE EXCEPTION
      'WOULD_OVERFILL: % would exceed its safe fill of % litres.',
      v_to.code, v_to.safe_fill
      USING ERRCODE = 'check_violation';
  END IF;

  -- At cost. Transferring at anything else invents a margin inside the
  -- business and makes both halves of the report wrong.
  -- (540) The receiving station is charged what the fuel cost. An unknown cost
  -- was silently 0, which made the transfer free and the station's margin on it
  -- the whole selling price.
  v_cost := fn_weighted_avg_cost(p_from_tank);
  IF v_cost IS NULL OR v_cost <= 0 THEN
    RAISE EXCEPTION 'NO_COST_BASIS: the sending tank has no recorded cost, so this '
      'fuel cannot be valued. Record its opening balance or a delivery with a cost first.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO stock_transfer (tenant_id, reference, from_site_id, from_tank_id,
                              to_site_id, to_tank_id, product_id, litres,
                              unit_cost, truck_reg, moved_at, recorded_by)
  VALUES (v_from.tenant_id, p_reference, v_from.site_id, p_from_tank,
          v_to.site_id, p_to_tank, v_from.product_id, p_litres,
          v_cost, p_truck_reg, p_moved_at, p_actor)
  RETURNING id INTO v_id;

  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                             litres, signed_litres, unit_cost, stock_transfer_id,
                             occurred_at, recorded_by)
  VALUES (v_from.tenant_id, v_from.site_id, p_from_tank, v_from.product_id,
          'BULK_OUT', p_litres, -p_litres, v_cost, v_id, p_moved_at, p_actor),
         (v_to.tenant_id, v_to.site_id, p_to_tank, v_to.product_id,
          'BULK_IN', p_litres, p_litres, v_cost, v_id, p_moved_at, p_actor);

  RETURN v_id;
END $$;
