-- =============================================================================
-- FCMS v2 -- 150_fixes_and_performance.sql
--
-- Three corrections, one of them serious.
--
-- 1. A DEPOT SALE ON CREDIT NEVER CREATED A RECEIVABLE.
--
--    bulk_sale recorded the invoice and the fuel movement and stopped there, so
--    the entire wholesale debtor book was invisible to ageing, to statements,
--    and to the credit limit check. On an operation where one customer can hold
--    three quarters of the debtor book, that is the most expensive thing the
--    system could fail to show.
--
-- 2. NOTHING CHECKED WHOLESALE CREDIT AGAINST A LIMIT.
--    Retail credit sales check headroom. Loads twenty times the size did not.
--
-- 3. COST AND STOCK FUNCTIONS WERE BEING CALLED PER ROW.
--    fn_book_stock and fn_weighted_avg_cost each scan fuel_movement. Called
--    once per row of a reporting view, that is a full scan per row. Fine on a
--    week of data, unusable on a year.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. A bulk sale on credit IS a credit sale.
--
-- Rather than duplicating the logic in the service, the database does it: one
-- function, one transaction, and the receivable cannot be forgotten because it
-- is not a separate step.
-- ---------------------------------------------------------------------------
ALTER TABLE credit_sale ADD COLUMN IF NOT EXISTS bulk_sale_id uuid REFERENCES bulk_sale(id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_sale_one_per_bulk
  ON credit_sale (bulk_sale_id) WHERE bulk_sale_id IS NOT NULL;

COMMENT ON COLUMN credit_sale.bulk_sale_id IS
  'Set when the receivable came from a depot load rather than a forecourt sale. '
  'Unique, so a load can never be billed twice.';

CREATE OR REPLACE FUNCTION fn_record_bulk_credit(p_bulk_sale_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_bs bulk_sale%ROWTYPE; v_id uuid; v_headroom numeric; v_name text;
BEGIN
  SELECT * INTO v_bs FROM bulk_sale WHERE id = p_bulk_sale_id;
  IF v_bs.id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_BULK_SALE' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_bs.payment_terms <> 'CREDIT' THEN
    RETURN NULL;      -- cash and prepaid loads owe nothing
  END IF;

  SELECT c.name, c.credit_limit - COALESCE(b.balance, 0)
    INTO v_name, v_headroom
    FROM credit_customer c
    LEFT JOIN v_credit_ageing_buckets b ON b.customer_id = c.id
   WHERE c.id = v_bs.customer_id;

  -- Checked here rather than in the application, because a load can also be
  -- recorded by an import or a script and the limit has to hold either way.
  IF v_bs.amount > v_headroom THEN
    RAISE EXCEPTION
      'CREDIT_LIMIT_EXCEEDED: % has % of headroom and this load is %. '
      'Take a payment first, or a director has to raise the limit.',
      v_name, round(v_headroom, 0), round(v_bs.amount, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  -- staff_id is who made the sale. credit_sale has no separate recorded_by,
  -- deliberately: two author columns is two answers to one question, and the
  -- composite foreign key exists precisely to stop that.
  INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, vehicle_id,
                           nozzle_id, product_id, litres, unit_price, amount,
                           voucher_no, staff_id, bulk_sale_id, recorded_at)
  VALUES (v_bs.tenant_id, v_bs.site_id, NULL, v_bs.customer_id, NULL,
          NULL, v_bs.product_id, v_bs.litres, v_bs.unit_price, v_bs.amount,
          v_bs.invoice_no, v_bs.recorded_by, v_bs.id, v_bs.loaded_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION fn_record_bulk_credit IS
  'Turns a depot load into a receivable and enforces the credit limit. The '
  'debtor book on a wholesale operation is where the real risk lives.';

-- credit_sale assumed a forecourt sale: a shift, a nozzle, an attendant. A
-- depot load has none of those.
ALTER TABLE credit_sale ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE credit_sale ALTER COLUMN nozzle_id DROP NOT NULL;

ALTER TABLE credit_sale DROP CONSTRAINT IF EXISTS credit_sale_has_context;
ALTER TABLE credit_sale ADD CONSTRAINT credit_sale_has_context CHECK (
  -- A forecourt sale happens on a shift, through a nozzle.
  (shift_id IS NOT NULL AND nozzle_id IS NOT NULL AND bulk_sale_id IS NULL)
  -- A depot load has neither, and points at the load instead.
  OR (bulk_sale_id IS NOT NULL AND shift_id IS NULL AND nozzle_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- 3. Performance.
--
-- fn_book_stock sums signed_litres for a tank up to a moment; fn_weighted_avg_cost
-- averages the cost of everything delivered in. Both scan fuel_movement, and
-- both were being called once per row of a reporting view.
--
-- The index below is partial and covering: only rows that carry a cost, with
-- the two columns the average needs, so the function reads an index and never
-- touches the table.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS fuel_movement_cost_basis
  ON fuel_movement (tank_id, occurred_at)
  INCLUDE (litres, unit_cost)
  WHERE unit_cost IS NOT NULL AND signed_litres > 0;

-- Book stock reads every movement for a tank in date order. The existing index
-- covers the lookup; INCLUDE lets the sum come from the index alone.
CREATE INDEX IF NOT EXISTS fuel_movement_stock_sum
  ON fuel_movement (tank_id, occurred_at)
  INCLUDE (signed_litres);

-- Indexed on the raw timestamp, NOT on a cast to date.
--
-- Postgres refuses `(loaded_at::date)` in an index because the cast is STABLE
-- rather than IMMUTABLE: timestamptz to date depends on the TimeZone setting,
-- so the same row could sort into different days on different connections and
-- the index would be quietly wrong.
--
-- That refusal is a favour. Even if the cast were allowed, a query written as
-- `loaded_at::date BETWEEN a AND b` cannot use an index on the plain column --
-- the function wraps it and the planner scans. The queries are therefore
-- written as half-open ranges (`>= from AND < to + 1`), which use the index
-- below and are correct across timezone boundaries into the bargain.
CREATE INDEX IF NOT EXISTS bulk_sale_day ON bulk_sale (site_id, loaded_at);
CREATE INDEX IF NOT EXISTS bulk_sale_tank_day ON bulk_sale (tank_id, loaded_at);
CREATE INDEX IF NOT EXISTS stock_transfer_from_day
  ON stock_transfer (from_site_id, moved_at);
CREATE INDEX IF NOT EXISTS credit_sale_customer_time
  ON credit_sale (customer_id, recorded_at);
CREATE INDEX IF NOT EXISTS credit_payment_customer_time
  ON credit_payment (customer_id, received_at);
CREATE INDEX IF NOT EXISTS dip_reading_tank_context
  ON dip_reading (tank_id, context, captured_at DESC);
CREATE INDEX IF NOT EXISTS expense_site_day ON expense (site_id, business_date);
CREATE INDEX IF NOT EXISTS meter_event_shift ON meter_event (shift_id, tank_id);

-- ---------------------------------------------------------------------------
-- The site performance view computed a weighted average cost PER ROW. There
-- are only ever a handful of tanks, so compute it once and join.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_site_performance AS
WITH tank_cost AS (
  -- One row per tank, not one per sale.
  SELECT t.id AS tank_id, COALESCE(fn_weighted_avg_cost(t.id), 0) AS unit_cost
    FROM tank t
), retail AS (
  SELECT s.site_id, s.business_date,
         SUM(md.litres)                          AS litres,
         SUM(md.litres * md.unit_price)          AS revenue,
         SUM(md.litres * tc.unit_cost)           AS cost
    FROM meter_event me
    JOIN metered_disposition md
      ON md.meter_event_id = me.id AND md.kind = 'SALE'
    JOIN shift s     ON s.id = me.shift_id
    JOIN tank_cost tc ON tc.tank_id = me.tank_id
   GROUP BY s.site_id, s.business_date
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

-- The old shape used CROSS JOIN LATERAL against every site, so a tenant with
-- ten sites scanned the movement tables ten times to find the dates. Driving
-- off the dates instead means each table is read once.

-- ---------------------------------------------------------------------------
-- Same problem in the daily loss view: fn_book_stock and fn_weighted_avg_cost
-- were called twice and once per row respectively.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_stock_loss AS
WITH closes AS (
  SELECT DISTINCT ON (d.tank_id, s.business_date)
         s.site_id, s.business_date, d.tank_id, t.product_id,
         d.product_litres AS actual_litres, d.captured_at
    FROM dip_reading d
    JOIN shift s ON s.id = d.shift_id
    JOIN tank t  ON t.id = d.tank_id
   WHERE d.context = 'SHIFT_CLOSE'
   ORDER BY d.tank_id, s.business_date, d.captured_at DESC
), book AS (
  -- Once per (tank, date) rather than three times per row.
  SELECT c.tank_id, c.business_date,
         fn_book_stock(c.tank_id, c.captured_at)        AS book_litres,
         COALESCE(fn_weighted_avg_cost(c.tank_id, c.captured_at), 0) AS unit_cost
    FROM closes c
), sold AS (
  SELECT s.site_id, s.business_date, me.tank_id, SUM(md.litres) AS sold_litres
    FROM meter_event me
    JOIN metered_disposition md
      ON md.meter_event_id = me.id AND md.kind = 'SALE'
    JOIN shift s ON s.id = me.shift_id
   GROUP BY s.site_id, s.business_date, me.tank_id
), bulk AS (
  SELECT bs.site_id, bs.loaded_at::date AS business_date, bs.tank_id,
         SUM(bs.litres) AS sold_litres
    FROM bulk_sale bs
   GROUP BY bs.site_id, bs.loaded_at::date, bs.tank_id
), received AS (
  SELECT s.site_id, s.business_date, fm.tank_id, SUM(fm.litres) AS received_litres
    FROM fuel_movement fm
    JOIN shift s ON s.id = fm.shift_id
   WHERE fm.kind = 'DELIVERY_IN'
   GROUP BY s.site_id, s.business_date, fm.tank_id
)
SELECT
  c.site_id, c.business_date, p.id AS product_id, p.code AS product_code,
  c.tank_id, t.code AS tank_code,
  -- Retail and wholesale both count as sold: a depot tank has no meter events
  -- at all, and reporting its loss against zero sales made every depot day
  -- look like a total loss.
  COALESCE(so.sold_litres, 0) + COALESCE(bk.sold_litres, 0) AS sold_litres,
  COALESCE(r.received_litres, 0)                            AS received_litres,
  b.book_litres,
  c.actual_litres,
  round(c.actual_litres - b.book_litres, 3)                 AS loss_litres,
  CASE WHEN COALESCE(so.sold_litres, 0) + COALESCE(bk.sold_litres, 0) > 0
       THEN round((c.actual_litres - b.book_litres)
                  / (COALESCE(so.sold_litres,0) + COALESCE(bk.sold_litres,0)) * 100, 4)
  END                                                       AS loss_pct,
  round((c.actual_litres - b.book_litres) * b.unit_cost, 2) AS loss_value
FROM closes c
JOIN book b    ON b.tank_id = c.tank_id AND b.business_date = c.business_date
JOIN tank t    ON t.id = c.tank_id
JOIN product p ON p.id = c.product_id
LEFT JOIN sold     so ON so.tank_id = c.tank_id AND so.business_date = c.business_date
LEFT JOIN bulk     bk ON bk.tank_id = c.tank_id AND bk.business_date = c.business_date
LEFT JOIN received r  ON r.tank_id  = c.tank_id AND r.business_date  = c.business_date;
