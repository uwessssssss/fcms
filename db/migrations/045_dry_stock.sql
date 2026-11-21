-- =============================================================================
-- FCMS v2 -- 045_dry_stock.sql
--
-- Lubricants, LPG, and the shop -- in scope from day one.
--
-- Same discipline as fuel: on-hand quantity is a LEDGER SUM, never a stored
-- `qty_on_hand` column that drifts. A litre of Shell Helix and a litre of PMS
-- are accounted for the same way, so there is one mental model in the system
-- and one place to look when something is missing.
--
-- Two things about dry stock genuinely differ from fuel and are modelled
-- explicitly rather than forced into the fuel shape:
--
--   1. It is COUNTED IN UNITS, not measured with a stick. There is no
--      calibration chart and no interpolation -- a count is exact, so an
--      unexplained difference is theft, breakage or a miskey, never a dip
--      reading error. The variance rules are therefore tighter.
--
--   2. LPG CYLINDERS COME BACK. A refill is a full cylinder out and an empty
--      cylinder in, and the customer pays for gas only. Model that as two SKUs
--      linked as an exchange pair. Trying to represent it as one item with a
--      "full/empty" flag is where LPG stock control usually falls apart.
-- =============================================================================

CREATE TYPE dry_movement_kind AS ENUM (
  'OPENING_BALANCE',   -- +
  'PURCHASE_IN',       -- + received from supplier
  'SALE_OUT',          -- - sold
  'EXCHANGE_IN',       -- + empty cylinder returned on a refill
  'CUSTOMER_RETURN_IN',-- + goods returned by a customer
  'DAMAGE_OUT',        -- - broken, spilled, leaked
  'EXPIRY_OUT',        -- - past shelf life
  'OWN_USE_OUT',       -- - consumed by the station itself
  'TRANSFER_IN',       -- +
  'TRANSFER_OUT',      -- -
  'COUNT_ADJUST',      -- +/- the counted truth replaces the book
  'CORRECTION'         -- +/- reverses a prior movement
);

CREATE OR REPLACE FUNCTION fn_dry_sign(p_kind dry_movement_kind)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind
    WHEN 'OPENING_BALANCE'    THEN  1
    WHEN 'PURCHASE_IN'        THEN  1
    WHEN 'EXCHANGE_IN'        THEN  1
    WHEN 'CUSTOMER_RETURN_IN' THEN  1
    WHEN 'TRANSFER_IN'        THEN  1
    WHEN 'SALE_OUT'           THEN -1
    WHEN 'DAMAGE_OUT'         THEN -1
    WHEN 'EXPIRY_OUT'         THEN -1
    WHEN 'OWN_USE_OUT'        THEN -1
    WHEN 'TRANSFER_OUT'       THEN -1
    WHEN 'COUNT_ADJUST'       THEN  0   -- signed_qty carries its own sign
    WHEN 'CORRECTION'         THEN  0
  END;
$$;

-- ---------------------------------------------------------------------------
-- The catalogue.
-- ---------------------------------------------------------------------------
CREATE TABLE dry_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  sku           text NOT NULL,
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN
                  ('LUBRICANT','LPG','SHOP','TYRE','ACCESSORY','SERVICE')),
  -- What one unit IS. A 4L carton of Helix is one SELLABLE unit containing 4
  -- litres; counting it in litres and selling it in cartons is how shops end
  -- up with stock that is off by a factor of four.
  sell_unit     text NOT NULL DEFAULT 'EACH'
                  CHECK (sell_unit IN ('EACH','CARTON','LITRE','KG','PAIR','SET')),
  pack_size     numeric(10,3) NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  pack_unit     text,
  barcode       text,

  -- LPG cylinders. `exchange_pair_id` links FULL <-> EMPTY.
  is_cylinder   boolean NOT NULL DEFAULT FALSE,
  cylinder_state text CHECK (cylinder_state IS NULL OR cylinder_state IN ('FULL','EMPTY')),
  exchange_pair_id uuid REFERENCES dry_item(id),
  deposit_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),

  reorder_level numeric(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  is_sellable   boolean NOT NULL DEFAULT TRUE,
  is_active     boolean NOT NULL DEFAULT TRUE,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, sku),
  CONSTRAINT cylinder_needs_state CHECK (NOT is_cylinder OR cylinder_state IS NOT NULL),
  CONSTRAINT state_implies_cylinder CHECK (cylinder_state IS NULL OR is_cylinder)
);
CREATE INDEX ON dry_item (tenant_id, category) WHERE is_active;
CREATE UNIQUE INDEX ON dry_item (tenant_id, barcode) WHERE barcode IS NOT NULL;

-- The selling price of a dry item, effective-dated. Unlike fuel this changes
-- item by item rather than by directive, so it does not cut the shift -- but it
-- is still captured onto the sale line, never looked up afterwards.
CREATE TABLE dry_price (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  item_id        uuid NOT NULL REFERENCES dry_item(id),
  unit_price     numeric(16,4) NOT NULL CHECK (unit_price >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  set_by         uuid NOT NULL REFERENCES staff(id),
  UNIQUE (site_id, item_id, effective_from)
);
CREATE INDEX ON dry_price (item_id, effective_from DESC);

DO $$
BEGIN
  PERFORM fn_require_operator_author('dry_price', 'set_by');
END $$;

CREATE OR REPLACE FUNCTION fn_dry_price(p_site_id uuid, p_item_id uuid,
                                        p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v_price numeric; v_sku text;
BEGIN
  SELECT unit_price INTO v_price FROM dry_price
   WHERE site_id = p_site_id AND item_id = p_item_id AND effective_from <= p_at
   ORDER BY effective_from DESC LIMIT 1;
  IF v_price IS NULL THEN
    SELECT sku INTO v_sku FROM dry_item WHERE id = p_item_id;
    RAISE EXCEPTION 'NO_DRY_PRICE: % has no price set at this station',
      COALESCE(v_sku, p_item_id::text) USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_price;
END $$;

-- ---------------------------------------------------------------------------
-- THE DRY LEDGER. Append-only, exactly like fuel_movement.
-- ---------------------------------------------------------------------------
CREATE TABLE dry_movement (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  item_id       uuid NOT NULL REFERENCES dry_item(id),
  shift_id      uuid REFERENCES shift(id),

  kind          dry_movement_kind NOT NULL,
  qty           numeric(12,3) NOT NULL CHECK (qty > 0),
  signed_qty    numeric(12,3) NOT NULL,

  unit_cost     numeric(16,4),
  unit_price    numeric(16,4),

  dry_sale_line_id uuid,
  purchase_line_id uuid,
  dry_count_id     uuid,
  corrects_id      bigint REFERENCES dry_movement(id),
  correction_note  text,
  note             text,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   uuid NOT NULL REFERENCES staff(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,

  CONSTRAINT dry_sign_correct CHECK (
    CASE WHEN fn_dry_sign(kind) <> 0
         THEN signed_qty = qty * fn_dry_sign(kind)
         ELSE abs(signed_qty) = qty END
  ),
  CONSTRAINT dry_correction_needs_note
    CHECK (corrects_id IS NULL OR correction_note IS NOT NULL),
  -- A write-off is money leaving the business. It gets a reason, always.
  CONSTRAINT writeoff_needs_note
    CHECK (kind NOT IN ('DAMAGE_OUT','EXPIRY_OUT','OWN_USE_OUT') OR note IS NOT NULL)
);

CREATE INDEX ON dry_movement (item_id, occurred_at, id);
CREATE INDEX ON dry_movement (shift_id) WHERE shift_id IS NOT NULL;
CREATE UNIQUE INDEX ON dry_movement (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE RULE dry_movement_no_update AS ON UPDATE TO dry_movement DO INSTEAD NOTHING;
CREATE RULE dry_movement_no_delete AS ON DELETE TO dry_movement DO INSTEAD NOTHING;

DO $$
BEGIN
  PERFORM fn_require_operator_author('dry_movement', 'recorded_by');
END $$;

CREATE OR REPLACE FUNCTION fn_dry_on_hand(p_item_id uuid, p_site_id uuid,
                                          p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(signed_qty), 0)::numeric(12,3)
    FROM dry_movement
   WHERE item_id = p_item_id AND site_id = p_site_id AND occurred_at <= p_at;
$$;

CREATE OR REPLACE VIEW v_dry_stock_on_hand AS
SELECT i.tenant_id, m.site_id, i.id AS item_id, i.sku, i.name, i.category,
       i.sell_unit, i.reorder_level,
       SUM(m.signed_qty)::numeric(12,3) AS on_hand,
       SUM(m.signed_qty) <= i.reorder_level AS needs_reorder,
       MAX(m.occurred_at) AS last_movement_at
  FROM dry_movement m
  JOIN dry_item i ON i.id = m.item_id
 GROUP BY i.tenant_id, m.site_id, i.id, i.sku, i.name, i.category,
          i.sell_unit, i.reorder_level;

-- ---------------------------------------------------------------------------
-- Dry sales.
--
-- `seller_id` is the attendant or shop hand who made the sale -- the SUBJECT,
-- who does not sign in. `recorded_by` is the supervisor who entered it -- the
-- AUTHOR. Same split as everywhere else in the system.
--
-- The sale settles into that seller's cash-up, so a shop sale is accounted for
-- by exactly the same balance rule as a litre of diesel.
-- ---------------------------------------------------------------------------
CREATE TABLE dry_sale (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  shift_id     uuid NOT NULL REFERENCES shift(id),
  seller_id    uuid NOT NULL REFERENCES staff(id),
  receipt_no   text,
  customer_ref text,
  total_amount numeric(16,2) NOT NULL CHECK (total_amount > 0),
  currency     char(3) NOT NULL,
  recorded_by  uuid NOT NULL REFERENCES staff(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  UNIQUE (site_id, receipt_no)
);
CREATE INDEX ON dry_sale (shift_id, seller_id);
CREATE UNIQUE INDEX ON dry_sale (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  PERFORM fn_require_operator_author('dry_sale', 'recorded_by');
END $$;

CREATE TABLE dry_sale_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  sale_id     uuid NOT NULL REFERENCES dry_sale(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES dry_item(id),
  qty         numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_price  numeric(16,4) NOT NULL CHECK (unit_price >= 0),
  line_amount numeric(16,2) NOT NULL CHECK (line_amount >= 0),
  -- Set on an LPG refill: the empty cylinder SKU that came back over the
  -- counter. The close routine turns this into an EXCHANGE_IN movement, so
  -- empties are stock you can count rather than a thing people remember.
  exchange_in_item_id uuid REFERENCES dry_item(id),
  CONSTRAINT line_amount_matches CHECK (abs(line_amount - qty * unit_price) < 1.00)
);
CREATE INDEX ON dry_sale_line (sale_id);
CREATE INDEX ON dry_sale_line (item_id);

ALTER TABLE dry_movement
  ADD CONSTRAINT fk_dry_movement_sale_line
  FOREIGN KEY (dry_sale_line_id) REFERENCES dry_sale_line(id);

-- The header total must equal the sum of its lines, checked at commit so the
-- lines can be inserted after the header.
CREATE OR REPLACE FUNCTION trg_dry_sale_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_sale uuid := COALESCE(NEW.sale_id, OLD.sale_id);
        v_head numeric(16,2); v_lines numeric(16,2);
BEGIN
  SELECT total_amount INTO v_head FROM dry_sale WHERE id = v_sale;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(line_amount),0) INTO v_lines
    FROM dry_sale_line WHERE sale_id = v_sale;
  IF abs(v_head - v_lines) > 0.01 THEN
    RAISE EXCEPTION
      'DRY_SALE_UNBALANCED: receipt totals % but its lines add to %',
      v_head, v_lines USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER dry_sale_must_total
  AFTER INSERT OR UPDATE OR DELETE ON dry_sale_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_dry_sale_totals();

-- Selling stock you do not have is almost always a keying error or an unbooked
-- delivery. Either way it should stop at the counter, not surface in a monthly
-- count six weeks later.
CREATE OR REPLACE FUNCTION trg_dry_no_negative_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_hand numeric; v_sku text;
BEGIN
  IF fn_dry_sign(NEW.kind) >= 0 THEN RETURN NULL; END IF;
  v_hand := fn_dry_on_hand(NEW.item_id, NEW.site_id);
  IF v_hand < 0 THEN
    SELECT sku INTO v_sku FROM dry_item WHERE id = NEW.item_id;
    RAISE EXCEPTION
      'DRY_STOCK_NEGATIVE: % would go to % units. Book the delivery or correct '
      'the count before selling it.', v_sku, v_hand
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER dry_stock_stays_positive
  AFTER INSERT ON dry_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_dry_no_negative_stock();

-- ---------------------------------------------------------------------------
-- Dry stock count. Units are exact, so a variance here is not measurement
-- noise -- the tolerance is zero and every difference needs a name against it.
-- ---------------------------------------------------------------------------
CREATE TABLE dry_count (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  shift_id     uuid REFERENCES shift(id),
  counted_on   date NOT NULL,
  scope        text NOT NULL DEFAULT 'FULL' CHECK (scope IN ('FULL','CATEGORY','SPOT')),
  category     text,
  status       text NOT NULL DEFAULT 'COUNTING'
                 CHECK (status IN ('COUNTING','COUNTED','APPROVED','POSTED')),
  counted_by   uuid NOT NULL REFERENCES staff(id),
  witnessed_by uuid REFERENCES staff(id),
  approved_by  uuid REFERENCES staff(id),
  approved_at  timestamptz,
  posted_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dry_count_segregation
    CHECK (approved_by IS NULL OR approved_by <> counted_by)
);

DO $$
BEGIN
  PERFORM fn_require_operator_author('dry_count', 'counted_by');
  PERFORM fn_require_operator_author('dry_count', 'approved_by');
END $$;

CREATE TABLE dry_count_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  count_id      uuid NOT NULL REFERENCES dry_count(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES dry_item(id),
  book_qty      numeric(12,3) NOT NULL,
  counted_qty   numeric(12,3) NOT NULL CHECK (counted_qty >= 0),
  variance_qty  numeric(12,3) GENERATED ALWAYS AS (counted_qty - book_qty) STORED,
  variance_reason text,
  UNIQUE (count_id, item_id),
  CONSTRAINT dry_variance_needs_reason
    CHECK (counted_qty = book_qty OR variance_reason IS NOT NULL)
);
CREATE INDEX ON dry_count_line (count_id);

ALTER TABLE dry_movement
  ADD CONSTRAINT fk_dry_movement_count FOREIGN KEY (dry_count_id) REFERENCES dry_count(id);

-- ---------------------------------------------------------------------------
-- Posting a count writes the adjustment into the ledger. The count does not
-- silently become the truth -- it becomes a COUNT_ADJUST movement you can see.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_post_dry_count(p_count_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_c dry_count%ROWTYPE; v_line record; v_n int := 0;
BEGIN
  SELECT * INTO v_c FROM dry_count WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_COUNT: %', p_count_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_c.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'COUNT_NOT_APPROVED: count % is %', p_count_id, v_c.status
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_line IN SELECT * FROM dry_count_line WHERE count_id = p_count_id
                  AND counted_qty <> book_qty
  LOOP
    INSERT INTO dry_movement (
      tenant_id, site_id, item_id, shift_id, kind, qty, signed_qty,
      dry_count_id, note, occurred_at, recorded_by)
    VALUES (
      v_c.tenant_id, v_c.site_id, v_line.item_id, v_c.shift_id,
      'COUNT_ADJUST', abs(v_line.variance_qty), v_line.variance_qty,
      p_count_id, v_line.variance_reason, now(), p_actor);
    v_n := v_n + 1;
  END LOOP;

  UPDATE dry_count SET status = 'POSTED', posted_at = now() WHERE id = p_count_id;
  RETURN jsonb_build_object('count_id', p_count_id, 'adjustments', v_n);
END $$;
