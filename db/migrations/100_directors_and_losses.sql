-- =============================================================================
-- FCMS v2 -- 100_directors_and_losses.sql
--
-- Two additions the station asked for:
--
--   1. DIRECTOR. An owner who reads everything and signs off the big numbers,
--      but never touches a forecourt screen. Distinct from ADMIN, which is a
--      configuration role and should not see money.
--
--   2. STOCK LOSS, per product, daily and cumulative. Until now variance was
--      visible per tank per shift and nowhere else -- which answers "did
--      tonight balance" and never "are we losing diesel". Those are different
--      questions and the second is the one that costs money.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DIRECTOR
--
-- Added to the end of the enum: Postgres appends without a table rewrite, and
-- ordering carries no meaning here.
-- ---------------------------------------------------------------------------
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'DIRECTOR';

COMMIT;   -- a new enum label cannot be used in the same transaction that adds it
BEGIN;

INSERT INTO role_permission (role, permission) VALUES
  ('DIRECTOR','report.view'),
  ('DIRECTOR','audit.view'),
  ('DIRECTOR','shift.approve'),
  ('DIRECTOR','cashup.approve'),
  ('DIRECTOR','shortage.approve'),
  ('DIRECTOR','shortage.write_off'),
  ('DIRECTOR','stock_count.approve'),
  ('DIRECTOR','price.execute'),
  ('DIRECTOR','discount.authorise'),
  ('DIRECTOR','credit_customer.manage'),
  ('DIRECTOR','exception.resolve')
ON CONFLICT DO NOTHING;

-- Directors sign in, so they are operators and never hold a nozzle. That falls
-- out of the existing generated column: is_operator is (role <> 'ATTENDANT').

-- ---------------------------------------------------------------------------
-- STOCK LOSS PER PRODUCT, PER DAY
--
-- Loss is measured where it is real: the difference between what the ledger
-- says should be in the ground and what the dipstick found, at the last close
-- of the business day.
--
-- Deliberately NOT stored. Same rule as everywhere else in this schema -- a
-- cached variance is a variance that drifts away from its own inputs. This is
-- a view, so it is always the arithmetic of whatever is currently recorded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_stock_loss AS
WITH closes AS (
  -- The last closing dip per tank per business date, and the book position
  -- the ledger held at that moment.
  SELECT DISTINCT ON (d.tank_id, s.business_date)
         s.site_id,
         s.business_date,
         d.tank_id,
         t.product_id,
         d.product_litres  AS actual_litres,
         d.captured_at
    FROM dip_reading d
    JOIN shift s ON s.id = d.shift_id
    JOIN tank t  ON t.id = d.tank_id
   WHERE d.context = 'SHIFT_CLOSE'
   ORDER BY d.tank_id, s.business_date, d.captured_at DESC
), sold AS (
  SELECT s.site_id, s.business_date, me.tank_id,
         SUM(md.litres) AS sold_litres
    FROM meter_event me
    JOIN metered_disposition md
      ON md.meter_event_id = me.id AND md.kind = 'SALE'
    JOIN shift s ON s.id = me.shift_id
   GROUP BY s.site_id, s.business_date, me.tank_id
), received AS (
  SELECT s.site_id, s.business_date, fm.tank_id,
         SUM(fm.litres) AS received_litres
    FROM fuel_movement fm
    JOIN shift s ON s.id = fm.shift_id
   WHERE fm.kind = 'DELIVERY_IN'
   GROUP BY s.site_id, s.business_date, fm.tank_id
)
SELECT
  c.site_id,
  c.business_date,
  p.id                                  AS product_id,
  p.code                                AS product_code,
  c.tank_id,
  t.code                                AS tank_code,
  COALESCE(so.sold_litres, 0)           AS sold_litres,
  COALESCE(r.received_litres, 0)        AS received_litres,
  fn_book_stock(c.tank_id, c.captured_at) AS book_litres,
  c.actual_litres,
  round(c.actual_litres - fn_book_stock(c.tank_id, c.captured_at), 3) AS loss_litres,
  CASE WHEN COALESCE(so.sold_litres, 0) > 0
       THEN round((c.actual_litres - fn_book_stock(c.tank_id, c.captured_at))
                  / so.sold_litres * 100, 4)
  END                                   AS loss_pct,
  -- Valued at what the fuel cost, not what it sold for. A litre that leaked
  -- was never going to be sold, so pricing the loss at the pump price
  -- overstates it -- and overstating a loss is how a manager stops believing
  -- the number.
  round((c.actual_litres - fn_book_stock(c.tank_id, c.captured_at))
        * COALESCE(fn_weighted_avg_cost(c.tank_id, c.captured_at), 0), 2)
                                        AS loss_value
FROM closes c
JOIN tank t    ON t.id = c.tank_id
JOIN product p ON p.id = c.product_id
LEFT JOIN sold so     ON so.tank_id = c.tank_id AND so.business_date = c.business_date
LEFT JOIN received r  ON r.tank_id  = c.tank_id AND r.business_date  = c.business_date;

COMMENT ON VIEW v_daily_stock_loss IS
  'Per tank per business date: what the books said, what the dipstick found, '
  'and the difference valued at weighted average cost. Derived, never stored.';

-- ---------------------------------------------------------------------------
-- CUMULATIVE LOSS PER PRODUCT
--
-- The question a dealer actually asks: over this period, how much of each
-- product have we lost, and is it getting worse.
--
-- A running total is included so a trend is visible without exporting to a
-- spreadsheet. One bad night is noise; a line that only goes one way is not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cumulative_stock_loss AS
SELECT
  site_id,
  product_id,
  product_code,
  business_date,
  SUM(loss_litres)                          AS day_loss_litres,
  SUM(loss_value)                           AS day_loss_value,
  SUM(sold_litres)                          AS day_sold_litres,
  SUM(SUM(loss_litres)) OVER w              AS cumulative_loss_litres,
  SUM(SUM(loss_value))  OVER w              AS cumulative_loss_value,
  SUM(SUM(sold_litres)) OVER w              AS cumulative_sold_litres,
  CASE WHEN SUM(SUM(sold_litres)) OVER w > 0
       THEN round(SUM(SUM(loss_litres)) OVER w
                  / SUM(SUM(sold_litres)) OVER w * 100, 4)
  END                                       AS cumulative_loss_pct
FROM v_daily_stock_loss
GROUP BY site_id, product_id, product_code, business_date
WINDOW w AS (PARTITION BY site_id, product_id ORDER BY business_date
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);

COMMENT ON VIEW v_cumulative_stock_loss IS
  'Daily and running loss per product. One bad night is noise; a line that '
  'only goes one way is not.';

-- ---------------------------------------------------------------------------
-- METER DIVERGENCE PER NOZZLE
--
-- Both readings are taken at every close: the mechanical totalizer and the
-- electronic head. Their ABSOLUTE values legitimately differ -- they were
-- zeroed at different times -- so only the DELTAS are comparable.
--
-- A nozzle whose two deltas drift apart consistently is either miscalibrated
-- or being under-recorded by hand. Either is worth knowing, and neither shows
-- up in a single shift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_meter_divergence AS
SELECT
  s.site_id,
  s.business_date,
  n.id                       AS nozzle_id,
  pu.code || '/' || n.code   AS nozzle_label,
  p.code                     AS product_code,
  me.gross_litres            AS mechanical_litres,
  me.electronic_litres,
  me.divergence_litres,
  CASE WHEN me.gross_litres > 0 AND me.electronic_litres IS NOT NULL
       THEN round(me.divergence_litres / me.gross_litres * 100, 4)
  END                        AS divergence_pct,
  st.full_name               AS attendant_name
FROM meter_event me
JOIN shift s   ON s.id = me.shift_id
JOIN nozzle n  ON n.id = me.nozzle_id
JOIN pump pu   ON pu.id = n.pump_id
JOIN tank t    ON t.id = n.tank_id
JOIN product p ON p.id = t.product_id
JOIN nozzle_assignment na ON na.id = me.assignment_id
JOIN staff st  ON st.id = na.attendant_id;

COMMENT ON VIEW v_meter_divergence IS
  'Mechanical vs electronic delta per nozzle. Absolute totalizer values are '
  'not comparable; only the deltas are.';
