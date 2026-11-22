-- =============================================================================
-- FCMS v2 -- seed/demo_day.sql
--
-- A full trading day on top of one_station.sql, so every screen has something
-- real to show the first time you open it.
--
-- Run AFTER one_station.sql.
--
-- What this produces:
--   * a completed DAY shift, closed and balanced, with a small variance
--   * a pump test, an own-use draw, a credit sale and a shop sale inside it
--   * one attendant carrying a genuine shortage
--   * a delivery received against dips
--   * an open NIGHT shift you can close yourself to try the flow
--
-- Dips are given in LITRES, as an operator enters them. The functions still
-- accept millimetres for a station that records the stick, but nothing here
-- depends on a calibration chart any more.
--
-- It goes through the real functions -- fn_open_shift, fn_close_shift -- rather
-- than inserting rows directly. If the invariants are broken, THIS FILE WILL
-- FAIL, which makes it a second integrity test that happens to leave useful
-- data behind.
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- This file opens and closes real shifts, so it cannot simply be re-run:
-- one_live_shift_per_site correctly refuses a second open shift. Rather than
-- failing with a constraint name, say what is going on and stop.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM shift
              WHERE site_id = '0b000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION
      'ALREADY_SEEDED: this station has already traded. To start over:'
      '  dropdb fcms && createdb fcms && ./migrate.sh test'
      '  then re-run both seed files.';
  END IF;
END $guard$;

SELECT set_config('app.tenant_id', '0a000000-0000-4000-8000-000000000001', TRUE);

\set site    '''0b000000-0000-4000-8000-000000000001'''
\set mgr     '''10000000-0000-4000-8000-000000000001'''
\set sup     '''10000000-0000-4000-8000-000000000002'''
\set att1    '''10000000-0000-4000-8000-000000000010'''
\set att2    '''10000000-0000-4000-8000-000000000011'''
\set att3    '''10000000-0000-4000-8000-000000000012'''
\set att4    '''10000000-0000-4000-8000-000000000013'''
\set t_pms   '''0d000000-0000-4000-8000-000000000001'''
\set t_ago   '''0d000000-0000-4000-8000-000000000002'''
\set n1      '''0f000000-0000-4000-8000-000000000001'''
\set n2      '''0f000000-0000-4000-8000-000000000002'''
\set n3      '''0f000000-0000-4000-8000-000000000003'''
\set n4      '''0f000000-0000-4000-8000-000000000004'''

-- ---------------------------------------------------------------------------
-- 1. Open yesterday's day shift.
--
--    Opening dips are chosen to match the commissioning stock in
--    one_station.sql: PMS 12,400 L at 7.9167 L/mm ~ 1,566 mm;
--    AGO 18,900 L at 10.9615 L/mm ~ 1,724 mm.
-- ---------------------------------------------------------------------------
\set day_shift ''
SELECT fn_open_shift(
  :site::uuid, 'DAY', :sup::uuid,
  jsonb_build_array(
    jsonb_build_object('tank_id', :t_pms, 'product_litres', 12397.6, 'water_litres', 0),
    jsonb_build_object('tank_id', :t_ago, 'product_litres', 18897.6, 'water_litres', 0)),
  jsonb_build_array(
    jsonb_build_object('nozzle_id', :n1, 'attendant_id', :att1, 'volume_totalizer', 482350, 'electronic_totalizer', 482350),
    jsonb_build_object('nozzle_id', :n2, 'attendant_id', :att2, 'volume_totalizer', 391870, 'electronic_totalizer', 391870),
    jsonb_build_object('nozzle_id', :n3, 'attendant_id', :att3, 'volume_totalizer', 275940, 'electronic_totalizer', 275940),
    jsonb_build_object('nozzle_id', :n4, 'attendant_id', :att4, 'volume_totalizer', 512610, 'electronic_totalizer', 512610))
) AS day_shift_id \gset

\echo 'Opened day shift'

-- Backdate it so it looks like a real shift rather than one that lasted a second.
UPDATE shift SET opened_at = now() - interval '30 hours',
                 business_date = current_date - 1
 WHERE id = :'day_shift_id';
UPDATE meter_reading SET captured_at = now() - interval '30 hours'
 WHERE shift_id = :'day_shift_id';
UPDATE dip_reading SET captured_at = now() - interval '30 hours'
 WHERE shift_id = :'day_shift_id';
UPDATE nozzle_assignment SET assigned_at = now() - interval '30 hours'
 WHERE shift_id = :'day_shift_id';

-- ---------------------------------------------------------------------------
-- 2. Things that happened during it.
-- ---------------------------------------------------------------------------

-- A pump test: 20 L can, 19.94 L actually out, poured back.
INSERT INTO pump_test (tenant_id, site_id, shift_id, nozzle_id, can_size_litres,
                       measured_litres, returned_to_tank, tested_by, tested_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :n1::uuid, 20, 19.94, TRUE, :sup::uuid, now() - interval '28 hours');

-- Own use through a pump: the company pickup on N3.
INSERT INTO own_use (tenant_id, site_id, shift_id, tank_id, nozzle_id, litres,
                     purpose, reference, authorised_by, recorded_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :t_pms::uuid, :n3::uuid, 45.5, 'COMPANY_VEHICLE', 'UAX 001A',
        :mgr::uuid, now() - interval '26 hours');

-- A bulk draw for the generator: never touched a meter.
INSERT INTO own_use (id, tenant_id, site_id, shift_id, tank_id, nozzle_id, litres,
                     purpose, reference, authorised_by, recorded_at)
VALUES ('20000000-0000-4000-8000-000000000001',
        '0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :t_ago::uuid, NULL, 60, 'GENERATOR', 'Standby genset',
        :mgr::uuid, now() - interval '25 hours');

INSERT INTO bulk_draw (tenant_id, site_id, shift_id, tank_id, own_use_id, litres,
                       reason, authorised_by, drawn_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :t_ago::uuid, '20000000-0000-4000-8000-000000000001', 60,
        'GENERATOR: Standby genset', :mgr::uuid, now() - interval '25 hours');

-- A credit sale to the transporter, on Peter's nozzle (N2, diesel).
INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, vehicle_id,
                         staff_id, nozzle_id, product_id, litres, unit_price,
                         amount, voucher_no, signed_by, recorded_at)
SELECT '0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
       '12000000-0000-4000-8000-000000000002',
       (SELECT id FROM credit_vehicle WHERE plate_no = 'UBK 119Q'),
       :sup::uuid, :n2::uuid, '0c000000-0000-4000-8000-000000000002',
       220, 4990, 220 * 4990, 'V-4471', 'K. Odongo', now() - interval '24 hours';

-- A discount authorised by the manager, given by Moses.
INSERT INTO discount_grant (tenant_id, site_id, shift_id, staff_id, customer_ref,
                            litres, amount, reason, authorised_by, granted_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :att1::uuid, 'Kiboga District Farm', 100, 50000,
        'Agreed fleet rate, 500/= per litre', :mgr::uuid, now() - interval '23 hours');

-- A shop sale: 2 L of Helix and a bottle of water, sold by Alice.
INSERT INTO dry_sale (id, tenant_id, site_id, shift_id, seller_id, receipt_no,
                      total_amount, currency, recorded_by, recorded_at)
VALUES ('21000000-0000-4000-8000-000000000001',
        '0a000000-0000-4000-8000-000000000001', :site::uuid, :'day_shift_id',
        :att3::uuid, 'R-0001', 39500, 'UGX', :sup::uuid, now() - interval '22 hours');

INSERT INTO dry_sale_line (id, tenant_id, sale_id, item_id, qty, unit_price, line_amount)
VALUES ('22000000-0000-4000-8000-000000000001',
        '0a000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
        '11000000-0000-4000-8000-000000000002', 2, 19000, 38000),
       ('22000000-0000-4000-8000-000000000002',
        '0a000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
        '11000000-0000-4000-8000-000000000020', 1, 1500, 1500);

INSERT INTO dry_movement (tenant_id, site_id, item_id, shift_id, kind, qty,
                          signed_qty, unit_price, dry_sale_line_id, recorded_by, occurred_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid,
        '11000000-0000-4000-8000-000000000002', :'day_shift_id', 'SALE_OUT', 2, -2,
        19000, '22000000-0000-4000-8000-000000000001', :sup::uuid, now() - interval '22 hours'),
       ('0a000000-0000-4000-8000-000000000001', :site::uuid,
        '11000000-0000-4000-8000-000000000020', :'day_shift_id', 'SALE_OUT', 1, -1,
        1500, '22000000-0000-4000-8000-000000000002', :sup::uuid, now() - interval '22 hours');

\echo 'Recorded shift activity'

-- ---------------------------------------------------------------------------
-- 3. Close it.
--
-- Meter movements chosen so the arithmetic works out to a small, believable
-- variance rather than a suspiciously perfect zero:
--
--   N1 (PMS)  482350 -> 483170 =  820.00 L, less 19.94 test  =  800.06 sold
--   N2 (AGO)  391870 -> 392590 =  720.00 L                   =  720.00 sold
--   N3 (PMS)  275940 -> 276585.5 = 645.50 L, less 45.5 own use = 600.00 sold
--   N4 (AGO)  512610 -> 513050 =  440.00 L                   =  440.00 sold
--
--   PMS out of tank: 820.00 + 645.50 - 19.94 returned = 1445.56 L
--   AGO out of tank: 720.00 + 440.00 + 60 bulk        = 1220.00 L
--
--   PMS book closing 12400 - 1445.56 = 10954.44 -> 1383.7 mm
--   AGO book closing 18900 - 1220.00 = 17680.00 -> 1613.1 mm
--
-- The closing dips are set deliberately:
--   PMS 1383.1 mm ->  -5 L, -0.36%  -- inside tolerance, a normal night
--   AGO 1611.1 mm -> -20 L, -1.72%  -- BREACHES the 0.5% rule and raises a
--                                    STOCK_VARIANCE exception you can see on
--                                    the dashboard and resolve
--
-- That second one matters: a demo where everything is perfect teaches you
-- nothing about what the system does when it is not.
--
-- Cash: sales are priced at 5180 (PMS) and 4990 (AGO).
--   Moses  (N1) 800.06 x 5180 = 4,144,310.80 -> declares cash, less the discount
--   Peter  (N2) 720.00 x 4990 = 3,592,800.00 -> less the credit sale
--   Alice  (N3) 600.00 x 5180 = 3,108,000.00 -> plus her shop sale
--   John   (N4) 440.00 x 4990 = 2,195,600.00 -> 40,000 genuinely short
-- ---------------------------------------------------------------------------
-- The closing dips include the 4,000 L of each product the depot seed moves
-- into these tanks during the day. Written before that transfer existed, they
-- were 4,000 L light, so every close after this one reported a 4,000 L hole
-- and the dashboard filled with stock-variance exceptions on fresh demo data.
-- Cash drops (580/590). Nobody carries a day's takings to close: each
-- attendant drops cash in the safe about every hour, witnessed by the
-- supervisor -- eleven drops each -- and hands in only the rest at close.
--   Moses  11 x 340,000 -> holds 354,310.80 at close
--   Peter  11 x 200,000 -> holds 295,000.00
--   Alice  11 x 250,000 -> holds 250,000.00
--   John   11 x 170,000 -> holds 285,600.00 (still 40,000 short)
SELECT fn_record_cash_drop(:'day_shift_id'::uuid, d.att, d.amount, :sup::uuid,
                           'DB p.12 l.' || (row_number() OVER (ORDER BY k.k, d.n)), :sup::uuid)
  FROM generate_series(1, 11) AS k(k),
       (VALUES (:att1::uuid, 340000::numeric, 1), (:att2::uuid, 200000, 2),
               (:att3::uuid, 250000, 3), (:att4::uuid, 170000, 4)) AS d(att, amount, n)
 ORDER BY k.k, d.n;
-- Drops take the server's clock, and the demo day happened yesterday: spread
-- them evenly from the start of the shift to now (the close). A seed may move
-- them, as superuser with the rules paused; the app never can.
SET session_replication_role = replica;
UPDATE cash_drop cd
   SET dropped_at = sh.opened_at + (now() - sh.opened_at) * ((cd.seq_no + 3) / 4) / 12.0
  FROM shift sh
 WHERE sh.id = cd.shift_id AND cd.shift_id = :'day_shift_id';
SET session_replication_role = DEFAULT;

SELECT fn_close_shift(
  :'day_shift_id'::uuid, :sup::uuid, 'SCHEDULED',
  (SELECT jsonb_agg(jsonb_build_object(
            'assignment_id', na.id,
            'volume_totalizer',
              CASE n.code WHEN 'N1' THEN 483170 WHEN 'N2' THEN 392590
                          WHEN 'N3' THEN 276585.5 ELSE 513050 END, 'electronic_totalizer',
              CASE n.code WHEN 'N1' THEN 483170 WHEN 'N2' THEN 392590
                          WHEN 'N3' THEN 276585.5 ELSE 513050 END,
            'is_rollover', false))
     FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
    WHERE na.shift_id = :'day_shift_id' AND na.state = 'ACTIVE'),
  jsonb_build_array(
    jsonb_build_object('tank_id', :t_pms, 'product_litres', 14949.6, 'water_litres', 0),
    jsonb_build_object('tank_id', :t_ago, 'product_litres', 21660.1, 'water_litres', 0)),
  jsonb_build_array(
    jsonb_build_object('attendant_id', :att1,
      'cash', 354310.80,
      'tenders', jsonb_build_array()),
    jsonb_build_object('attendant_id', :att2,
      'cash', 295000.00,
      'tenders', jsonb_build_array(jsonb_build_object(
        'channel_code', 'MTN_MOMO', 'amount', 0, 'reference', NULL))),
    jsonb_build_object('attendant_id', :att3,
      'cash', 250000.00,
      'tenders', jsonb_build_array(jsonb_build_object(
        'channel_code', 'MTN_MOMO', 'amount', 147500, 'reference', 'MP240815.1423'))),
    jsonb_build_object('attendant_id', :att4,
      'cash', 285600.00,
      'tenders', jsonb_build_array(),
      'shortage_reason', 'Counted three times with the supervisor, still short'))
) AS close_result \gset

\echo 'Closed the day shift'

UPDATE shift SET closed_at = now() - interval '18 hours' WHERE id = :'day_shift_id';

-- A manager signs it off. Not the supervisor who closed it -- the schema refuses
-- that, and so should the demo data.
UPDATE shift SET state = 'APPROVED', approved_by = :mgr::uuid, approved_at = now() - interval '17 hours'
 WHERE id = :'day_shift_id';

-- ---------------------------------------------------------------------------
-- 4. A delivery arrived overnight.
-- ---------------------------------------------------------------------------
INSERT INTO delivery (id, tenant_id, site_id, supplier_id, delivery_note_no,
                      truck_reg, transporter, driver_name, seal_numbers,
                      status, arrived_at, decant_ended_at)
SELECT '23000000-0000-4000-8000-000000000001',
       '0a000000-0000-4000-8000-000000000001', :site::uuid,
       (SELECT id FROM supplier WHERE code = 'VIVO'),
       'DN-88213', 'UAP 774T', 'Kalungi Haulage', 'Ronald Ssebugwawo',
       ARRAY['S-4471','S-4472'], 'ARRIVED',
       now() - interval '10 hours', now() - interval '9 hours';

INSERT INTO delivery_line (tenant_id, delivery_id, tank_id, product_id,
                           loaded_litres, unit_cost)
VALUES ('0a000000-0000-4000-8000-000000000001',
        '23000000-0000-4000-8000-000000000001', :t_pms::uuid,
        -- 4,000 L: it must FIT. T1 holds 20,000 L (19,000 safe) and the depot
        -- moves 4,000 L in first; 9,000 L could never be received, and the
        -- database rightly refused the overfill.
        '0c000000-0000-4000-8000-000000000001', 4000, 4735);

\echo 'Logged a delivery (not yet received -- receive it in the app to try the flow)'

-- ---------------------------------------------------------------------------
-- 5. Tonight's shift, left open for you.
-- ---------------------------------------------------------------------------
SELECT fn_open_shift(
  :site::uuid, 'NIGHT', :sup::uuid,
  jsonb_build_array(
    jsonb_build_object('tank_id', :t_pms, 'product_litres', 14949.6, 'water_litres', 0),
    jsonb_build_object('tank_id', :t_ago, 'product_litres', 21660.1, 'water_litres', 0)),
  jsonb_build_array(
    jsonb_build_object('nozzle_id', :n1, 'attendant_id', :att4),
    jsonb_build_object('nozzle_id', :n2, 'attendant_id', :att3),
    jsonb_build_object('nozzle_id', :n3, 'attendant_id', :att2),
    jsonb_build_object('nozzle_id', :n4, 'attendant_id', :att1))
) AS night_shift_id \gset

UPDATE shift SET opened_at = now() - interval '4 hours' WHERE id = :'night_shift_id';
-- The nozzles were taken over when the shift opened, too. Left at "now", a
-- close soon after seeding saw 400 L pumped in under a minute and refused it
-- as physically impossible (METER_IMPLAUSIBLE).
UPDATE nozzle_assignment SET assigned_at = now() - interval '4 hours' WHERE shift_id = :'night_shift_id';
UPDATE meter_reading SET captured_at = now() - interval '4 hours'
 WHERE shift_id = :'night_shift_id' AND is_opening;

-- Some cash has been banked, some has not -- so the banking screen has a gap
-- worth looking at rather than a tidy zero.
INSERT INTO banking (tenant_id, site_id, business_date, amount, currency,
                     bank_name, slip_no, banked_by, banked_at)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid, current_date - 1,
        11000000, 'UGX', 'Stanbic Kiboga', 'DEP-77120', :mgr::uuid,
        now() - interval '12 hours');

-- A price change waiting to be executed, so the price-break flow has something
-- real to run against.
INSERT INTO price_change (tenant_id, site_id, product_id, old_price, new_price,
                          effective_from, source, directive_ref, status, authorised_by)
VALUES ('0a000000-0000-4000-8000-000000000001', :site::uuid,
        '0c000000-0000-4000-8000-000000000001', 5180, 5240,
        now(), 'OMC_DIRECTIVE', 'VIVO/PR/2026-08', 'PENDING', :mgr::uuid);

COMMIT;

\echo ''
\echo '================================================================'
\echo 'Demo data loaded.'
\echo ''
\echo '  * Yesterday''s DAY shift: closed, approved, one attendant short'
\echo '  * Tonight''s NIGHT shift: OPEN -- close it yourself to try the flow'
\echo '  * A delivery waiting to be received against dips'
\echo '  * A PMS price rise pending -- close on "Price change" to execute it'
\echo '  * Cash collected but not fully banked'
\echo ''
\echo 'Sign in as SUP01 or MGR01, password ChangeMe123!'
\echo '================================================================'
