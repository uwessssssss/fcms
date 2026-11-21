-- =============================================================================
-- FCMS v2 -- 130_depot_and_transfers.sql
--
-- Kiboga is two businesses sharing a yard.
--
--   THE DEPOT sells wholesale: whole truckloads, on credit, against a
--   registration number. Big volumes, thin or negative margins, and a debtor
--   book that is where the real risk lives.
--
--   THE STATION sells retail through nozzles: mostly cash, small credit, and
--   it is what carries the site.
--
-- They must report separately and still reconcile, because fuel moves BETWEEN
-- them and an internal transfer is not a sale. Getting that wrong puts an
-- internal movement through the profit and loss and makes both halves lie.
--
-- Three additions:
--
--   1. A site knows whether it is a STATION or a DEPOT.
--   2. Bulk sales -- a truckload out of a depot tank, no nozzle involved.
--   3. Transfers -- depot tank to station tank, at cost, never a sale.
--
-- And one fix that this operation makes urgent: fuel stock may not go negative.
-- =============================================================================

CREATE TYPE site_kind AS ENUM ('STATION', 'DEPOT');

ALTER TABLE site ADD COLUMN IF NOT EXISTS kind site_kind NOT NULL DEFAULT 'STATION';

COMMENT ON COLUMN site.kind IS
  'A depot sells whole loads against a truck registration and has no nozzles. '
  'A station sells through nozzles on shifts. They report separately and '
  'reconcile through transfers.';

-- ---------------------------------------------------------------------------
-- FUEL STOCK MAY NOT GO NEGATIVE.
--
-- This is the most important thing in this migration and it should have been
-- here from the start. A real depot ran one product to MINUS 10,767 litres on
-- a single wholesale invoice -- it sold 12,500 L when roughly 1,700 L were in
-- the ground -- and the accounting package obligingly posted a cost correction
-- and carried on. Nobody found out until a month-end reconciliation.
--
-- Negative fuel is never a real state. It means one of two things, and both
-- need a person:
--
--   a delivery arrived and was never booked, or
--   the sale is wrong.
--
-- Deferred, so a close that books a delivery and a sale in the same
-- transaction is judged on the net position rather than on statement order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fuel_stock_not_negative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_stock numeric; v_code text; v_product text;
BEGIN
  IF fn_movement_sign(NEW.kind) >= 0 AND NEW.signed_litres >= 0 THEN
    RETURN NULL;
  END IF;

  v_stock := fn_book_stock(NEW.tank_id);
  IF v_stock >= 0 THEN
    RETURN NULL;
  END IF;

  SELECT t.code, p.code INTO v_code, v_product
    FROM tank t JOIN product p ON p.id = t.product_id
   WHERE t.id = NEW.tank_id;

  RAISE EXCEPTION
    'FUEL_STOCK_NEGATIVE: % (%) would go to % litres. Fuel cannot be sold '
    'before it arrives -- either a delivery has not been booked, or this '
    'quantity is wrong. Book the delivery first.',
    v_code, v_product, round(v_stock, 3)
    USING ERRCODE = 'check_violation';
END $$;

CREATE CONSTRAINT TRIGGER fuel_stock_stays_positive
  AFTER INSERT ON fuel_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_fuel_stock_not_negative();

-- ---------------------------------------------------------------------------
-- BULK SALES
--
-- A truckload out of a depot tank. No nozzle, no shift, no attendant -- the
-- fuel goes through a gantry meter or is measured by dip, and the person who
-- matters is the driver whose registration goes on the invoice.
--
-- Quantity is recorded BOTH ways where possible. A wholesale load is worth
-- millions and the two measurements disagreeing is the earliest sign that
-- something is wrong with the gantry meter or with the load.
-- ---------------------------------------------------------------------------
CREATE TABLE bulk_sale (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  site_id         uuid NOT NULL REFERENCES site(id),
  tank_id         uuid NOT NULL REFERENCES tank(id),
  product_id      uuid NOT NULL REFERENCES product(id),

  customer_id     uuid NOT NULL REFERENCES credit_customer(id),
  invoice_no      text NOT NULL,
  truck_reg       text NOT NULL,
  driver_name     text,
  destination     text,

  -- What the gantry meter counted, and what the dips say left the tank.
  metered_litres  numeric(12,3) CHECK (metered_litres IS NULL OR metered_litres > 0),
  dip_before_id   bigint REFERENCES dip_reading(id),
  dip_after_id    bigint REFERENCES dip_reading(id),
  dipped_litres   numeric(12,3) CHECK (dipped_litres IS NULL OR dipped_litres > 0),

  -- The quantity actually billed and moved. One of the two above, chosen
  -- deliberately, because the invoice has to say a single number.
  litres          numeric(12,3) NOT NULL CHECK (litres > 0),
  basis           text NOT NULL CHECK (basis IN ('METER','DIP')),

  unit_price      numeric(12,4) NOT NULL CHECK (unit_price > 0),
  amount          numeric(16,2) NOT NULL CHECK (amount > 0),

  -- Captured at the moment of sale, so a later cost correction cannot rewrite
  -- what this load was worth when it left.
  unit_cost       numeric(12,4),

  payment_terms   text NOT NULL DEFAULT 'CREDIT'
                    CHECK (payment_terms IN ('CREDIT','CASH','PREPAID')),
  seal_numbers    text[],
  loaded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid NOT NULL REFERENCES staff(id),
  approved_by     uuid REFERENCES staff(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (site_id, invoice_no),
  CONSTRAINT bulk_amount_matches CHECK (abs(amount - litres * unit_price) < 1.00),
  CONSTRAINT bulk_basis_has_a_figure CHECK (
    (basis = 'METER' AND metered_litres IS NOT NULL)
    OR (basis = 'DIP' AND dipped_litres IS NOT NULL)
  )
);

CREATE INDEX ON bulk_sale (site_id, loaded_at DESC);
CREATE INDEX ON bulk_sale (customer_id, loaded_at DESC);
CREATE INDEX ON bulk_sale (truck_reg);

DO $$
BEGIN
  PERFORM fn_require_operator_author('bulk_sale', 'recorded_by');
  PERFORM fn_require_operator_author('bulk_sale', 'approved_by');
END $$;

ALTER TABLE fuel_movement ADD COLUMN IF NOT EXISTS bulk_sale_id uuid REFERENCES bulk_sale(id);

-- A bulk sale is a source in its own right, alongside a meter event, a
-- delivery, a count and a bulk draw.
ALTER TABLE fuel_movement DROP CONSTRAINT movement_has_exactly_one_source;
ALTER TABLE fuel_movement ADD CONSTRAINT movement_has_exactly_one_source CHECK (
  (meter_event_id   IS NOT NULL)::int
+ (delivery_line_id IS NOT NULL)::int
+ (stock_count_id   IS NOT NULL)::int
+ (bulk_draw_id     IS NOT NULL)::int
+ (bulk_sale_id     IS NOT NULL)::int
+ (corrects_id      IS NOT NULL)::int
+ (kind = 'OPENING_BALANCE')::int = 1
);

-- ---------------------------------------------------------------------------
-- INTERNAL TRANSFERS
--
-- Depot tank to station tank. Both ends in one row, so the two halves cannot
-- be separated by a failure, and one movement written at each end.
--
-- Valued at WEIGHTED AVERAGE COST, matching how the books already work. This
-- matters more than it looks: transferring at anything other than cost invents
-- a margin inside the business, and putting the transfer through the profit
-- and loss at all makes the depot show a sale it never made and the station a
-- purchase it never paid for.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_transfer (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  reference       text NOT NULL,

  from_site_id    uuid NOT NULL REFERENCES site(id),
  from_tank_id    uuid NOT NULL REFERENCES tank(id),
  to_site_id      uuid NOT NULL REFERENCES site(id),
  to_tank_id      uuid NOT NULL REFERENCES tank(id),
  product_id      uuid NOT NULL REFERENCES product(id),

  litres          numeric(12,3) NOT NULL CHECK (litres > 0),
  unit_cost       numeric(12,4) NOT NULL CHECK (unit_cost >= 0),
  value           numeric(16,2) GENERATED ALWAYS AS (litres * unit_cost) STORED,

  truck_reg       text,
  moved_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid NOT NULL REFERENCES staff(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, reference),
  CONSTRAINT transfer_between_different_tanks CHECK (from_tank_id <> to_tank_id)
);

CREATE INDEX ON stock_transfer (from_site_id, moved_at DESC);
CREATE INDEX ON stock_transfer (to_site_id, moved_at DESC);

DO $$ BEGIN PERFORM fn_require_operator_author('stock_transfer', 'recorded_by'); END $$;

ALTER TABLE fuel_movement
  ADD COLUMN IF NOT EXISTS stock_transfer_id uuid REFERENCES stock_transfer(id);

ALTER TABLE fuel_movement DROP CONSTRAINT movement_has_exactly_one_source;
ALTER TABLE fuel_movement ADD CONSTRAINT movement_has_exactly_one_source CHECK (
  (meter_event_id    IS NOT NULL)::int
+ (delivery_line_id  IS NOT NULL)::int
+ (stock_count_id    IS NOT NULL)::int
+ (bulk_draw_id      IS NOT NULL)::int
+ (bulk_sale_id      IS NOT NULL)::int
+ (stock_transfer_id IS NOT NULL)::int
+ (corrects_id       IS NOT NULL)::int
+ (kind = 'OPENING_BALANCE')::int = 1
);

-- ---------------------------------------------------------------------------
-- Move the fuel. Both halves, one transaction, at cost.
-- ---------------------------------------------------------------------------
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
  v_cost := COALESCE(fn_weighted_avg_cost(p_from_tank), 0);

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

COMMENT ON FUNCTION fn_transfer_stock IS
  'Moves fuel between tanks at weighted average cost, writing both halves in '
  'one transaction. Never a sale: an internal transfer must not touch the P&L.';

-- ---------------------------------------------------------------------------
-- Depot and station, reported separately and reconciling.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_site_performance AS
WITH retail AS (
  SELECT s.site_id, s.business_date,
         SUM(md.litres)                  AS litres,
         SUM(md.litres * md.unit_price)  AS revenue,
         SUM(md.litres * COALESCE(fn_weighted_avg_cost(me.tank_id), 0)) AS cost
    FROM meter_event me
    JOIN metered_disposition md
      ON md.meter_event_id = me.id AND md.kind = 'SALE'
    JOIN shift s ON s.id = me.shift_id
   GROUP BY s.site_id, s.business_date
), wholesale AS (
  SELECT bs.site_id, bs.loaded_at::date AS business_date,
         SUM(bs.litres)                       AS litres,
         SUM(bs.amount)                       AS revenue,
         SUM(bs.litres * COALESCE(bs.unit_cost, 0)) AS cost
    FROM bulk_sale bs
   GROUP BY bs.site_id, bs.loaded_at::date
)
SELECT
  si.id                                     AS site_id,
  si.code                                   AS site_code,
  si.name                                   AS site_name,
  si.kind::text                             AS site_kind,
  d.business_date,
  COALESCE(r.litres, 0)                     AS retail_litres,
  COALESCE(r.revenue, 0)                    AS retail_revenue,
  COALESCE(r.cost, 0)                       AS retail_cost,
  COALESCE(w.litres, 0)                     AS bulk_litres,
  COALESCE(w.revenue, 0)                    AS bulk_revenue,
  COALESCE(w.cost, 0)                       AS bulk_cost,
  COALESCE(r.revenue, 0) + COALESCE(w.revenue, 0) AS revenue,
  COALESCE(r.cost, 0)    + COALESCE(w.cost, 0)    AS cost,
  COALESCE(r.revenue, 0) + COALESCE(w.revenue, 0)
    - COALESCE(r.cost, 0) - COALESCE(w.cost, 0)   AS margin
FROM site si
CROSS JOIN LATERAL (
  SELECT DISTINCT business_date FROM (
    SELECT business_date FROM retail    WHERE site_id = si.id
    UNION SELECT business_date FROM wholesale WHERE site_id = si.id
  ) dates
) d
LEFT JOIN retail    r ON r.site_id = si.id AND r.business_date = d.business_date
LEFT JOIN wholesale w ON w.site_id = si.id AND w.business_date = d.business_date;

COMMENT ON VIEW v_site_performance IS
  'Depot and station side by side. Transfers appear in neither: they are not '
  'sales, and counting them as revenue would double-count the same fuel.';

-- Loads sold below what they cost. A depot can run a whole month at a negative
-- margin without anyone noticing, because the volumes are large and the per
-- litre gap is small.
CREATE OR REPLACE VIEW v_bulk_sales_below_cost AS
SELECT bs.id, bs.site_id, bs.invoice_no, bs.truck_reg, bs.loaded_at,
       c.name AS customer_name, p.code AS product_code,
       bs.litres, bs.unit_price, bs.unit_cost,
       round(bs.unit_price - bs.unit_cost, 4)          AS margin_per_litre,
       round((bs.unit_price - bs.unit_cost) * bs.litres, 2) AS margin
  FROM bulk_sale bs
  JOIN credit_customer c ON c.id = bs.customer_id
  JOIN product p ON p.id = bs.product_id
 WHERE bs.unit_cost IS NOT NULL AND bs.unit_price < bs.unit_cost;
