-- =============================================================================
-- FCMS v2 -- 420_daily_loss_is_a_change.sql
--
-- A day's stock loss is the CHANGE in the tank-against-book gap, not the gap.
--
-- Dip variances are never posted to the book -- only a stock count corrects
-- it -- so a 40 L shortfall on Monday was still in the gap on Tuesday,
-- Wednesday and every day after. loss_litres WAS that gap, each day, and the
-- profit statement SUMS it: one 40 L loss in a 30-day period counted up to 30
-- times. Stock loss overstated, net understated, loss percentage inflated --
-- and the cumulative loss report, summing it again, curved upward with
-- nothing more going missing.
--
-- Columns are unchanged in order and name (CREATE OR REPLACE VIEW allows
-- only additions at the end); the standing gap is kept, as
-- variance_level_litres, for anyone who wants it.
-- =============================================================================
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
), lev AS (
  -- The gap between tank and book, and the SAME gap at the tank's previous
  -- close dip. Dip variances are never posted to the book, so the gap carries
  -- from day to day until a stock count corrects it.
  SELECT c.site_id, c.business_date, c.tank_id, c.product_id, c.actual_litres, c.captured_at,
         b.book_litres, b.unit_cost,
         c.actual_litres - b.book_litres                          AS level,
         LAG(c.actual_litres - b.book_litres) OVER w              AS prev_level,
         LAG(c.captured_at) OVER w                                AS prev_captured
    FROM closes c
    JOIN book b ON b.tank_id = c.tank_id AND b.business_date = c.business_date
  WINDOW w AS (PARTITION BY c.tank_id ORDER BY c.business_date)
), inc AS (
  -- The day's loss is the CHANGE in the gap. A posted stock count moves the
  -- book to the tank -- which would read as a gain equal to the losses it
  -- settles -- so its own adjustment is added back.
  SELECT l.*,
         l.level - COALESCE(l.prev_level, 0)
           + COALESCE((SELECT SUM(fm.signed_litres) FROM fuel_movement fm
                        WHERE fm.tank_id = l.tank_id AND fm.kind = 'STOCK_TAKE_ADJUST'
                          AND fm.occurred_at >  COALESCE(l.prev_captured, '-infinity'::timestamptz)
                          AND fm.occurred_at <= l.captured_at), 0) AS change
    FROM lev l
)
SELECT
  i.site_id, i.business_date, p.id AS product_id, p.code AS product_code,
  i.tank_id, t.code AS tank_code,
  COALESCE(so.sold_litres, 0) + COALESCE(bk.sold_litres, 0) AS sold_litres,
  COALESCE(r.received_litres, 0)                            AS received_litres,
  i.book_litres,
  i.actual_litres,
  round(i.change, 3)                                        AS loss_litres,
  CASE WHEN COALESCE(so.sold_litres, 0) + COALESCE(bk.sold_litres, 0) > 0
       THEN round(i.change / (COALESCE(so.sold_litres,0) + COALESCE(bk.sold_litres,0)) * 100, 4)
  END                                                       AS loss_pct,
  round(i.change * i.unit_cost, 2)                          AS loss_value,
  round(i.level, 3)                                         AS variance_level_litres
FROM inc i
JOIN tank t    ON t.id = i.tank_id
JOIN product p ON p.id = i.product_id
LEFT JOIN sold     so ON so.tank_id = i.tank_id AND so.business_date = i.business_date
LEFT JOIN bulk     bk ON bk.tank_id = i.tank_id AND bk.business_date = i.business_date
LEFT JOIN received r  ON r.tank_id  = i.tank_id AND r.business_date  = i.business_date;

