-- =============================================================================
-- FCMS v2 -- test/shift_math_scenario.sql
--
-- The paths the 90-day demo never takes, closed through the real
-- fn_close_shift and then recomputed by tools/audit/shift_math.sql:
--   * a nozzle handed over mid-shift (two meter events on one nozzle),
--     with a pump test on each side of the handover, both returned to tank;
--   * fuel returned to the tank by the incoming attendant;
--   * metered own use.
-- Run AFTER the three seeds. Everything rolls back.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
\set T    '0a000000-0000-4000-8000-000000000001'
\set SUP2 '10000000-0000-4000-8000-000000000003'
\set JOHN  '10000000-0000-4000-8000-000000000013'
\set ALICE '10000000-0000-4000-8000-000000000012'
\set PETER '10000000-0000-4000-8000-000000000011'
\set MOSES '10000000-0000-4000-8000-000000000010'
SELECT set_config('app.tenant_id', :'T', true), set_config('app.staff_id', :'SUP2', true) \gset
SELECT id AS shf, site_id AS site FROM shift WHERE state = 'OPEN' \gset

SELECT na.id AS n1, n.id AS n1_nozzle, mr.volume_totalizer AS n1_open, n.tank_id AS n1_tank, n.integer_digits AS n1_digits
  FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
  JOIN meter_reading mr ON mr.assignment_id = na.id AND mr.is_opening
 WHERE na.shift_id = :'shf' AND n.code = 'N1' \gset
SELECT na.id AS n2, n.id AS n2_nozzle, n.tank_id AS n2_tank FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
 WHERE na.shift_id = :'shf' AND n.code = 'N2' \gset

-- Event times between the last thing recorded and now, in order -- the seed
-- closed its day shift only moments ago, so "an hour ago" would fall in it.
SELECT m + (now() - m) * 0.2 AS t_test1, m + (now() - m) * 0.3 AS t_own, m + (now() - m) * 0.5 AS t_hand,
       m + (now() - m) * 0.7 AS t_test2, m + (now() - m) * 0.8 AS t_rtt
  FROM (SELECT max(occurred_at) AS m FROM fuel_movement) x \gset

\echo '  shift math: John tests N1 (20 L back), uses 10 L for the generator, then hands N1 to Alice'
INSERT INTO pump_test (tenant_id, site_id, shift_id, nozzle_id, can_size_litres, measured_litres, returned_to_tank, tested_by, tested_at)
VALUES (:'T', :'site', :'shf', :'n1_nozzle', 20, 20.1, TRUE, :'SUP2', :'t_test1');
INSERT INTO own_use (tenant_id, site_id, shift_id, tank_id, nozzle_id, litres, purpose, authorised_by, recorded_at)
VALUES (:'T', :'site', :'shf', :'n1_tank', :'n1_nozzle', 10, 'GENERATOR', :'SUP2', :'t_own');

-- The handover, as ForecourtService.HandoverAsync writes it: John's closing
-- reading is Alice's opening, one number recorded once.
SELECT :n1_open + 370 AS hand \gset
INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id, is_opening, source,
                           volume_totalizer, evidence, recorded_by, captured_at, is_rollover)
VALUES (:'T', :'site', :'n1_nozzle', :'shf', :'n1', FALSE, 'MANUAL', :hand, 'PENDING', :'SUP2', :'t_hand', FALSE);
UPDATE nozzle_assignment SET state = 'CLOSED', released_at = :'t_hand', released_by = :'SUP2' WHERE id = :'n1';
INSERT INTO nozzle_assignment (tenant_id, site_id, shift_id, nozzle_id, attendant_id, assigned_by, assigned_at)
VALUES (:'T', :'site', :'shf', :'n1_nozzle', :'ALICE', :'SUP2', :'t_hand') RETURNING id AS n1b \gset
INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id, is_opening, source,
                           volume_totalizer, evidence, recorded_by, captured_at)
VALUES (:'T', :'site', :'n1_nozzle', :'shf', :'n1b', TRUE, 'MANUAL', :hand, 'PENDING', :'SUP2', :'t_hand');
UPDATE nozzle_assignment SET handed_to_id = :'n1b', state = 'HANDED_OVER' WHERE id = :'n1';

\echo '  shift math: Alice tests N1 with a 10 L can (back to tank) and pours 5 L back'
INSERT INTO pump_test (tenant_id, site_id, shift_id, nozzle_id, can_size_litres, measured_litres, returned_to_tank, tested_by, tested_at)
VALUES (:'T', :'site', :'shf', :'n1_nozzle', 10, 9.9, TRUE, :'SUP2', :'t_test2');
INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres, reason, recorded_by, witnessed_by, recorded_at)
VALUES (:'T', :'site', :'shf', :'n1_nozzle', 5, 'Customer cancelled', :'SUP2', '10000000-0000-4000-8000-000000000002', :'t_rtt');

-- Alice holds N1 for moments when the seed ran just before this: 25 L stays
-- inside what the pump can deliver in the close's minimum 36 seconds.
\echo '  shift math: close the shift; John metered 370 L, Alice 25 L on N1'
SELECT round(fn_book_stock(:'n1_tank'), 1) AS book1, round(fn_book_stock(:'n2_tank'), 1) AS book2 \gset
SELECT fn_close_shift(:'shf', :'SUP2', 'SCHEDULED',
  (SELECT jsonb_agg(jsonb_build_object('assignment_id', na.id, 'is_rollover', false,
     'volume_totalizer', (SELECT volume_totalizer FROM meter_reading mr WHERE mr.assignment_id = na.id AND mr.is_opening)
        + CASE n.code WHEN 'N1' THEN 25 WHEN 'N2' THEN 300 WHEN 'N3' THEN 200 ELSE 400 END))
     FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id WHERE na.shift_id = :'shf' AND na.state = 'ACTIVE'),
  -- Each tank dipped at exactly what the records say is left: no variance.
  -- Tank 1: metered 370 + 25 + 200 (N3), back 20.1 + 9.9 + 5.
  jsonb_build_array(
    jsonb_build_object('tank_id', :'n1_tank', 'product_litres', :book1 - (370 + 25 + 200) + (20.1 + 9.9 + 5), 'water_litres', 0),
    jsonb_build_object('tank_id', :'n2_tank', 'product_litres', :book2 - (300 + 400), 'water_litres', 0)),
  jsonb_build_array(
    jsonb_build_object('attendant_id', :'JOHN',  'cash', 100000, 'tenders', '[]'::jsonb),
    jsonb_build_object('attendant_id', :'ALICE', 'cash', 100000, 'tenders', '[]'::jsonb),
    jsonb_build_object('attendant_id', :'PETER', 'cash', 100000, 'tenders', '[]'::jsonb),
    jsonb_build_object('attendant_id', :'MOSES', 'cash', 100000, 'tenders', '[]'::jsonb))
)::text AS result \gset

DO $$
DECLARE john numeric; alice numeric; back numeric;
BEGIN
  SELECT SUM(md.litres) FILTER (WHERE na.attendant_id = '10000000-0000-4000-8000-000000000013'),
         SUM(md.litres) FILTER (WHERE na.attendant_id = '10000000-0000-4000-8000-000000000012')
    INTO john, alice
    FROM metered_disposition md JOIN meter_event me ON me.id = md.meter_event_id
    JOIN nozzle_assignment na ON na.id = me.assignment_id JOIN nozzle n ON n.id = me.nozzle_id
   WHERE n.code = 'N1' AND md.kind = 'SALE' AND me.shift_id = (SELECT id FROM shift WHERE state = 'DECLARED' ORDER BY closed_at DESC LIMIT 1);
  -- John: 370 metered - 20.1 test - 10 own use. Alice: 25 - 9.9 test - 5 returned.
  IF john IS DISTINCT FROM 339.900 OR alice IS DISTINCT FROM 10.100 THEN
    RAISE EXCEPTION 'SHIFT MATH: N1 sold % L by John (expected 339.9) and % L by Alice (expected 10.1)', john, alice;
  END IF;
END $$;

\set strict 1
\i tools/audit/shift_math.sql

\echo '  shift math: a close made before 700 booked the returns twice; the repair reverses the copies'
-- Recreate the old fault: each return also booked against the other holding.
SET session_replication_role = replica;
INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id, kind, litres, signed_litres,
                           meter_event_id, occurred_at, recorded_by)
SELECT fm.tenant_id, fm.site_id, fm.tank_id, fm.product_id, fm.shift_id, fm.kind, fm.litres, fm.signed_litres,
       other.id, fm.occurred_at, fm.recorded_by
  FROM fuel_movement fm JOIN meter_event me ON me.id = fm.meter_event_id
  JOIN meter_event other ON other.nozzle_id = me.nozzle_id AND other.shift_id = me.shift_id AND other.id <> me.id
 WHERE fm.kind IN ('TEST_RETURN_IN', 'RTT_IN') AND fm.shift_id = :'shf';
SET session_replication_role = origin;
SELECT count(*) AS dups FROM fuel_movement WHERE kind IN ('TEST_RETURN_IN', 'RTT_IN') AND shift_id = :'shf' \gset
\echo '    returns now booked:' :dups 'rows (3 real)'
SELECT (SELECT count(*) FROM gl_journal) AS journals_before \gset
-- 2 -------------------------------------------------------------------------
-- A duplicate: a returned row whose twin (same shift, tank, kind, time, litres)
-- is attached to the holding the litres really fell in.
WITH ranked AS (
  SELECT fm.*,
         row_number() OVER (PARTITION BY fm.shift_id, fm.tank_id, fm.kind, fm.occurred_at, fm.litres
                            ORDER BY (fm.occurred_at >= na.assigned_at
                                      AND fm.occurred_at < COALESCE(na.released_at, 'infinity'::timestamptz)) DESC,
                                     fm.id) AS rn
    FROM fuel_movement fm
    JOIN meter_event me ON me.id = fm.meter_event_id
    JOIN nozzle_assignment na ON na.id = me.assignment_id
   WHERE fm.kind IN ('TEST_RETURN_IN', 'RTT_IN'))
INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id, kind, litres, signed_litres,
                           corrects_id, correction_note, occurred_at, recorded_by)
SELECT r.tenant_id, r.site_id, r.tank_id, r.product_id, r.shift_id, 'CORRECTION', r.litres, -r.signed_litres,
       r.id, '700: the close booked these litres back twice (nozzle handed over mid-shift)', r.occurred_at, r.recorded_by
  FROM ranked r
 WHERE r.rn > 1
   AND NOT EXISTS (SELECT 1 FROM fuel_movement c WHERE c.corrects_id = r.id);

DO $$
BEGIN
  IF (SELECT count(*) FROM fuel_movement WHERE kind = 'CORRECTION' AND correction_note LIKE '700:%') <> 3 THEN
    RAISE EXCEPTION 'SHIFT MATH: the repair reversed % copies, expected 3',
      (SELECT count(*) FROM fuel_movement WHERE kind = 'CORRECTION' AND correction_note LIKE '700:%');
  END IF;
  IF EXISTS (SELECT 1 FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date)
              WHERE control LIKE 'Fuel stock%' AND ok IS FALSE) THEN
    RAISE EXCEPTION 'SHIFT MATH: after the repair the books no longer agree with the tanks';
  END IF;
END $$;
SELECT (SELECT count(*) FROM gl_journal) - :journals_before AS new_journals \gset
\echo '    journals posted by the repair:' :new_journals '(must be 0)'
SELECT CASE WHEN :new_journals <> 0 THEN 1/0 END;
\i tools/audit/shift_math.sql
ROLLBACK;

\echo '  shift math: a depot day loads 4,000 L mid-morning and 6,000 L at 04:30 next morning, closes 40 L short (720)'
-- The depot's day starts at 06:00, so the 04:30 truck is the same business
-- day. 40 L on 10,000 L is inside tolerance (0.5 %); counted by the UTC
-- calendar it was 40 L on 4,000 L -- outside, and the close refused it
-- without a reason.
BEGIN;
SELECT set_config('app.tenant_id', :'T', true), set_config('app.staff_id', '10000000-0000-4000-8000-000000000001', true) \gset
DO $$
DECLARE
  c_site uuid := '0b000000-0000-4000-8000-000000000002';
  c_tank uuid := '0d000000-0000-4000-8000-00000000d001';
  c_tank2 uuid := '0d000000-0000-4000-8000-00000000d002';
  c_mgr  uuid := '10000000-0000-4000-8000-000000000001';
  v_day uuid; v_date date := fn_business_date('0b000000-0000-4000-8000-000000000002', now()) - 1;
BEGIN
  v_day := fn_open_depot_day(c_site, c_mgr, jsonb_build_array(
             jsonb_build_object('tank_id', c_tank,  'product_litres', fn_book_stock(c_tank)),
             jsonb_build_object('tank_id', c_tank2, 'product_litres', fn_book_stock(c_tank2))), v_date);
  INSERT INTO bulk_sale (tenant_id, site_id, tank_id, product_id, customer_id, invoice_no, truck_reg,
                         litres, metered_litres, basis, unit_price, amount, payment_terms, recorded_by, loaded_at)
  SELECT t.tenant_id, t.site_id, t.id, t.product_id, '12000000-0000-4000-8000-000000000002', v.inv, v.reg,
         v.litres, v.litres, 'METER', 4800, v.litres * 4800, 'CASH', c_mgr,
         ((v_date + v.day_offset) + v.at) AT TIME ZONE 'Africa/Kampala'
    FROM tank t, (VALUES ('INV-SM-1', 'UAX 101A', 4000, 0, time '10:00'),
                         ('INV-SM-2', 'UAX 102A', 6000, 1, time '04:30')) v(inv, reg, litres, day_offset, at)
   WHERE t.id = c_tank2;   -- the AGO tank: the seed loads nothing from it, so these are its day
  -- ... and each load's litres out of the tank, as DepotService writes them
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind, litres, signed_litres,
                             unit_cost, unit_price, bulk_sale_id, occurred_at, recorded_by)
  SELECT bs.tenant_id, bs.site_id, bs.tank_id, bs.product_id, 'BULK_OUT', bs.litres, -bs.litres,
         fn_weighted_avg_cost(bs.tank_id), bs.unit_price, bs.id, bs.loaded_at, c_mgr
    FROM bulk_sale bs WHERE bs.invoice_no IN ('INV-SM-1', 'INV-SM-2');
  PERFORM fn_close_depot_day(v_day, c_mgr, jsonb_build_array(
             jsonb_build_object('tank_id', c_tank,  'product_litres', fn_book_stock(c_tank)),
             jsonb_build_object('tank_id', c_tank2, 'product_litres', fn_book_stock(c_tank2) - 40)));
  IF EXISTS (SELECT 1 FROM exception_flag WHERE shift_id = v_day AND code = 'STOCK_VARIANCE') THEN
    RAISE EXCEPTION 'SHIFT MATH: 40 L on the day''s 10,000 L loaded was flagged -- the 04:30 truck was not counted';
  END IF;
END $$;
\i tools/audit/shift_math.sql
ROLLBACK;

\echo '  shift math: a closing dip stamped before the close ran does not move the next variance (710)'
BEGIN;
CREATE TEMP TABLE probe AS
  SELECT t.id, fn_close_variance(t.id, fn_book_stock(t.id), now(), NULL) AS on_time FROM tank t;
SET session_replication_role = replica;
UPDATE dip_reading SET captured_at = captured_at - interval '3 hours' WHERE context = 'SHIFT_CLOSE';
SET session_replication_role = origin;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.code, p.on_time, fn_close_variance(t.id, fn_book_stock(t.id), now(), NULL) AS early
             FROM probe p JOIN tank t ON t.id = p.id LOOP
    IF round(r.early, 3) <> round(r.on_time, 3) THEN
      RAISE EXCEPTION 'SHIFT MATH: tank %: the next variance is % with the dip stamped 3 hours early, % on time',
        r.code, round(r.early, 3), round(r.on_time, 3);
    END IF;
  END LOOP;
END $$;
ROLLBACK;
\echo '  shift math scenario: a handover with tests, own use and a return all recompute'
