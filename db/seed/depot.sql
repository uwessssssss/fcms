-- =============================================================================
-- FCMS v2 -- seed/depot.sql
--
-- Kiboga Depot, alongside the station.
--
-- Run AFTER one_station.sql. demo_day.sql is optional and independent.
--
-- The shape here follows a real operation: the depot holds far more stock than
-- the station, sells whole loads on credit against truck registrations, and
-- periodically moves fuel across the yard into the station's tanks. Its margin
-- per litre is a fraction of the station's -- sometimes negative -- and it is
-- the debtor book, not the fuel, that carries the risk.
-- =============================================================================

\set QUIET on
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM site WHERE code = 'KIB-DEP') THEN
    RAISE EXCEPTION
      'ALREADY_SEEDED: the depot already exists. To start over:  '
      'dropdb fcms && createdb fcms && ./migrate.sh test  '
      'then re-run the seed files in order.';
  END IF;
END $guard$;

DO $q$ BEGIN
  PERFORM set_config('app.tenant_id','0a000000-0000-4000-8000-000000000001', TRUE);
END $q$;

-- ---------------------------------------------------------------------------
-- The depot is a second site under the same tenant.
-- ---------------------------------------------------------------------------
INSERT INTO site (id, tenant_id, code, name, kind, ownership, timezone, day_starts_at)
VALUES ('0b000000-0000-4000-8000-000000000002',
        '0a000000-0000-4000-8000-000000000001',
        'KIB-DEP', 'Kiboga Depot', 'DEPOT', 'DODO', 'Africa/Kampala', '06:00');

-- Depot tanks are an order of magnitude larger than the station's. That is the
-- whole point of a depot, and it is why a small per-litre error there costs
-- more than a large one on the forecourt.
INSERT INTO tank (id, tenant_id, site_id, product_id, code,
                  nominal_litres, safe_fill, dead_stock, max_dip_mm, commissioned_on) VALUES
  ('0d000000-0000-4000-8000-00000000d001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000002','0c000000-0000-4000-8000-000000000001',
   'D1-PMS', 120000, 114000, 1500, 3200,'2019-03-01'),
  ('0d000000-0000-4000-8000-00000000d002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000002','0c000000-0000-4000-8000-000000000002',
   'D2-AGO', 150000, 142500, 1800, 3400,'2019-03-01');

-- Placeholder charts, as at the station. Replace from the certificates.
INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT '0a000000-0000-4000-8000-000000000001',
       '0d000000-0000-4000-8000-00000000d001', g*50, round(g*50*35.625, 2)
  FROM generate_series(0, 64) g;

INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT '0a000000-0000-4000-8000-000000000001',
       '0d000000-0000-4000-8000-00000000d002', g*50, round(g*50*41.912, 2)
  FROM generate_series(0, 68) g;

-- ---------------------------------------------------------------------------
-- Wholesale customers. Truck registrations live on the sale, not here, because
-- a haulier sends whichever truck is free.
-- ---------------------------------------------------------------------------
INSERT INTO credit_customer (id, tenant_id, site_id, code, name, contact_phone,
                             credit_limit, payment_terms_days) VALUES
  ('12000000-0000-4000-8000-00000000d001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000002','WHL-01','DEMU Traders Ltd',
   '+256700000201', 90000000, 14),
  ('12000000-0000-4000-8000-00000000d002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000002','WHL-02','Rwenzori Fuels Ltd',
   '+256700000202', 40000000, 30),
  ('12000000-0000-4000-8000-00000000d003','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000002','WHL-03','Save Transporters Ltd',
   '+256700000203', 25000000, 7);

-- ---------------------------------------------------------------------------
-- Opening bulk stock, entering through the ledger like everything else.
--
-- Costs are set deliberately close to the station's pump price. That is not an
-- accident of the fixture: a depot buys at nearly what it sells for, which is
-- exactly why a few shillings of drift turns a month negative.
-- ---------------------------------------------------------------------------
INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                           litres, signed_litres, unit_cost, occurred_at, recorded_by) VALUES
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-00000000d001','0c000000-0000-4000-8000-000000000001',
   'OPENING_BALANCE', 68000, 68000, 5150, now() - interval '3 days',
   '10000000-0000-4000-8000-000000000001'),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-00000000d002','0c000000-0000-4000-8000-000000000002',
   'OPENING_BALANCE', 94000, 94000, 4880, now() - interval '3 days',
   '10000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Two loads out.
--
-- The first is ordinary. The SECOND IS DELIBERATELY BELOW COST -- PMS bought at
-- 5,150 and sold at 5,120 -- because that is a real pattern: a depot can run a
-- whole month at a negative margin without anyone noticing, since the volumes
-- are large and the per-litre gap is small. The system should catch it, and
-- there should be something on the screen to catch.
-- ---------------------------------------------------------------------------
INSERT INTO bulk_sale (id, tenant_id, site_id, tank_id, product_id, customer_id,
                       invoice_no, truck_reg, driver_name, destination,
                       metered_litres, dipped_litres, litres, basis,
                       unit_price, amount, unit_cost, payment_terms,
                       loaded_at, recorded_by)
VALUES
  ('0e000000-0000-4000-8000-0000000b5001',
   '0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-00000000d002','0c000000-0000-4000-8000-000000000002',
   '12000000-0000-4000-8000-00000000d002',
   'INV-2041','UAH 882K','Byaruhanga Peter','Fort Portal',
   18000, 17985, 18000, 'METER',
   4995, 18000 * 4995, 4880, 'CREDIT',
   now() - interval '2 days', '10000000-0000-4000-8000-000000000002'),

  ('0e000000-0000-4000-8000-0000000b5002',
   '0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-00000000d001','0c000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-00000000d001',
   'INV-2042','UBJ 447M','Otim Charles','Hoima',
   22000, 21940, 22000, 'METER',
   5120, 22000 * 5120, 5150, 'CREDIT',
   now() - interval '1 day', '10000000-0000-4000-8000-000000000002');

INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                           litres, signed_litres, unit_cost, unit_price,
                           bulk_sale_id, occurred_at, recorded_by)
SELECT bs.tenant_id, bs.site_id, bs.tank_id, bs.product_id, 'BULK_OUT',
       bs.litres, -bs.litres, bs.unit_cost, bs.unit_price,
       bs.id, bs.loaded_at, bs.recorded_by
  FROM bulk_sale bs;

-- The below-cost load raises its own exception, exactly as the service does.
DO $flag$
BEGIN
  PERFORM fn_raise_flag(
    '0a000000-0000-4000-8000-000000000001',
    '0b000000-0000-4000-8000-000000000002', NULL,
    'bulk_sale', '0e000000-0000-4000-8000-0000000b5002',
    'SOLD_BELOW_COST', 'CRITICAL',
    jsonb_build_object('invoice','INV-2042','truck','UBJ 447M',
                       'litres', 22000, 'price', 5120, 'cost', 5150,
                       'loss', 30 * 22000));
END $flag$;

-- One payment, so the debtor book ages rather than sitting at a flat balance.
INSERT INTO credit_payment (tenant_id, customer_id, amount, method, reference,
                            received_by, received_at)
VALUES ('0a000000-0000-4000-8000-000000000001',
        '12000000-0000-4000-8000-00000000d002', 40000000, 'BANK','RTGS-88213',
        '10000000-0000-4000-8000-000000000004', now() - interval '12 hours');

-- ---------------------------------------------------------------------------
-- A transfer across the yard, through the real function so both halves and the
-- costing are exercised rather than hand-written.
-- ---------------------------------------------------------------------------
DO $move$
BEGIN
  -- depot PMS -> station PMS
  PERFORM fn_transfer_stock('TRF-0001',
    '0d000000-0000-4000-8000-00000000d001',
    '0d000000-0000-4000-8000-000000000001',
    4000, '10000000-0000-4000-8000-000000000001', 'UAX 001A');

  -- depot AGO -> station AGO
  PERFORM fn_transfer_stock('TRF-0002',
    '0d000000-0000-4000-8000-00000000d002',
    '0d000000-0000-4000-8000-000000000002',
    4000, '10000000-0000-4000-8000-000000000001', 'UAX 001A');
END $move$;

COMMIT;

\echo ''
\echo '================================================================'
\echo 'Kiboga Depot seeded.'
\echo ''
\echo '  * 2 bulk tanks: 68,000 L PMS and 94,000 L AGO'
\echo '  * 3 wholesale customers on credit'
\echo '  * 2 loads out -- INV-2042 is DELIBERATELY below cost, and is'
\echo '    flagged, so the exception screen has something real to show'
\echo '  * 4,000 L of each product moved to the station at cost'
\echo ''
\echo 'Open Depot in the app to see loads, transfers, and the'
\echo 'depot-versus-station margin side by side.'
\echo '================================================================'
