-- =============================================================================
-- FCMS v2 -- 560_due_price_applies_at_open.sql
--
-- A PRICE RISE NEVER REACHED THE PUMPS when it fell due with no shift open. The
-- next shift captured the old price and the change stayed PENDING -- every
-- litre undersold by the difference, while Operations said the new price
-- "applies to the next shift you open". Found by opening the demo's next shift
-- on a real database: PMS still sold at 5,180 with 5,240 due.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_capture_shift_prices(p_shift_id uuid)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_shift shift%ROWTYPE; v_n int := 0;
BEGIN
  SELECT * INTO v_shift FROM shift WHERE id = p_shift_id;

  -- (560) A change already due when a shift opens takes effect NOW. With no
  -- shift open there is nothing to cut -- the schema says so (no_shift_to_break)
  -- -- but nothing ever executed such a change: the next shift sold at the old
  -- price and the change sat PENDING, while the screen told the manager "the
  -- new price applies to the next shift you open". Only one shift can be live
  -- at a station, so a change due at open had no shift to break.
  UPDATE price_change
     SET status = 'EXECUTED', executed_at = now(), no_shift_to_break = TRUE,
         shift_opened_id = p_shift_id
   WHERE site_id = v_shift.site_id AND status = 'PENDING'
     AND effective_from <= v_shift.opened_at;

  INSERT INTO shift_price (shift_id, tenant_id, product_id, unit_price, price_change_id)
  SELECT p_shift_id, v_shift.tenant_id, p.id,
         fn_current_price(v_shift.site_id, p.id, v_shift.opened_at),
         (SELECT pc.id FROM price_change pc
           WHERE pc.site_id = v_shift.site_id AND pc.product_id = p.id
             AND pc.status = 'EXECUTED' AND pc.effective_from <= v_shift.opened_at
           ORDER BY pc.effective_from DESC LIMIT 1)
    FROM product p
   WHERE p.tenant_id = v_shift.tenant_id AND p.is_active AND p.is_wet_stock
     AND EXISTS (SELECT 1 FROM tank t
                  WHERE t.site_id = v_shift.site_id AND t.product_id = p.id AND t.is_active)
  ON CONFLICT (shift_id, product_id) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
