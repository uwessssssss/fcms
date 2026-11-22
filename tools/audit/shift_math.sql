-- =============================================================================
-- SHIFT MATH AUDIT -- every closed shift recomputed from what was RECORDED,
-- compared with what the close STORED.
--
-- Independent on purpose: nothing here calls fn_close_shift, fn_meter_delta,
-- fn_close_variance, fn_book_stock or fn_shift_price, or reads a stored
-- result to work out the next. The inputs are the raw records only:
--   meter readings (opening, closing, rollover, totaliser digits), the shift's
--   captured prices, pump tests, own use, returns to tank, bulk draws, credit
--   sales, discounts, shop sales, cash drops, the cash and tenders declared,
--   the dips, deliveries and transfers.
-- The outputs checked are: meter events, dispositions, money movements,
--   shortages and overages, fuel movements, variance flags, the shift journal.
--
-- Run:  psql -v ON_ERROR_STOP=1 -d <db> -f tools/audit/shift_math.sql
-- Exits non-zero (RAISE) on any difference.  -v strict=0 only reports.
-- =============================================================================
\set ON_ERROR_STOP 1
\if :{?strict}
\else
  \set strict 1
\endif
SET client_min_messages = warning;

DROP VIEW IF EXISTS pg_temp.s_closed, pg_temp.v_calc CASCADE;   -- runnable twice in one session
DROP TABLE IF EXISTS pg_temp.audit;
CREATE TEMP TABLE audit (rule text, area text, what text, expected numeric, got numeric, note text);
DROP TABLE IF EXISTS pg_temp.audit_count;
CREATE TEMP TABLE audit_count (rule text PRIMARY KEY, area text, checked bigint, description text);

-- The shifts in scope: closed and not voided.
CREATE TEMP VIEW s_closed AS
  SELECT s.* FROM shift s
   WHERE s.closed_at IS NOT NULL AND s.state NOT IN ('OPEN', 'COUNTING', 'VOID');

-- Each assignment's recorded window and readings.
CREATE TEMP VIEW a_raw AS
  SELECT na.id AS assignment_id, na.shift_id, na.nozzle_id, na.attendant_id,
         na.assigned_at, na.released_at, n.tank_id, t.product_id, n.integer_digits,
         op.volume_totalizer AS v_open, cl.volume_totalizer AS v_close,
         op.captured_at AS open_at, cl.captured_at AS close_at,
         COALESCE(cl.is_rollover, FALSE) AS ticked_rollover
    FROM nozzle_assignment na
    JOIN s_closed s ON s.id = na.shift_id
    JOIN nozzle n ON n.id = na.nozzle_id
    JOIN tank t ON t.id = n.tank_id
    LEFT JOIN meter_reading op ON op.assignment_id = na.id AND op.is_opening
    LEFT JOIN meter_reading cl ON cl.assignment_id = na.id AND NOT cl.is_opening;

-- What each assignment dispensed and owes for, from the raw records.
CREATE TEMP VIEW a_calc AS
  SELECT a.*,
         round(CASE WHEN a.v_close >= a.v_open THEN a.v_close - a.v_open
                    ELSE power(10::numeric, a.integer_digits) - a.v_open + a.v_close END, 3) AS gross,
         (SELECT COALESCE(SUM(pt.measured_litres), 0) FROM pump_test pt
           WHERE pt.shift_id = a.shift_id AND pt.nozzle_id = a.nozzle_id
             AND pt.tested_at >= a.assigned_at AND pt.tested_at < COALESCE(a.released_at, 'infinity')) AS tests,
         (SELECT COALESCE(SUM(ou.litres), 0) FROM own_use ou
           WHERE ou.shift_id = a.shift_id AND ou.nozzle_id = a.nozzle_id
             AND ou.recorded_at >= a.assigned_at AND ou.recorded_at < COALESCE(a.released_at, 'infinity')) AS own,
         (SELECT COALESCE(SUM(r.litres), 0) FROM return_to_tank r
           WHERE r.shift_id = a.shift_id AND r.nozzle_id = a.nozzle_id
             AND r.recorded_at >= a.assigned_at AND r.recorded_at < COALESCE(a.released_at, 'infinity')) AS rtt,
         (SELECT sp.unit_price FROM shift_price sp
           WHERE sp.shift_id = a.shift_id AND sp.product_id = a.product_id) AS price
    FROM a_raw a;

CREATE TEMP VIEW a_owed AS
  SELECT c.*, round(c.gross - c.tests - c.own - c.rtt, 3) AS sale_litres,
         round(round(c.gross - c.tests - c.own - c.rtt, 3) * c.price, 2) AS sale_value
    FROM a_calc c;

-- ---------------------------------------------------------------------------
-- 1. METERS
-- ---------------------------------------------------------------------------
INSERT INTO audit_count SELECT 'M1', 'meters', count(*), 'every assignment has both readings and exactly one meter event' FROM a_raw;
INSERT INTO audit
SELECT 'M1', 'meters', 'assignment ' || a.assignment_id, 1, count(me.id),
       CASE WHEN a.v_open IS NULL THEN 'no opening reading' WHEN a.v_close IS NULL THEN 'no closing reading' ELSE 'meter events' END
  FROM a_raw a LEFT JOIN meter_event me ON me.assignment_id = a.assignment_id
 GROUP BY a.assignment_id, a.v_open, a.v_close
HAVING count(me.id) <> 1 OR a.v_open IS NULL OR a.v_close IS NULL;

INSERT INTO audit_count SELECT 'M2', 'meters', count(*), 'litres = closing - opening (wrap at 10^digits when the rollover was ticked)' FROM a_owed;
INSERT INTO audit
SELECT 'M2', 'meters', 'assignment ' || a.assignment_id, a.gross, me.gross_litres,
       'opening ' || a.v_open || ', closing ' || a.v_close
  FROM a_owed a JOIN meter_event me ON me.assignment_id = a.assignment_id
 WHERE me.gross_litres <> a.gross;

INSERT INTO audit_count SELECT 'M3', 'meters', count(*), 'a reading below its opening is only accepted as a ticked rollover' FROM a_raw WHERE v_close < v_open;
INSERT INTO audit
SELECT 'M3', 'meters', 'assignment ' || a.assignment_id, a.v_open, a.v_close, 'closing below opening without the rollover ticked'
  FROM a_raw a WHERE a.v_close < a.v_open AND NOT a.ticked_rollover;

-- Continuity: each holding of a nozzle opens where the previous one closed.
-- A gap is litres that left the tank and were billed to nobody.
INSERT INTO audit_count
SELECT 'M4', 'meters', count(*), 'each holding of a nozzle opens at the previous closing reading' FROM a_raw;
INSERT INTO audit
SELECT 'M4', 'meters', 'nozzle ' || n.code || ' assignment ' || x.assignment_id, x.prev_close, x.v_open,
       'litres between holdings, billed to nobody: ' || round(x.v_open - x.prev_close, 3)
  FROM (SELECT a.*, lag(a.v_close) OVER (PARTITION BY a.nozzle_id ORDER BY a.open_at, a.assignment_id) AS prev_close
          FROM a_raw a) x
  JOIN nozzle n ON n.id = x.nozzle_id
 WHERE x.prev_close IS NOT NULL AND x.v_open <> x.prev_close;

-- ---------------------------------------------------------------------------
-- 2. EVERY LITRE CLASSIFIED
-- ---------------------------------------------------------------------------
INSERT INTO audit_count SELECT 'D1', 'litres', count(*), 'sold + tests + own use + returned = metered, per event' FROM meter_event me JOIN s_closed s ON s.id = me.shift_id;
INSERT INTO audit
SELECT 'D1', 'litres', 'meter event ' || me.id, me.gross_litres, COALESCE(SUM(md.litres), 0), 'classified litres'
  FROM meter_event me JOIN s_closed s ON s.id = me.shift_id
  LEFT JOIN metered_disposition md ON md.meter_event_id = me.id
 GROUP BY me.id, me.gross_litres HAVING COALESCE(SUM(md.litres), 0) <> me.gross_litres;

INSERT INTO audit_count SELECT 'D2', 'litres', count(*), 'litres sold = metered - tests - own use - returns, in the attendant''s own window' FROM a_owed;
INSERT INTO audit
SELECT 'D2', 'litres', 'assignment ' || a.assignment_id, a.sale_litres,
       COALESCE((SELECT SUM(md.litres) FROM metered_disposition md WHERE md.meter_event_id = me.id AND md.kind = 'SALE'), 0),
       'tests ' || a.tests || ', own use ' || a.own || ', returned ' || a.rtt
  FROM a_owed a JOIN meter_event me ON me.assignment_id = a.assignment_id
 WHERE COALESCE((SELECT SUM(md.litres) FROM metered_disposition md WHERE md.meter_event_id = me.id AND md.kind = 'SALE'), 0) <> a.sale_litres;

INSERT INTO audit_count SELECT 'D3', 'litres', count(*), 'tests, own use and returns are each classified to the litre' FROM a_owed;
INSERT INTO audit
SELECT 'D3', 'litres', 'assignment ' || a.assignment_id || ' ' || k.kind, k.want,
       COALESCE((SELECT SUM(md.litres) FROM metered_disposition md WHERE md.meter_event_id = me.id AND md.kind::text = k.kind), 0), ''
  FROM a_owed a JOIN meter_event me ON me.assignment_id = a.assignment_id
  CROSS JOIN LATERAL (VALUES ('PUMP_TEST', a.tests), ('OWN_USE', a.own), ('RTT', a.rtt)) k(kind, want)
 WHERE COALESCE((SELECT SUM(md.litres) FROM metered_disposition md WHERE md.meter_event_id = me.id AND md.kind::text = k.kind), 0) <> k.want;

-- ---------------------------------------------------------------------------
-- 3. PRICE
-- ---------------------------------------------------------------------------
INSERT INTO audit_count SELECT 'P1', 'price', count(*), 'every litre sold is priced at the shift''s captured price' FROM a_owed;
INSERT INTO audit
SELECT 'P1', 'price', 'assignment ' || a.assignment_id, a.price, md.unit_price, 'price on the sale'
  FROM a_owed a JOIN meter_event me ON me.assignment_id = a.assignment_id
  JOIN metered_disposition md ON md.meter_event_id = me.id AND md.kind = 'SALE'
 WHERE md.unit_price IS DISTINCT FROM a.price;

INSERT INTO audit_count SELECT 'P2', 'price', count(*), 'each shift has a captured price for every product it sold' FROM a_owed;
INSERT INTO audit
SELECT 'P2', 'price', 'assignment ' || a.assignment_id, NULL, NULL, 'no captured price for the product'
  FROM a_owed a WHERE a.price IS NULL AND a.sale_litres > 0;

-- ---------------------------------------------------------------------------
-- 4. CREDIT SALES
-- ---------------------------------------------------------------------------
INSERT INTO audit_count SELECT 'K1', 'credit', count(*), 'amount = litres x unit price; pump price = the shift''s price; no agreement = pump price'
  FROM credit_sale cs JOIN s_closed s ON s.id = cs.shift_id;
INSERT INTO audit
SELECT 'K1', 'credit', 'credit sale ' || cs.voucher_no, round(cs.litres * cs.unit_price, 2), cs.amount, 'litres x unit price'
  FROM credit_sale cs JOIN s_closed s ON s.id = cs.shift_id
 WHERE cs.amount <> round(cs.litres * cs.unit_price, 2);
INSERT INTO audit
SELECT 'K1', 'credit', 'credit sale ' || cs.voucher_no, sp.unit_price, cs.pump_price, 'pump price against the shift''s'
  FROM credit_sale cs JOIN s_closed s ON s.id = cs.shift_id
  JOIN shift_price sp ON sp.shift_id = cs.shift_id AND sp.product_id = cs.product_id
 WHERE cs.pump_price IS NOT NULL AND cs.pump_price <> sp.unit_price;
INSERT INTO audit
SELECT 'K1', 'credit', 'credit sale ' || cs.voucher_no, cs.pump_price, cs.unit_price, 'no agreed price, yet not the pump price'
  FROM credit_sale cs JOIN s_closed s ON s.id = cs.shift_id
 WHERE cs.customer_price_id IS NULL AND cs.pump_price IS NOT NULL AND cs.unit_price <> cs.pump_price;

-- ---------------------------------------------------------------------------
-- 5. CASH-UPS: what each attendant owes, what they settled, the gap
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW c_calc AS
  SELECT cu.id AS cash_up_id, cu.shift_id, cu.staff_id, cu.status,
         -- owed: fuel at the shift price, from the raw readings; shop sales
         COALESCE((SELECT SUM(a.sale_value) FROM a_owed a
                    WHERE a.shift_id = cu.shift_id AND a.attendant_id = cu.staff_id), 0) AS fuel,
         COALESCE((SELECT SUM(ds.total_amount) FROM dry_sale ds
                    WHERE ds.shift_id = cu.shift_id AND ds.seller_id = cu.staff_id), 0) AS shop,
         -- settled: declared cash and tenders are inputs, read as declared
         COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = cu.id
                    AND mm.settlement = 'CASH' AND COALESCE(mm.reference, '') NOT LIKE 'DROP %'), 0) AS cash,
         COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = cu.id
                    AND mm.settlement IN ('MOBILE_MONEY', 'CARD', 'VOUCHER')), 0) AS tenders,
         -- settled: derived from their own records
         COALESCE((SELECT SUM(cd.amount) FROM cash_drop cd
                    WHERE cd.shift_id = cu.shift_id AND cd.attendant_id = cu.staff_id AND cd.voided_at IS NULL), 0) AS drops,
         COALESCE((SELECT SUM(cs.amount) FROM credit_sale cs
                    WHERE cs.shift_id = cu.shift_id AND cs.attendant_id = cu.staff_id), 0) AS credit,
         COALESCE((SELECT SUM(round(cs.litres * cs.pump_price, 2) - cs.amount) FROM credit_sale cs
                    WHERE cs.shift_id = cu.shift_id AND cs.attendant_id = cu.staff_id
                      AND cs.customer_price_id IS NOT NULL), 0) AS agreement,
         COALESCE((SELECT SUM(dg.amount) FROM discount_grant dg
                    WHERE dg.shift_id = cu.shift_id AND dg.staff_id = cu.staff_id), 0) AS discount
    FROM cash_up cu JOIN s_closed s ON s.id = cu.shift_id;

INSERT INTO audit_count SELECT 'C1', 'cash', count(*), 'fuel charged = litres sold x shift price, per attendant' FROM c_calc;
INSERT INTO audit
SELECT 'C1', 'cash', 'cash-up ' || c.cash_up_id, c.fuel,
       COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id
                  AND mm.entry = 'SALE' AND mm.dry_sale_id IS NULL), 0), 'fuel charged'
  FROM c_calc c
 WHERE c.fuel <> COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id
                  AND mm.entry = 'SALE' AND mm.dry_sale_id IS NULL), 0);

INSERT INTO audit_count SELECT 'C2', 'cash', count(*), 'shop sales charged to their seller' FROM c_calc;
INSERT INTO audit
SELECT 'C2', 'cash', 'cash-up ' || c.cash_up_id, c.shop,
       COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.dry_sale_id IS NOT NULL), 0), 'shop charged'
  FROM c_calc c
 WHERE c.shop <> COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.dry_sale_id IS NOT NULL), 0);

INSERT INTO audit_count SELECT 'C3', 'cash', count(*), 'drops, credit, agreed-price differences and discounts settle exactly what was recorded' FROM c_calc;
INSERT INTO audit
SELECT 'C3', 'cash', 'cash-up ' || c.cash_up_id || ' ' || k.kind, k.want, k.got, ''
  FROM c_calc c CROSS JOIN LATERAL (VALUES
    ('drops', c.drops, COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id
                                  AND mm.settlement = 'CASH' AND mm.reference LIKE 'DROP %'), 0)),
    ('credit', c.credit, COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.settlement = 'CREDIT'), 0)),
    ('agreed price', c.agreement, COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.settlement = 'PRICE_AGREEMENT'), 0)),
    ('discount', c.discount, COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.settlement = 'DISCOUNT'), 0))
  ) k(kind, want, got)
 WHERE k.want <> k.got;

-- The gap: owed - settled. Positive is a shortage against the person, negative an overage.
INSERT INTO audit_count SELECT 'C4', 'cash', count(*), 'shortage = owed - settled, against the attendant; overage the other way' FROM c_calc;
INSERT INTO audit
SELECT 'C4', 'cash', 'cash-up ' || c.cash_up_id, x.gap,
       COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss WHERE ss.cash_up_id = c.cash_up_id), 0)
     - COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.settlement = 'OVERAGE'), 0),
       'owed ' || (c.fuel + c.shop) || ', settled ' || (c.cash + c.drops + c.tenders + c.credit + c.agreement + c.discount)
  FROM c_calc c
 CROSS JOIN LATERAL (SELECT (c.fuel + c.shop) - (c.cash + c.drops + c.tenders + c.credit + c.agreement + c.discount) AS gap) x
 WHERE x.gap <> COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss WHERE ss.cash_up_id = c.cash_up_id), 0)
             - COALESCE((SELECT SUM(mm.amount) FROM money_movement mm WHERE mm.cash_up_id = c.cash_up_id AND mm.settlement = 'OVERAGE'), 0);

INSERT INTO audit_count SELECT 'C4b', 'cash', count(*), 'a shortage is against the attendant whose cash-up raised it, on that shift' FROM staff_shortage ss JOIN s_closed s ON s.id = ss.shift_id;
INSERT INTO audit
SELECT 'C4b', 'cash', 'shortage ' || ss.id, NULL, NULL, 'charged to someone other than the cash-up''s attendant, or another shift'
  FROM staff_shortage ss JOIN s_closed s ON s.id = ss.shift_id JOIN cash_up cu ON cu.id = ss.cash_up_id
 WHERE ss.staff_id <> cu.staff_id OR ss.shift_id <> cu.shift_id;
INSERT INTO audit
SELECT 'C4b', 'cash', 'money line ' || mm.id, NULL, NULL, 'a cash-up line names a different attendant or shift'
  FROM money_movement mm JOIN cash_up cu ON cu.id = mm.cash_up_id JOIN s_closed s ON s.id = cu.shift_id
 WHERE mm.staff_id <> cu.staff_id OR mm.shift_id <> cu.shift_id;

INSERT INTO audit_count SELECT 'C5', 'cash', count(*), 'every cash-up nets to nil' FROM c_calc;
INSERT INTO audit
SELECT 'C5', 'cash', 'cash-up ' || c.cash_up_id, 0, COALESCE(SUM(mm.amount), 0), 'sum of its lines'
  FROM c_calc c LEFT JOIN money_movement mm ON mm.cash_up_id = c.cash_up_id
 GROUP BY c.cash_up_id HAVING COALESCE(SUM(mm.amount), 0) <> 0;

INSERT INTO audit_count SELECT 'C6', 'cash', count(*), 'everyone who sold on a shift has a cash-up' FROM s_closed;
INSERT INTO audit
SELECT 'C6', 'cash', 'shift ' || w.shift_id || ' staff ' || w.staff_id, 1, 0, 'sold but not cashed up'
  FROM (SELECT shift_id, attendant_id AS staff_id FROM a_raw
        UNION SELECT ds.shift_id, ds.seller_id FROM dry_sale ds JOIN s_closed s ON s.id = ds.shift_id
        UNION SELECT cs.shift_id, cs.attendant_id FROM credit_sale cs JOIN s_closed s ON s.id = cs.shift_id
        UNION SELECT cd.shift_id, cd.attendant_id FROM cash_drop cd JOIN s_closed s ON s.id = cd.shift_id WHERE cd.voided_at IS NULL) w
 WHERE NOT EXISTS (SELECT 1 FROM cash_up cu WHERE cu.shift_id = w.shift_id AND cu.staff_id = w.staff_id);

-- ---------------------------------------------------------------------------
-- 6. TANKS: what the close took off and put back, per tank per shift
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW t_calc AS
  SELECT s.id AS shift_id, t.id AS tank_id, t.code,
         COALESCE((SELECT SUM(a.gross) FROM a_owed a WHERE a.shift_id = s.id AND a.tank_id = t.id), 0) AS metered,
         COALESCE((SELECT SUM(pt.measured_litres) FROM pump_test pt JOIN nozzle n ON n.id = pt.nozzle_id
                    WHERE pt.shift_id = s.id AND n.tank_id = t.id AND pt.returned_to_tank AND pt.measured_litres > 0), 0) AS tests_back,
         COALESCE((SELECT SUM(r.litres) FROM return_to_tank r JOIN nozzle n ON n.id = r.nozzle_id
                    WHERE r.shift_id = s.id AND n.tank_id = t.id), 0) AS rtt_back,
         COALESCE((SELECT SUM(bd.litres) FROM bulk_draw bd WHERE bd.shift_id = s.id AND bd.tank_id = t.id), 0) AS bulk
    FROM s_closed s JOIN tank t ON t.site_id = s.site_id;

INSERT INTO audit_count SELECT 'T1', 'tanks', count(*), 'the tank loses what its meters counted, gets back returned tests and returns, loses bulk draws -- once each' FROM t_calc;
INSERT INTO audit
SELECT 'T1', 'tanks', 'shift ' || c.shift_id || ' tank ' || c.code || ' ' || k.kind, k.want,
       (SELECT COALESCE(SUM(fm.litres), 0)
                     - COALESCE((SELECT SUM(x.litres) FROM fuel_movement x JOIN fuel_movement o ON o.id = x.corrects_id
                                  WHERE o.shift_id = c.shift_id AND o.tank_id = c.tank_id AND o.kind::text = k.kind), 0)
                  FROM fuel_movement fm WHERE fm.shift_id = c.shift_id AND fm.tank_id = c.tank_id AND fm.kind::text = k.kind), ''
  FROM t_calc c CROSS JOIN LATERAL (VALUES ('METER_OUT', c.metered), ('TEST_RETURN_IN', c.tests_back),
                                           ('RTT_IN', c.rtt_back), ('BULK_OUT', c.bulk)) k(kind, want)
 WHERE k.want <> (SELECT COALESCE(SUM(fm.litres), 0)
                     - COALESCE((SELECT SUM(x.litres) FROM fuel_movement x JOIN fuel_movement o ON o.id = x.corrects_id
                                  WHERE o.shift_id = c.shift_id AND o.tank_id = c.tank_id AND o.kind::text = k.kind), 0)
                  FROM fuel_movement fm WHERE fm.shift_id = c.shift_id AND fm.tank_id = c.tank_id AND fm.kind::text = k.kind);

-- The variance at each close: the change in the dip, less what the records say
-- went in and out since the previous close. Bounded by the moment each close
-- wrote its movements -- not the dip's capture time (an offline dip can be
-- stamped earlier), and not closed_at (the demo seed backdates it afterwards).
CREATE TEMP VIEW v_calc AS
  WITH moment AS (
    SELECT s.id, COALESCE((SELECT max(fm.occurred_at) FROM fuel_movement fm
                            WHERE fm.shift_id = s.id AND fm.kind = 'METER_OUT'), s.closed_at) AS at
      FROM shift s WHERE s.closed_at IS NOT NULL AND s.state <> 'VOID'),
  closes AS (
    SELECT d.id, d.tank_id, d.shift_id, d.product_litres, m.at AS closed_at,
           lag(d.product_litres) OVER w AS prev_dip, lag(m.at) OVER w AS prev_at
      FROM dip_reading d JOIN moment m ON m.id = d.shift_id
     WHERE d.context = 'SHIFT_CLOSE'
    WINDOW w AS (PARTITION BY d.tank_id ORDER BY m.at, d.id))
  SELECT c.*, t.code, s.is_depot_day,
         round(c.product_litres - COALESCE(c.prev_dip, 0)
           - COALESCE((SELECT SUM(fm.signed_litres) FROM fuel_movement fm
                        WHERE fm.tank_id = c.tank_id AND fm.kind <> 'STOCK_TAKE_ADJUST'
                          AND fm.occurred_at <= c.closed_at
                          AND (c.prev_at IS NULL OR fm.occurred_at > c.prev_at)), 0), 3) AS variance,
         -- at a station, litres sold through the meters; at a depot, the
         -- day's loads (by the depot's own clock)
         CASE WHEN s.is_depot_day
              THEN COALESCE((SELECT SUM(bs.litres) FROM bulk_sale bs WHERE bs.tank_id = c.tank_id
                              AND (bs.loaded_at AT TIME ZONE st.timezone - st.day_starts_at)::date = s.business_date), 0)
              ELSE COALESCE((SELECT SUM(md.litres) FROM metered_disposition md JOIN meter_event me ON me.id = md.meter_event_id
                              WHERE me.shift_id = c.shift_id AND me.tank_id = c.tank_id AND md.kind = 'SALE'), 0) END AS sold
    FROM closes c JOIN tank t ON t.id = c.tank_id
    JOIN shift s ON s.id = c.shift_id JOIN site st ON st.id = s.site_id
   WHERE c.shift_id IN (SELECT id FROM s_closed);

INSERT INTO audit_count SELECT 'T2', 'tanks', count(*), 'a variance outside tolerance is flagged with its true size; one inside is not' FROM v_calc;
INSERT INTO audit
SELECT 'T2', 'tanks', 'shift ' || v.shift_id || ' tank ' || v.code,
       CASE WHEN x.outside THEN v.variance END,
       (SELECT COALESCE(ef.detail->>'variance_litres', ef.detail->>'variance')::numeric FROM exception_flag ef
         WHERE ef.shift_id = v.shift_id AND ef.code = 'STOCK_VARIANCE' AND ef.entity_id = v.tank_id::text LIMIT 1),
       CASE WHEN x.outside THEN 'outside tolerance' ELSE 'inside tolerance' END || ': ' || v.variance || ' L on ' || v.sold || ' L sold'
  FROM v_calc v
  JOIN shift s ON s.id = v.shift_id JOIN tenant_policy p ON p.tenant_id = s.tenant_id
 CROSS JOIN LATERAL (SELECT
        (abs(v.variance) > p.shift_variance_litres
         OR (v.sold > 0 AND abs(v.variance / v.sold * 100) > p.shift_variance_pct))
        -- a station's dipstick noise floor; a depot day has none (500)
        AND (v.is_depot_day OR abs(v.variance) > p.dip_noise_litres) AS outside) x
 WHERE (x.outside AND NOT EXISTS (SELECT 1 FROM exception_flag ef WHERE ef.shift_id = v.shift_id AND ef.code = 'STOCK_VARIANCE'
                                   AND ef.entity_id = v.tank_id::text
                                   AND abs(COALESCE(ef.detail->>'variance_litres', ef.detail->>'variance')::numeric - v.variance) < 0.001))
    OR (NOT x.outside AND EXISTS (SELECT 1 FROM exception_flag ef WHERE ef.shift_id = v.shift_id AND ef.code = 'STOCK_VARIANCE'
                                   AND ef.entity_id = v.tank_id::text));

-- ---------------------------------------------------------------------------
-- 7. THE SHIFT'S JOURNAL agrees with the shift
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW j_shift AS
  SELECT s.id AS shift_id, j.id AS journal_id
    FROM s_closed s JOIN gl_journal j ON j.source = 'shift' AND j.source_id = s.id::text AND j.reverses_id IS NULL
   WHERE NOT EXISTS (SELECT 1 FROM gl_journal r WHERE r.reverses_id = j.id);

INSERT INTO audit_count SELECT 'J1', 'journal', count(*), 'an approved shift has one standing journal' FROM s_closed WHERE state IN ('APPROVED', 'POSTED');
INSERT INTO audit
SELECT 'J1', 'journal', 'shift ' || s.id, 1, (SELECT count(*) FROM j_shift j WHERE j.shift_id = s.id), 'standing journals'
  FROM s_closed s WHERE s.state IN ('APPROVED', 'POSTED')
   AND (SELECT count(*) FROM j_shift j WHERE j.shift_id = s.id) <> 1;

INSERT INTO audit_count SELECT 'J2', 'journal', count(*), 'fuel sales, shop sales, cash, credit, shortages in the journal = the shift''s own figures' FROM j_shift;
INSERT INTO audit
SELECT 'J2', 'journal', 'shift ' || j.shift_id || ' ' || k.code || ' ' || k.name, k.want,
       COALESCE((SELECT SUM(l.amount) FROM gl_line l JOIN gl_account a ON a.id = l.account_id
                  WHERE l.journal_id = j.journal_id AND a.code = k.code), 0), ''
  FROM j_shift j
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM(c.fuel), 0) fuel, COALESCE(SUM(c.shop), 0) shop, COALESCE(SUM(c.cash + c.drops), 0) cash,
          COALESCE(SUM(c.credit), 0) credit
     FROM c_calc c WHERE c.shift_id = j.shift_id) t
 CROSS JOIN LATERAL (VALUES ('4000', 'fuel sales', -t.fuel), ('4010', 'shop sales', -t.shop),
                            ('1000', 'cash', t.cash), ('1100', 'credit', t.credit),
                            ('1110', 'shortages', COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss WHERE ss.shift_id = j.shift_id), 0))
   ) k(code, name, want)
 WHERE k.want <> COALESCE((SELECT SUM(l.amount) FROM gl_line l JOIN gl_account a ON a.id = l.account_id
                  WHERE l.journal_id = j.journal_id AND a.code = k.code), 0);

INSERT INTO audit_count SELECT 'J3', 'journal', count(*), 'litres in the journal: the tank leaves the shift at its closing dip' FROM j_shift;
INSERT INTO audit
SELECT 'J3', 'journal', 'shift ' || j.shift_id || ' tank ' || t.code, d.product_litres,
       (SELECT SUM(l.qty) FROM gl_line l JOIN gl_journal gj ON gj.id = l.journal_id JOIN gl_account a ON a.id = l.account_id
         WHERE a.code = '1200' AND l.tank_id = t.id
           AND (gj.posted_at, gj.id) <= (SELECT posted_at, id FROM gl_journal WHERE id = j.journal_id)
           AND gj.event_at <= (SELECT event_at FROM gl_journal WHERE id = j.journal_id)),
       'ledger litres after the shift''s journal'
  FROM j_shift j JOIN shift s ON s.id = j.shift_id
  JOIN tank t ON t.site_id = s.site_id
  JOIN dip_reading d ON d.shift_id = j.shift_id AND d.tank_id = t.id AND d.context = 'SHIFT_CLOSE'
 WHERE j.shift_id = (SELECT s2.id FROM s_closed s2 WHERE s2.site_id = s.site_id ORDER BY s2.closed_at DESC LIMIT 1)
   AND abs(d.product_litres - COALESCE((SELECT SUM(l.qty) FROM gl_line l JOIN gl_account a ON a.id = l.account_id
                                         WHERE a.code = '1200' AND l.tank_id = t.id), 0)) >= 0.001;

-- ---------------------------------------------------------------------------
-- 8. DEPOTS: each depot day's tank movement, independently
-- ---------------------------------------------------------------------------
INSERT INTO audit_count SELECT 'B1', 'depot', count(*), 'a bulk sale is litres x unit price' FROM bulk_sale;
INSERT INTO audit
SELECT 'B1', 'depot', 'bulk sale ' || b.invoice_no, round(b.litres * b.unit_price, 2), b.amount, 'litres x unit price'
  FROM bulk_sale b WHERE b.amount <> round(b.litres * b.unit_price, 2);

INSERT INTO audit_count SELECT 'B2', 'depot', count(*), 'each bulk sale leaves its tank once, at its litres' FROM bulk_sale;
INSERT INTO audit
SELECT 'B2', 'depot', 'bulk sale ' || b.invoice_no, b.litres,
       COALESCE((SELECT SUM(fm.litres) FROM fuel_movement fm WHERE fm.bulk_sale_id = b.id AND fm.kind = 'BULK_OUT'), 0), 'litres out'
  FROM bulk_sale b
 WHERE b.litres <> COALESCE((SELECT SUM(fm.litres) FROM fuel_movement fm WHERE fm.bulk_sale_id = b.id AND fm.kind = 'BULK_OUT'), 0);

INSERT INTO audit_count SELECT 'B3', 'depot', count(*), 'a transfer leaves one tank and arrives in the other, same litres' FROM stock_transfer;
INSERT INTO audit
SELECT 'B3', 'depot', 'transfer ' || st.reference, st.litres,
       COALESCE((SELECT SUM(fm.litres) FROM fuel_movement fm WHERE fm.stock_transfer_id = st.id AND fm.tank_id = k.tank), 0), k.side
  FROM stock_transfer st CROSS JOIN LATERAL (VALUES (st.from_tank_id, 'out'), (st.to_tank_id, 'in')) k(tank, side)
 WHERE st.litres <> COALESCE((SELECT SUM(fm.litres) FROM fuel_movement fm WHERE fm.stock_transfer_id = st.id AND fm.tank_id = k.tank), 0);

-- ---------------------------------------------------------------------------
SELECT c.rule, c.area, c.checked, COALESCE(f.n, 0) AS differences, c.description
  FROM audit_count c LEFT JOIN (SELECT rule, count(*) n FROM audit GROUP BY rule) f ON f.rule = c.rule
 ORDER BY c.rule;
SELECT rule, what, expected, got, note FROM audit ORDER BY rule, what LIMIT 40;

SELECT (SELECT count(*) FROM s_closed) AS shifts_audited, (SELECT count(*) FROM audit) AS differences \gset
\echo SHIFT MATH: :shifts_audited closed shifts recomputed, :differences differences
\if :strict
  SELECT CASE WHEN :differences > 0 THEN 1/0 END AS shift_math_differs;
\endif
