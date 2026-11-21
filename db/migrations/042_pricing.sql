-- =============================================================================
-- FCMS v2 -- 042_pricing.sql
--
-- A price change is not an edit to a field. It is an EVENT that cuts the shift.
--
-- The reason is arithmetic, not ceremony: an attendant's meter runs from their
-- opening reading to their closing reading, and there is exactly one price per
-- litre in that span. Move the price mid-span and you cannot say what the fuel
-- between the two readings was worth. Cutting the shift restores the guarantee.
--
-- This is the second-most-common cause of a third shift in a day. The first is
-- a delivery, the third is a stock count.
-- =============================================================================

CREATE TABLE price_change (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  product_id     uuid NOT NULL REFERENCES product(id),

  old_price      numeric(12,4) CHECK (old_price IS NULL OR old_price > 0),
  new_price      numeric(12,4) NOT NULL CHECK (new_price > 0),
  effective_from timestamptz NOT NULL,

  source         text NOT NULL CHECK (source IN ('OMC_DIRECTIVE','DEALER','REGULATOR')),
  directive_ref  text,
  document_url   text,

  status         text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','EXECUTED','CANCELLED')),

  -- The two shift segments the break created. An executed change must name
  -- both, unless the station was closed and there was nothing to cut.
  shift_closed_id uuid REFERENCES shift(id),
  shift_opened_id uuid REFERENCES shift(id),
  no_shift_to_break boolean NOT NULL DEFAULT FALSE,

  authorised_by  uuid NOT NULL REFERENCES staff(id),
  second_approver uuid REFERENCES staff(id),
  cancelled_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  executed_at    timestamptz,

  -- This is the constraint that makes an unbroken mid-shift price change
  -- unrepresentable. Without it, the arithmetic guarantee above is a promise
  -- in a comment.
  CONSTRAINT executed_change_broke_a_shift CHECK (
    status <> 'EXECUTED' OR no_shift_to_break
    OR (shift_closed_id IS NOT NULL AND shift_opened_id IS NOT NULL)
  ),
  CONSTRAINT executed_has_time CHECK (status <> 'EXECUTED' OR executed_at IS NOT NULL),
  CONSTRAINT cancelled_has_reason CHECK (status <> 'CANCELLED' OR cancelled_reason IS NOT NULL),
  CONSTRAINT price_actually_moved CHECK (old_price IS NULL OR old_price <> new_price),
  CONSTRAINT second_approver_is_different
    CHECK (second_approver IS NULL OR second_approver <> authorised_by)
);

-- One executed price per product per instant.
CREATE UNIQUE INDEX one_executed_price_per_instant
  ON price_change (site_id, product_id, effective_from) WHERE status = 'EXECUTED';

-- v1 allowed unlimited PENDING duplicates to stack up for the same product.
CREATE UNIQUE INDEX one_pending_price_per_product
  ON price_change (site_id, product_id) WHERE status = 'PENDING';

CREATE INDEX ON price_change (site_id, product_id, effective_from DESC)
  WHERE status = 'EXECUTED';

DO $$
BEGIN
  PERFORM fn_require_operator_author('price_change', 'authorised_by');
  PERFORM fn_require_operator_author('price_change', 'second_approver');
END $$;

-- ---------------------------------------------------------------------------
-- THE PRICE IN FORCE FOR A SHIFT -- captured, not looked up.
--
-- v1 priced a closed shift by calling fn_price_at(station, product, opened_at)
-- at close time. That reads CURRENT data: backdate a price row six months later
-- and every closed shift silently reprices itself. Books that change after they
-- were signed are not books.
--
-- Here the price is stamped onto the shift when it opens, and the cash-up reads
-- the stamp. A later correction to price history cannot reach back into a
-- settled shift.
-- ---------------------------------------------------------------------------
CREATE TABLE shift_price (
  shift_id     uuid NOT NULL REFERENCES shift(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  product_id   uuid NOT NULL REFERENCES product(id),
  unit_price   numeric(12,4) NOT NULL CHECK (unit_price > 0),
  price_change_id uuid REFERENCES price_change(id),
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, product_id)
);

COMMENT ON TABLE shift_price IS
  'The price each product traded at during this shift segment, stamped at open. '
  'Sales are valued from here, never from a live lookup.';

CREATE OR REPLACE FUNCTION fn_current_price(p_site_id uuid, p_product_id uuid,
                                            p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v_price numeric; v_code text;
BEGIN
  SELECT new_price INTO v_price FROM price_change
   WHERE site_id = p_site_id AND product_id = p_product_id
     AND status = 'EXECUTED' AND effective_from <= p_at
   ORDER BY effective_from DESC, created_at DESC LIMIT 1;

  IF v_price IS NULL THEN
    SELECT code INTO v_code FROM product WHERE id = p_product_id;
    RAISE EXCEPTION
      'NO_PRICE: no executed price for % at this station as at %. Set the '
      'pump price before opening a shift.', COALESCE(v_code, p_product_id::text), p_at
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_price;
END $$;

-- Stamp every wet-stock product's price onto a shift. Called by fn_open_shift.
CREATE OR REPLACE FUNCTION fn_capture_shift_prices(p_shift_id uuid)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_shift shift%ROWTYPE; v_n int := 0;
BEGIN
  SELECT * INTO v_shift FROM shift WHERE id = p_shift_id;

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

CREATE OR REPLACE FUNCTION fn_shift_price(p_shift_id uuid, p_product_id uuid)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v_price numeric; v_code text;
BEGIN
  SELECT unit_price INTO v_price FROM shift_price
   WHERE shift_id = p_shift_id AND product_id = p_product_id;
  IF v_price IS NULL THEN
    SELECT code INTO v_code FROM product WHERE id = p_product_id;
    RAISE EXCEPTION
      'NO_SHIFT_PRICE: shift % has no captured price for %. It was opened '
      'before a price existed for that product.', p_shift_id, COALESCE(v_code,'?')
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_price;
END $$;

-- NOTE: fn_weighted_avg_cost lives in 050_fuel_ledger.sql, not here.
-- It reads fuel_movement, and a LANGUAGE sql function body IS parsed and
-- validated at CREATE time (unlike plpgsql). Defining it before the table
-- exists fails the migration outright.
