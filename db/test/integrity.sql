-- =============================================================================
-- FCMS v2 -- test/integrity.sql
--
-- These tests try to BREAK the system. Every one of them attempts something a
-- dishonest or careless station would do, and passes only when the database
-- REFUSES it.
--
-- That direction matters. A test that closes a clean shift and checks the total
-- proves the happy path works. It proves nothing about whether an unaccounted
-- litre can be committed -- and the unaccounted litre is the whole product.
--
-- Run:  psql -v ON_ERROR_STOP=1 -f test/integrity.sql
-- A failure here means the schema does not enforce what it claims. Do not
-- deploy past a red run.
-- =============================================================================

\set QUIET on
\set ON_ERROR_STOP on
-- Never page: a run that stops halfway for a keypress is a run nobody finishes.
\pset pager off
-- Each test call returns void. Without this, every one prints a four-line
-- empty table and the summary scrolls off the top.
\pset tuples_only on
\pset format unaligned

BEGIN;

CREATE TEMP TABLE test_result (
  id serial, name text, expected text, passed boolean, detail text);

-- Assert that a statement RAISES. If it succeeds, the invariant is not real.
CREATE OR REPLACE FUNCTION test_refuses(p_name text, p_sql text, p_expect text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    -- Force deferred constraint triggers to fire now rather than at COMMIT.
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO test_result (name, expected, passed, detail)
    VALUES (p_name, 'refused', FALSE, 'STATEMENT WAS ACCEPTED -- invariant not enforced');
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    INSERT INTO test_result (name, expected, passed, detail)
    VALUES (p_name, 'refused',
            p_expect IS NULL OR position(p_expect in v_msg) > 0,
            left(v_msg, 120));
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

CREATE OR REPLACE FUNCTION test_allows(p_name text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO test_result (name, expected, passed, detail)
    VALUES (p_name, 'accepted', TRUE, '');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO test_result (name, expected, passed, detail)
    VALUES (p_name, 'accepted', FALSE, left(SQLERRM, 120));
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------------------------------------------------------------------------
-- Fixture: one station, one tank, one pump, one nozzle, one shift.
-- ---------------------------------------------------------------------------
INSERT INTO tenant (id, name, country_code, base_currency)
VALUES ('11111111-1111-1111-1111-111111111111','Test Dealer','UG','UGX');
INSERT INTO tenant_policy (tenant_id) VALUES ('11111111-1111-1111-1111-111111111111');
DO $q$ BEGIN PERFORM set_config('app.tenant_id','11111111-1111-1111-1111-111111111111', TRUE); END $q$;

INSERT INTO site (id, tenant_id, code, name)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111','KIB','Kiboga');

INSERT INTO product (id, tenant_id, code, name)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111','PMS','Petrol');

INSERT INTO tank (id, tenant_id, site_id, product_id, code,
                  nominal_litres, safe_fill, max_dip_mm)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333','T1', 20000, 19000, 2400);

INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT '11111111-1111-1111-1111-111111111111',
       '44444444-4444-4444-4444-444444444444',
       g * 100, g * 100 * 8.0
  FROM generate_series(0, 24) g;

INSERT INTO pump (id, tenant_id, site_id, code)
VALUES ('55555555-5555-5555-5555-555555555555',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','P1');

INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code)
VALUES ('66666666-6666-6666-6666-666666666666',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '55555555-5555-5555-5555-555555555555',
        '44444444-4444-4444-4444-444444444444','N1');

INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
  ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','SUP01','Grace Supervisor','SUPERVISOR'),
  ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','ATT01','Moses Attendant','ATTENDANT'),
  ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','MGR01','Sarah Manager','MANAGER');

INSERT INTO price_change (tenant_id, site_id, product_id, new_price,
                          effective_from, source, status, authorised_by,
                          no_shift_to_break, executed_at)
VALUES ('11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333', 5000,
        now() - interval '1 day','DEALER','EXECUTED',
        '99999999-9999-9999-9999-999999999999', TRUE, now() - interval '1 day');

INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment,
                   state, opened_at, opened_by)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        CURRENT_DATE,'DAY',1,'OPEN', now() - interval '8 hours',
        '77777777-7777-7777-7777-777777777777');

DO $q$ BEGIN PERFORM fn_capture_shift_prices('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); END $q$;

INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id,
                               attendant_id, assigned_by, assigned_at)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '66666666-6666-6666-6666-666666666666',
        '88888888-8888-8888-8888-888888888888',
        '77777777-7777-7777-7777-777777777777', now() - interval '8 hours');

INSERT INTO meter_reading (id, tenant_id, site_id, nozzle_id, shift_id,
  assignment_id, is_opening, source, volume_totalizer, recorded_by, captured_at)
OVERRIDING SYSTEM VALUE
VALUES (1,'11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '66666666-6666-6666-6666-666666666666',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', TRUE,'MANUAL', 100000,
        '77777777-7777-7777-7777-777777777777', now() - interval '8 hours');

INSERT INTO meter_reading (id, tenant_id, site_id, nozzle_id, shift_id,
  assignment_id, is_opening, source, volume_totalizer, recorded_by, captured_at)
OVERRIDING SYSTEM VALUE
VALUES (2,'11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '66666666-6666-6666-6666-666666666666',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', FALSE,'MANUAL', 101000,
        '77777777-7777-7777-7777-777777777777', now());

SET CONSTRAINTS ALL DEFERRED;

-- =============================================================================
-- I2 -- EVERY DROP THROUGH A METER IS ACCOUNTED FOR
-- =============================================================================

-- 1000 L dispensed, only 900 classified. The missing 100 L is the whole point.
SELECT test_refuses('unaccounted litres cannot commit', $sql$
  INSERT INTO meter_event (id, tenant_id, site_id, shift_id, assignment_id,
    nozzle_id, tank_id, opening_reading_id, closing_reading_id, gross_litres)
  OVERRIDING SYSTEM VALUE
  VALUES (900,'11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','66666666-6666-6666-6666-666666666666',
    '44444444-4444-4444-4444-444444444444', 1, 2, 1000);
  INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, unit_price)
  VALUES ('11111111-1111-1111-1111-111111111111', 900,'SALE', 900, 5000);
$sql$, 'UNACCOUNTED_FUEL');

-- A meter event with no classification at all.
SELECT test_refuses('meter event with no disposition cannot commit', $sql$
  INSERT INTO meter_event (id, tenant_id, site_id, shift_id, assignment_id,
    nozzle_id, tank_id, opening_reading_id, closing_reading_id, gross_litres)
  OVERRIDING SYSTEM VALUE
  VALUES (901,'11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','66666666-6666-6666-6666-666666666666',
    '44444444-4444-4444-4444-444444444444', 1, 2, 1000);
$sql$, 'UNACCOUNTED_FUEL');

-- The same volume, fully classified across all three kinds, must be accepted.
SELECT test_allows('fully classified meter event commits', $sql$
  INSERT INTO meter_event (id, tenant_id, site_id, shift_id, assignment_id,
    nozzle_id, tank_id, opening_reading_id, closing_reading_id, gross_litres)
  OVERRIDING SYSTEM VALUE
  VALUES (902,'11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','66666666-6666-6666-6666-666666666666',
    '44444444-4444-4444-4444-444444444444', 1, 2, 1000);
  INSERT INTO pump_test (id, tenant_id, site_id, shift_id, nozzle_id,
    can_size_litres, measured_litres, returned_to_tank, tested_by)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','66666666-6666-6666-6666-666666666666',
    20, 19.94, TRUE, '77777777-7777-7777-7777-777777777777');
  INSERT INTO own_use (id, tenant_id, site_id, shift_id, tank_id, nozzle_id,
    litres, purpose, authorised_by)
  VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd',
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','44444444-4444-4444-4444-444444444444',
    '66666666-6666-6666-6666-666666666666', 30.06,'GENERATOR',
    '99999999-9999-9999-9999-999999999999');
  INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, unit_price)
  VALUES ('11111111-1111-1111-1111-111111111111', 902,'SALE', 950, 5000);
  INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, pump_test_id)
  VALUES ('11111111-1111-1111-1111-111111111111', 902,'PUMP_TEST', 19.94,
    'cccccccc-cccc-cccc-cccc-cccccccccccc');
  INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, own_use_id)
  VALUES ('11111111-1111-1111-1111-111111111111', 902,'OWN_USE', 30.06,
    'dddddddd-dddd-dddd-dddd-dddddddddddd');
$sql$);

-- =============================================================================
-- I1 -- THE FUEL LEDGER
-- =============================================================================

SELECT test_refuses('a delivery cannot be entered as negative litres', $sql$
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
    litres, signed_litres, delivery_line_id, occurred_at, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333','DELIVERY_IN', 5000, -5000,
    gen_random_uuid(), now(), '77777777-7777-7777-7777-777777777777');
$sql$, 'movement_sign_correct');

SELECT test_refuses('a movement with no source document is refused', $sql$
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
    litres, signed_litres, occurred_at, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333','METER_OUT', 500, -500,
    now(), '77777777-7777-7777-7777-777777777777');
$sql$, 'movement_has_exactly_one_source');

SELECT test_refuses('the ledger cannot be edited', $sql$
  UPDATE fuel_movement SET litres = 1 WHERE TRUE;
  DO $do$ BEGIN
    IF (SELECT count(*) FROM fuel_movement WHERE litres = 1) > 0
    THEN RAISE EXCEPTION 'ledger was mutated'; END IF;
    RAISE EXCEPTION 'APPEND_ONLY held (update silently discarded)';
  END $do$;
$sql$, 'APPEND_ONLY');

SELECT test_refuses('a dip above the calibration chart is refused', $sql$
  SELECT fn_dip_to_litres('44444444-4444-4444-4444-444444444444', 9999);
$sql$, 'DIP_ABOVE_CHART');

SELECT test_refuses('a meter running backwards without rollover is refused', $sql$
  SELECT fn_meter_delta('66666666-6666-6666-6666-666666666666', 500000, 100, FALSE);
$sql$, 'METER_ROLLBACK');

SELECT test_allows('a genuine 6-digit rollover computes correctly', $sql$
  DO $do$ DECLARE d numeric;
  BEGIN
    d := fn_meter_delta('66666666-6666-6666-6666-666666666666', 999500, 300, TRUE);
    IF d <> 800 THEN RAISE EXCEPTION 'rollover gave %, expected 800', d; END IF;
  END $do$;
$sql$);

SELECT test_refuses('a physically impossible throughput is refused', $sql$
  SELECT fn_meter_delta('66666666-6666-6666-6666-666666666666', 0, 900000, FALSE, 1.0);
$sql$, 'METER_IMPLAUSIBLE');

-- =============================================================================
-- THE CASH-UP MUST BALANCE
-- =============================================================================

INSERT INTO cash_up (id, tenant_id, site_id, shift_id, staff_id, currency,
                     status, declared_by)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '88888888-8888-8888-8888-888888888888','UGX','DRAFT',
        '77777777-7777-7777-7777-777777777777');

-- Sold 4,750,000 worth, handed in 4,000,000, and nothing explains the rest.
SELECT test_refuses('an unallocated shilling cannot close a shift', $sql$
  INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
    entry, amount, currency, meter_event_id, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','88888888-8888-8888-8888-888888888888',
    'SALE', 4750000,'UGX', 902,'77777777-7777-7777-7777-777777777777');
  INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
    entry, settlement, amount, currency, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','88888888-8888-8888-8888-888888888888',
    'SETTLEMENT','CASH', -4000000,'UGX','77777777-7777-7777-7777-777777777777');
  UPDATE cash_up SET status='DECLARED' WHERE id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
$sql$, 'CASH_UP_UNBALANCED');

-- The v1 bug in one test: declaring a shortage used to make the sheet READ as
-- balanced while leaving the money unaccounted. Here the shortage is a real
-- ledger row, so the books balance only because a receivable now exists.
SELECT test_allows('a declared shortage balances the sheet as a receivable', $sql$
  INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
    entry, amount, currency, meter_event_id, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','88888888-8888-8888-8888-888888888888',
    'SALE', 4750000,'UGX', 902,'77777777-7777-7777-7777-777777777777');
  INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
    entry, settlement, amount, currency, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','88888888-8888-8888-8888-888888888888',
    'SETTLEMENT','CASH', -4000000,'UGX','77777777-7777-7777-7777-777777777777');
  INSERT INTO staff_shortage (id, tenant_id, site_id, staff_id, shift_id,
    cash_up_id, amount, currency, reason)
  VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff',
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    '88888888-8888-8888-8888-888888888888','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 750000,'UGX','Counted twice, still short');
  INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
    entry, settlement, amount, currency, shortage_id, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','88888888-8888-8888-8888-888888888888',
    'SETTLEMENT','SHORTAGE', -750000,'UGX',
    'ffffffff-ffff-ffff-ffff-ffffffffffff','77777777-7777-7777-7777-777777777777');
  -- !! THIS COMMITS. test_allows does not roll back, deliberately: the shortage
  -- !! has to survive for the tests below it.
  -- !!
  -- !! So cash-up eeee... is DECLARED from here to the end of the file. Any
  -- !! later test that needs it in another state must SET THAT STATE ITSELF.
  -- !! The draft-rebuild test did not, and a correct schema reported a failing
  -- !! invariant for three runs while I looked for a bug that was not there.
  UPDATE cash_up SET status='DECLARED' WHERE id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
$sql$);

-- Charging the same shortage twice was audit finding C3.
SELECT test_refuses('the same shortage cannot be raised twice', $sql$
  INSERT INTO staff_shortage (tenant_id, site_id, staff_id, shift_id, cash_up_id,
    amount, currency, reason)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','88888888-8888-8888-8888-888888888888',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    750000,'UGX','duplicate run');
$sql$, 'duplicate key');

SELECT test_refuses('wages cannot be docked without a signed acknowledgement', $sql$
  INSERT INTO shortage_recovery (tenant_id, staff_id, shortage_id, amount,
    method, acknowledged, approved_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '88888888-8888-8888-8888-888888888888','ffffffff-ffff-ffff-ffff-ffffffffffff',
    750000,'SALARY_DEDUCTION', FALSE,'99999999-9999-9999-9999-999999999999');
$sql$, 'salary_needs_acknowledgement');

-- =============================================================================
-- ATTENDANTS DO NOT SIGN IN, AND DO NOT AUTHOR RECORDS
-- =============================================================================

SELECT test_refuses('an attendant cannot hold credentials', $sql$
  INSERT INTO staff_credential (staff_id, password_hash)
  VALUES ('88888888-8888-8888-8888-888888888888','$2a$12$fake');
$sql$);

-- Move the identity sequence past the hand-assigned fixture ids, so this
-- reaches the constraint under test instead of colliding on the primary key.
DO $q$ BEGIN PERFORM setval(pg_get_serial_sequence('meter_reading','id'), 1000); END $q$;

-- A fresh pump, nozzle and assignment, so the partial unique indexes on
-- opening/closing readings cannot fire either. What is left is the composite
-- foreign key to staff(id, is_operator) - the thing this test is named after.
INSERT INTO pump (id, tenant_id, site_id, code)
VALUES ('aa000000-0000-4000-8000-00000000aa01',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','P9');

INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code)
VALUES ('aa000000-0000-4000-8000-00000000aa02',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'aa000000-0000-4000-8000-00000000aa01',
        '44444444-4444-4444-4444-444444444444','N9');

INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id,
                               attendant_id, assigned_by)
VALUES ('aa000000-0000-4000-8000-00000000aa03',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'aa000000-0000-4000-8000-00000000aa02',
        '88888888-8888-8888-8888-888888888888',
        '77777777-7777-7777-7777-777777777777');

SELECT test_refuses('an attendant cannot author a meter reading', $sql$
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id,
    assignment_id, is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aa000000-0000-4000-8000-00000000aa02',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aa000000-0000-4000-8000-00000000aa03',
    TRUE,'MANUAL', 100,'88888888-8888-8888-8888-888888888888', now());
$sql$, 'is_operator');

-- And the same insert by a supervisor must be ACCEPTED, or the test above
-- would pass even if the table were simply broken.
SELECT test_allows('a supervisor CAN author a meter reading', $sql$
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id,
    assignment_id, is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aa000000-0000-4000-8000-00000000aa02',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aa000000-0000-4000-8000-00000000aa03',
    TRUE,'MANUAL', 100,'77777777-7777-7777-7777-777777777777', now());
$sql$);

SELECT test_refuses('a supervisor cannot be rostered onto a nozzle', $sql$
  INSERT INTO nozzle_assignment (tenant_id, site_id, shift_id, nozzle_id,
    attendant_id, assigned_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '66666666-6666-6666-6666-666666666666','77777777-7777-7777-7777-777777777777',
    '77777777-7777-7777-7777-777777777777');
$sql$, 'NOT_AN_ATTENDANT');

-- =============================================================================
-- SHIFT AND PRICE INVARIANTS
-- =============================================================================

SELECT test_refuses('two shifts cannot be open at one station', $sql$
  INSERT INTO shift (tenant_id, site_id, business_date, label, segment,
                     state, opened_at, opened_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', CURRENT_DATE,'NIGHT',1,'OPEN', now(),
    '77777777-7777-7777-7777-777777777777');
$sql$, 'one_live_shift_per_site');

SELECT test_refuses('two attendants cannot hold one nozzle', $sql$
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role)
  VALUES ('12121212-1212-1212-1212-121212121212',
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'ATT02','Peter Attendant','ATTENDANT');
  INSERT INTO nozzle_assignment (tenant_id, site_id, shift_id, nozzle_id,
    attendant_id, assigned_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '66666666-6666-6666-6666-666666666666','12121212-1212-1212-1212-121212121212',
    '77777777-7777-7777-7777-777777777777');
$sql$, 'one_active_holder_per_nozzle');

SELECT test_refuses('a price change cannot execute without cutting a shift', $sql$
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price,
    effective_from, source, status, authorised_by, executed_at)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
    5200, now(),'OMC_DIRECTIVE','EXECUTED',
    '99999999-9999-9999-9999-999999999999', now());
$sql$, 'executed_change_broke_a_shift');

SELECT test_refuses('a shift cannot close without saying why', $sql$
  UPDATE shift SET state='DECLARED', closed_at=now(),
                   closed_by='77777777-7777-7777-7777-777777777777'
   WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
$sql$, 'closed_needs_reason');

SELECT test_refuses('the person who closes a shift cannot approve it', $sql$
  UPDATE shift SET state='APPROVED', closed_at=now(), closed_reason='SCHEDULED',
                   closed_by='77777777-7777-7777-7777-777777777777',
                   approved_by='77777777-7777-7777-7777-777777777777',
                   approved_at=now()
   WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
$sql$, 'SELF_APPROVAL');

-- =============================================================================
-- DRY STOCK
-- =============================================================================

INSERT INTO dry_item (id, tenant_id, sku, name, category)
VALUES ('13131313-1313-1313-1313-131313131313',
        '11111111-1111-1111-1111-111111111111','HLX-4L','Helix HX5 4L','LUBRICANT');

SELECT test_refuses('you cannot sell dry stock you do not have', $sql$
  INSERT INTO dry_movement (tenant_id, site_id, item_id, kind, qty, signed_qty,
    recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','13131313-1313-1313-1313-131313131313',
    'SALE_OUT', 5, -5,'77777777-7777-7777-7777-777777777777');
$sql$, 'DRY_STOCK_NEGATIVE');

SELECT test_refuses('stock cannot be written off without a reason', $sql$
  INSERT INTO dry_movement (tenant_id, site_id, item_id, kind, qty, signed_qty,
    recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222','13131313-1313-1313-1313-131313131313',
    'DAMAGE_OUT', 2, -2,'77777777-7777-7777-7777-777777777777');
$sql$, 'writeoff_needs_note');

SELECT test_refuses('a receipt total must equal its lines', $sql$
  INSERT INTO dry_sale (id, tenant_id, site_id, shift_id, seller_id,
    total_amount, currency, recorded_by)
  VALUES ('14141414-1414-1414-1414-141414141414',
    '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','88888888-8888-8888-8888-888888888888',
    100000,'UGX','77777777-7777-7777-7777-777777777777');
  INSERT INTO dry_sale_line (tenant_id, sale_id, item_id, qty, unit_price, line_amount)
  VALUES ('11111111-1111-1111-1111-111111111111',
    '14141414-1414-1414-1414-141414141414','13131313-1313-1313-1313-131313131313',
    1, 45000, 45000);
$sql$, 'DRY_SALE_UNBALANCED');

-- =============================================================================
-- THE FORECOURT MODEL
--
-- A pump is a housing. Nozzles carry the tank, product comes from the tank,
-- and nozzles on different pumps routinely share one. Every wet-stock figure
-- in the system rests on those three properties and none of them were tested.
-- =============================================================================

-- Two more pumps and three more nozzles, so one tank is fed from three
-- different housings. That is the ordinary case at a real station, and it is
-- exactly the case a per-pump total gets wrong.
INSERT INTO pump (id, tenant_id, site_id, code) VALUES
  ('55555555-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','P2'),
  ('55555555-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','P3');

INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code) VALUES
  -- a second nozzle on P1, same tank as the first
  ('66666666-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555',
   '44444444-4444-4444-4444-444444444444','N2'),
  -- on P2, same tank again
  ('66666666-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','55555555-0000-4000-8000-000000000002',
   '44444444-4444-4444-4444-444444444444','N3'),
  -- and P3, carrying exactly one
  ('66666666-0000-4000-8000-000000000004','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','55555555-0000-4000-8000-000000000003',
   '44444444-4444-4444-4444-444444444444','N4');

SELECT test_refuses('a pump may carry one nozzle and another may carry two', $sql$
  DO $chk$
  DECLARE v_p1 int; v_p3 int;
  BEGIN
    SELECT count(*) INTO v_p1 FROM nozzle
     WHERE pump_id = '55555555-5555-5555-5555-555555555555';
    SELECT count(*) INTO v_p3 FROM nozzle
     WHERE pump_id = '55555555-0000-4000-8000-000000000003';
    IF v_p1 <> 2 OR v_p3 <> 1 THEN
      RAISE EXCEPTION 'COUNT_CONSTRAINED: P1 has %, P3 has % -- something is '
                      'enforcing a nozzle count that should not exist', v_p1, v_p3;
    END IF;
    RAISE EXCEPTION 'NOZZLE_COUNT_IS_FREE: P1 has %, P3 has %', v_p1, v_p3;
  END $chk$;
$sql$, 'NOZZLE_COUNT_IS_FREE');

SELECT test_refuses('one tank is fed from three different pumps', $sql$
  DO $chk$
  DECLARE v_pumps int;
  BEGIN
    SELECT count(DISTINCT pump_id) INTO v_pumps FROM nozzle
     WHERE tank_id = '44444444-4444-4444-4444-444444444444';
    IF v_pumps < 3 THEN
      RAISE EXCEPTION 'NOT_SHARED: only % pump(s) draw from this tank', v_pumps;
    END IF;
    RAISE EXCEPTION 'TANK_SHARED_ACROSS_PUMPS: % pumps draw from one tank', v_pumps;
  END $chk$;
$sql$, 'TANK_SHARED_ACROSS_PUMPS');

-- The consequence that costs money. If throughput were totalled per pump, this
-- tank would report a fraction of its litres and look entirely reasonable.
SELECT test_refuses('tank throughput counts every pump, not one', $sql$
  DO $chk$
  DECLARE v_by_tank numeric; v_by_one_pump numeric;
  BEGIN
    SELECT COALESCE(SUM(me.gross_litres), 0) INTO v_by_tank
      FROM meter_event me JOIN nozzle n ON n.id = me.nozzle_id
     WHERE n.tank_id = '44444444-4444-4444-4444-444444444444';

    SELECT COALESCE(SUM(me.gross_litres), 0) INTO v_by_one_pump
      FROM meter_event me JOIN nozzle n ON n.id = me.nozzle_id
     WHERE n.pump_id = '55555555-5555-5555-5555-555555555555';

    IF v_by_one_pump > v_by_tank THEN
      RAISE EXCEPTION 'IMPOSSIBLE: one pump cannot exceed the whole tank';
    END IF;
    RAISE EXCEPTION 'BY_TANK_IS_COMPLETE: tank saw %, one pump saw %',
                    v_by_tank, v_by_one_pump;
  END $chk$;
$sql$, 'BY_TANK_IS_COMPLETE');

SELECT test_refuses('a nozzle cannot draw from a tank on another site', $sql$
  INSERT INTO nozzle (tenant_id, site_id, pump_id, tank_id, code)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '55555555-5555-5555-5555-555555555555',
          '44444444-0000-4000-8000-00000000ffff','NX');
$sql$);

-- =============================================================================
-- THE UNRESTRICTED ROLE
--
-- SYSTEM_ADMIN bypasses permissions and must NOT bypass the properties that
-- make the numbers mean anything. That distinction is the entire reason the
-- role is safe to hand to anyone, so it is worth proving rather than asserting.
-- =============================================================================

INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role)
VALUES ('77777777-0000-4000-8000-0000000000ad',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','ADM01','Root Operator','SYSTEM_ADMIN');

SELECT test_refuses('the system administrator holds every permission', $sql$
  DO $chk$
  DECLARE v_missing text[];
  BEGIN
    SELECT array_agg(DISTINCT p.permission) INTO v_missing
      FROM role_permission p
     WHERE NOT EXISTS (SELECT 1 FROM role_permission a
                        WHERE a.role = 'SYSTEM_ADMIN'
                          AND a.permission = p.permission);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ADMIN_INCOMPLETE: missing %', array_to_string(v_missing, ', ');
    END IF;
    RAISE EXCEPTION 'ADMIN_HOLDS_EVERYTHING';
  END $chk$;
$sql$, 'ADMIN_HOLDS_EVERYTHING');

SELECT test_refuses('a permission added later is granted automatically', $sql$
  DO $chk$
  BEGIN
    INSERT INTO role_permission (role, permission)
    VALUES ('MANAGER', 'invented.later.permission');

    IF NOT EXISTS (SELECT 1 FROM role_permission
                    WHERE role = 'SYSTEM_ADMIN'
                      AND permission = 'invented.later.permission') THEN
      RAISE EXCEPTION 'ADMIN_FELL_BEHIND: a new permission was not granted, so '
                      '"can do everything" has quietly become "could, as of '
                      'the day this file was written"';
    END IF;
    RAISE EXCEPTION 'ADMIN_KEPT_UP';
  END $chk$;
$sql$, 'ADMIN_KEPT_UP');

-- The important one. An account that can do anything is acceptable only if it
-- cannot rewrite what is already posted.
SELECT test_refuses('the system administrator cannot edit a posted ledger row', $sql$
  DO $chk$
  DECLARE v_before numeric; v_after numeric;
  BEGIN
    PERFORM set_config('app.staff_id','77777777-0000-4000-8000-0000000000ad', TRUE);

    SELECT signed_litres INTO v_before FROM fuel_movement
     WHERE tank_id = '44444444-4444-4444-4444-444444444444'
     ORDER BY id LIMIT 1;

    UPDATE fuel_movement SET signed_litres = 999999
     WHERE tank_id = '44444444-4444-4444-4444-444444444444';

    SELECT signed_litres INTO v_after FROM fuel_movement
     WHERE tank_id = '44444444-4444-4444-4444-444444444444'
     ORDER BY id LIMIT 1;

    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'ADMIN_REWROTE_THE_LEDGER: % became %, and the audit '
                      'trail is now worthless', v_before, v_after;
    END IF;
    RAISE EXCEPTION 'APPEND_ONLY_HOLDS_FOR_ADMIN_TOO';
  END $chk$;
$sql$, 'APPEND_ONLY_HOLDS_FOR_ADMIN_TOO');

-- =============================================================================
-- SUPERVISOR AND MANAGER
--
-- A manager covers a shift when a supervisor is away. A system that will not
-- let them is a system that gets shared passwords -- so manager is a strict
-- superset. The thing that must NOT follow is the segregation rule.
-- =============================================================================

SELECT test_refuses('a manager can do everything a supervisor can', $sql$
  DO $chk$
  DECLARE v_missing text[];
  BEGIN
    SELECT array_agg(s.permission) INTO v_missing
      FROM role_permission s
     WHERE s.role = 'SUPERVISOR'
       AND NOT EXISTS (SELECT 1 FROM role_permission m
                        WHERE m.role = 'MANAGER' AND m.permission = s.permission);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'MANAGER_NOT_A_SUPERSET: cannot %',
                      array_to_string(v_missing, ', ');
    END IF;
    RAISE EXCEPTION 'MANAGER_COVERS_SUPERVISOR';
  END $chk$;
$sql$, 'MANAGER_COVERS_SUPERVISOR');

SELECT test_refuses('a permission given to a supervisor reaches the manager', $sql$
  DO $chk$
  BEGIN
    INSERT INTO role_permission (role, permission)
    VALUES ('SUPERVISOR', 'invented.forecourt.task');

    IF NOT EXISTS (SELECT 1 FROM role_permission
                    WHERE role = 'MANAGER' AND permission = 'invented.forecourt.task') THEN
      RAISE EXCEPTION 'ROLES_DRIFTED: a supervisor gained a permission the '
                      'manager did not, so a manager covering a shift is now '
                      'blocked from ordinary work';
    END IF;
    RAISE EXCEPTION 'SUPERSET_HELD';
  END $chk$;
$sql$, 'SUPERSET_HELD');

SELECT test_refuses('the manager who takes the cash can bank it', $sql$
  DO $chk$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM role_permission
                    WHERE role = 'MANAGER' AND permission = 'banking.record') THEN
      RAISE EXCEPTION 'MANAGER_CANNOT_BANK: taking cash to the bank is the job';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM role_permission
                    WHERE role = 'MANAGER' AND permission = 'report.view') THEN
      RAISE EXCEPTION 'MANAGER_CANNOT_SEE: overall sight is the job';
    END IF;
    RAISE EXCEPTION 'MANAGER_HAS_THEIR_JOB';
  END $chk$;
$sql$, 'MANAGER_HAS_THEIR_JOB');

-- =============================================================================
-- DIPS IN LITRES
--
-- The chart lookup used to carry a check: a stick reading above the chart was
-- refused as an overfill or a misread. Entering litres loses that, so a trigger
-- replaces it -- and the replacement is worth proving, because losing a guard
-- silently is how a tank ends up recorded holding more than it can hold.
-- =============================================================================

SELECT test_refuses('a dip larger than the tank is refused', $sql$
  INSERT INTO dip_reading (tenant_id, site_id, tank_id, context,
                           gross_litres, water_litres, product_litres,
                           recorded_by, captured_at)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '44444444-4444-4444-4444-444444444444', 'SPOT_CHECK',
          9999999, 0, 9999999,
          '77777777-7777-7777-7777-777777777777', now());
$sql$, 'DIP_ABOVE_CAPACITY');

SELECT test_refuses('litres win when both litres and millimetres are given', $sql$
  DO $chk$
  DECLARE v numeric;
  BEGIN
    -- A station that records the stick too must not have its stick reading
    -- silently override the volume the operator actually entered.
    v := fn_dip_litres('44444444-4444-4444-4444-444444444444',
                       jsonb_build_object('product_litres', 5000, 'dip_mm', 1));
    IF v <> 5000 THEN
      RAISE EXCEPTION 'MM_OVERRODE_LITRES: got % instead of 5000', v;
    END IF;
    RAISE EXCEPTION 'LITRES_WIN';
  END $chk$;
$sql$, 'LITRES_WIN');

SELECT test_refuses('a dip with neither litres nor millimetres is refused', $sql$
  SELECT fn_dip_litres('44444444-4444-4444-4444-444444444444',
                       jsonb_build_object('tank_id', 'x'));
$sql$, 'DIP_MISSING');

-- A credit customer, for the limit tests below. There was none in this fixture
-- at all, which is why the first version of these tests would have failed for
-- the wrong reason -- it reached for a UUID that turned out to be a nozzle
-- assignment.
INSERT INTO credit_customer (id, tenant_id, site_id, code, name, credit_limit,
                             payment_terms_days, is_active)
VALUES ('cc000000-0000-4000-8000-000000000001',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'TEST-01','Test Haulage Ltd', 500000, 30, TRUE);

-- =============================================================================
-- THE CREDIT LIMIT UNDER TWO SALES AT ONCE
--
-- A single transaction cannot demonstrate a race, so this proves the mechanism
-- instead: the headroom read takes a row lock on the customer, and the limit is
-- enforced against a balance that includes everything already committed.
-- =============================================================================

SELECT test_refuses('the headroom read locks the customer row', $sql$
  DO $chk$
  DECLARE v_locked int;
  BEGIN
    PERFORM * FROM fn_customer_headroom('cc000000-0000-4000-8000-000000000001');

    -- pg_locks now holds a row lock taken by this transaction. Without it, two
    -- simultaneous sales both read the balance before either insert and both
    -- pass a limit only one of them should have.
    SELECT count(*) INTO v_locked
      FROM pg_locks
     WHERE locktype = 'transactionid' AND pid = pg_backend_pid() AND granted;

    IF v_locked = 0 THEN
      RAISE EXCEPTION 'NO_LOCK_TAKEN: the headroom was read without locking the '
                      'customer, so two sales can both pass the limit';
    END IF;
    RAISE EXCEPTION 'HEADROOM_READ_UNDER_LOCK';
  END $chk$;
$sql$, 'HEADROOM_READ_UNDER_LOCK');

SELECT test_refuses('an unknown customer is refused, not treated as unlimited', $sql$
  SELECT * FROM fn_customer_headroom('00000000-0000-4000-8000-00000000dead');
$sql$, 'CUSTOMER_NOT_FOUND');

-- =============================================================================
-- TENANT ISOLATION
-- =============================================================================

-- A REAL second tenant, so the write below is rejected by policy rather than
-- by a foreign key to a tenant that does not exist.
INSERT INTO tenant (id, name, country_code, base_currency)
VALUES ('99999999-0000-4000-8000-000000000002','Rival Dealer','UG','UGX');
INSERT INTO tenant_policy (tenant_id) VALUES ('99999999-0000-4000-8000-000000000002');
INSERT INTO site (id, tenant_id, code, name)
VALUES ('99999999-0000-4000-8000-000000000003',
        '99999999-0000-4000-8000-000000000002','RIV','Rival station');

GRANT USAGE ON SCHEMA public TO fcms_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fcms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fcms_app;

-- test_result is a TEMP table created at the top of this file, long before
-- fcms_app existed in the picture. Without these grants the helper cannot
-- record its own findings and the run dies with "permission denied" - which
-- looks alarming and means nothing about the schema.
--
-- Note the SEQUENCE as well as the table: test_result.id is a serial, and a
-- table grant alone is not enough to insert into it. Resolved by name lookup
-- rather than hardcoded, since a temp sequence's name is not guaranteed.
GRANT INSERT, SELECT ON test_result TO fcms_app;
DO $g$
BEGIN
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO fcms_app',
                 pg_get_serial_sequence('test_result', 'id'));
END $g$;

-- The helpers must stay SECURITY INVOKER. Making them DEFINER would silence
-- these grant problems, but it would also run every test body as postgres -
-- and a superuser bypasses RLS, so the three tenant-isolation tests below
-- would pass while proving nothing at all.

-- RLS does not apply to a superuser. The suite runs as postgres, so every
-- tenant-isolation assertion made as postgres is worthless. Become fcms_app,
-- which is the role the application actually connects as.
SET LOCAL ROLE fcms_app;

-- Everything below runs as fcms_app, NOT as postgres.
--
-- The delete-policy tests were originally placed above this line, and they
-- were worthless there: a superuser bypasses row-level security entirely, so
-- the "draft may be rebuilt" test passed because a superuser can delete
-- anything, and the "declared is permanent" test FAILED because the
-- restrictive policy was never consulted.
--
-- The comment fifteen lines above says exactly this about the tenant tests. I
-- wrote that comment and then made the same mistake again with new tests.

-- =============================================================================
-- REBUILDING A DRAFT CASH-UP
--
-- The close deletes a draft cash-up's money movements and writes them again, so
-- that recomputing is idempotent rather than additive. That needs DELETE, which
-- is revoked everywhere on purpose -- so a RESTRICTIVE policy narrows it to
-- draft rows only.
--
-- Both halves are worth proving: the rebuild works, and a declared cash-up can
-- never be touched.
-- =============================================================================

SELECT test_refuses('a DRAFT cash-up may be rebuilt', $sql$
  DO $chk$
  DECLARE
    v_before int; v_after int;
    v_status text; v_tenant text; v_may_delete boolean; v_visible int;
  BEGIN
    -- PUT THE CASH-UP BACK INTO DRAFT FIRST.
    --
    -- This is the bug that made this test fail, and it was in the test, not in
    -- the schema. An earlier test_allows -- "a declared shortage balances the
    -- sheet" -- sets this cash-up to DECLARED and COMMITS, on purpose, so the
    -- shortage is there for the tests that follow.
    --
    -- So by the time this runs the cash-up is settled, and the restrictive
    -- policy refused the delete exactly as it is supposed to. The schema was
    -- right the whole time; the precondition was never established.
    --
    -- Inside a savepoint that rolls back, so the next test still sees DECLARED.
    UPDATE cash_up SET status = 'DRAFT', declared_at = NULL
     WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    SELECT c.status INTO v_status FROM cash_up c
     WHERE c.id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    v_tenant := COALESCE(current_setting('app.tenant_id', TRUE), '<unset>');

    SELECT has_table_privilege(current_user, 'money_movement', 'DELETE')
      INTO v_may_delete;

    SELECT count(*) INTO v_visible FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    SELECT count(*) INTO v_before FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    DELETE FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    SELECT count(*) INTO v_after FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    IF v_before > 0 AND v_after <> 0 THEN
      RAISE EXCEPTION
        'REBUILD_BLOCKED: status=% del=% vis=% tenant=% role=%',
        COALESCE(v_status, 'missing'), v_may_delete, v_visible,
        left(v_tenant, 8), current_user;
    END IF;
    RAISE EXCEPTION 'DRAFT_REBUILD_ALLOWED: cleared % rows', v_before;
  END $chk$;
$sql$, 'DRAFT_REBUILD_ALLOWED');

SELECT test_refuses('a DECLARED cash-up cannot have its money deleted', $sql$
  DO $chk$
  DECLARE v_before int; v_after int;
  BEGIN
    UPDATE cash_up SET status = 'DECLARED', declared_at = now()
     WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    SELECT count(*) INTO v_before FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    DELETE FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    SELECT count(*) INTO v_after FROM money_movement
     WHERE cash_up_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    IF v_after <> v_before THEN
      RAISE EXCEPTION 'DECLARED_MONEY_DELETED: % rows became % -- a settled '
                      'cash-up is not supposed to be erasable', v_before, v_after;
    END IF;
    RAISE EXCEPTION 'DECLARED_CASHUP_IS_PERMANENT';
  END $chk$;
$sql$, 'DECLARED_CASHUP_IS_PERMANENT');

SELECT test_refuses('the delete policies are RESTRICTIVE, not permissive', $sql$
  DO $chk$
  DECLARE v_bad text;
  BEGIN
    SELECT string_agg(policyname, ', ') INTO v_bad
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname LIKE '%_delete_draft_only'
       AND permissive <> 'RESTRICTIVE';
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'POLICY_TOO_PERMISSIVE: % would be ORed with the tenant '
                      'policy and let any row be deleted', v_bad;
    END IF;
    RAISE EXCEPTION 'DELETE_POLICIES_ARE_RESTRICTIVE';
  END $chk$;
$sql$, 'DELETE_POLICIES_ARE_RESTRICTIVE');


SELECT test_refuses('a tenant cannot READ another tenant''s rows', $sql$
  DO $chk$
  BEGIN
    IF EXISTS (SELECT 1 FROM site WHERE code = 'RIV') THEN
      RAISE EXCEPTION 'RLS_LEAK: the rival station is visible';
    END IF;
    RAISE EXCEPTION 'RLS_HELD: no rows from the other tenant are visible';
  END $chk$;
$sql$, 'RLS_HELD');

SELECT test_refuses('a tenant cannot WRITE into another tenant', $sql$
  INSERT INTO site (tenant_id, code, name)
  VALUES ('99999999-0000-4000-8000-000000000002','HACK','Stolen station');
$sql$, 'row-level security');

SELECT test_refuses('a tenant cannot re-tag its own row to another tenant', $sql$
  UPDATE site SET tenant_id = '99999999-0000-4000-8000-000000000002'
   WHERE code = 'KIB';
$sql$, 'row-level security');

RESET ROLE;

-- =============================================================================
-- THE ORGANISATION
--
-- Who may create whom, and who may approve whose work. These are the controls
-- a dealer is actually buying -- the arithmetic can be checked by hand, but
-- nobody can check by hand that the person who approved a shortage was not the
-- person who caused it.
-- =============================================================================

-- A CLOSED SHIFT TO APPROVE.
--
-- The approval rule only applies to a shift that has been closed -- approving
-- an open one is refused earlier, by APPROVAL_BEFORE_CLOSE -- and the suite's
-- main shift is deliberately left OPEN for the return-to-tank tests below.
--
-- An earlier version of these tests targeted '55555555-...', which is a PUMP
-- id. Every UPDATE matched no row, no trigger fired, two tests failed for the
-- wrong reason and one passed while proving nothing. That was shipped and
-- described as tested. It is recorded here so the shape is recognised next
-- time: a test that cannot fail is not evidence.
INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
  ('a9900000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'MGRCLS', 'Closing Manager', 'MANAGER');

INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment, state,
                   opened_at, opened_by, closed_at, closed_by, closed_reason)
VALUES ('a9900000-0000-4000-8000-0000000000a1', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '2020-01-01', 'DAY', 1, 'DECLARED',
        '2020-01-01 06:00+03', 'a9900000-0000-4000-8000-000000000001',
        '2020-01-01 18:00+03', 'a9900000-0000-4000-8000-000000000001', 'SCHEDULED');

SELECT test_allows('a manager may not appoint another manager', $sql$
DO $body$
BEGIN
  -- A manager may staff their station.
  IF NOT fn_may_create_staff(
       '99999999-9999-9999-9999-999999999999'::uuid, 'ATTENDANT') THEN
    RAISE EXCEPTION 'A manager should be able to take on an attendant';
  END IF;

  -- But not appoint the person who will review them.
  IF fn_may_create_staff(
       '99999999-9999-9999-9999-999999999999'::uuid, 'MANAGER') THEN
    RAISE EXCEPTION
      'MANAGER_APPOINTED_THEIR_OWN_REVIEWER: a manager created another '
      'manager, and that second manager is who approves their shifts.';
  END IF;

  RAISE NOTICE 'MANAGER_CANNOT_APPOINT_THEIR_REVIEWER';
END $body$;
$sql$);

SELECT test_allows('head office may appoint managers, a manager may not', $sql$
DO $body$
DECLARE v_ho uuid;
BEGIN
  -- A head office of our own. This test used to look for one, find none,
  -- print a notice and pass -- a test that could not fail.
  INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'HOTEST', 'Head Office Tester', 'HEAD_OFFICE')
  RETURNING id INTO v_ho;

  IF NOT fn_may_create_staff(v_ho, 'MANAGER') THEN
    RAISE EXCEPTION 'Head office must be able to appoint a manager';
  END IF;

  IF fn_may_create_staff(v_ho, 'SYSTEM_ADMIN') THEN
    RAISE EXCEPTION
      'HEAD_OFFICE_CREATED_AN_ADMIN: head office appointed somebody above it.';
  END IF;

  RAISE NOTICE 'HEAD_OFFICE_APPOINTS_MANAGERS';
END $body$;
$sql$);

SELECT test_refuses('a supervisor cannot approve a shift', $sql$
  UPDATE shift
     SET approved_by = '77777777-7777-7777-7777-777777777777'::uuid
   WHERE id = 'a9900000-0000-4000-8000-0000000000a1';
$sql$, 'APPROVER_NOT_A_MANAGER');

SELECT test_refuses('a manager at another site cannot approve this one', $sql$
DO $body$
DECLARE v_other uuid;
BEGIN
  -- A manager on strength somewhere else entirely.
  INSERT INTO site (id, tenant_id, code, name, kind, timezone, day_starts_at)
  VALUES ('7e577e57-0000-4000-8000-00000000aaaa',
          '11111111-1111-1111-1111-111111111111'::uuid,
          'FARAWAY', 'Faraway Station', 'STATION', 'Africa/Kampala', '06:00');

  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role, is_active)
  VALUES ('7e577e57-0000-4000-8000-00000000bbbb',
          '11111111-1111-1111-1111-111111111111'::uuid,
          '7e577e57-0000-4000-8000-00000000aaaa',
          'MGRFAR', 'Manager Elsewhere', 'MANAGER', true)
  RETURNING id INTO v_other;

  UPDATE shift SET approved_by = v_other
   WHERE id = 'a9900000-0000-4000-8000-0000000000a1';
END $body$;
$sql$, 'APPROVER_AT_ANOTHER_SITE');

SELECT test_allows('a second manager at the same site CAN approve', $sql$
DO $body$
DECLARE v_second uuid; v_site uuid;
BEGIN
  SELECT site_id INTO v_site FROM shift
   WHERE id = 'a9900000-0000-4000-8000-0000000000a1';

  INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role, is_active)
  VALUES ((SELECT tenant_id FROM site WHERE id = v_site),
          v_site, 'MGR02', 'Second Manager', 'MANAGER', true)
  RETURNING id INTO v_second;

  UPDATE shift SET approved_by = v_second
   WHERE id = 'a9900000-0000-4000-8000-0000000000a1';

  RAISE NOTICE 'SECOND_MANAGER_APPROVED';
END $body$;
$sql$);

SELECT test_allows('a site with one manager is told it cannot self-approve', $sql$
DO $body$
DECLARE v_note text; v_count int;
BEGIN
  SELECT manager_count, note INTO v_count, v_note
    FROM v_site_approval_readiness
   WHERE code = 'KIB';

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'The readiness view does not cover the station';
  END IF;

  RAISE NOTICE 'APPROVAL_READINESS: % manager(s) -- %', v_count, v_note;
END $body$;
$sql$);

SELECT test_refuses('a head office cannot hold a tank', $sql$
DO $body$
DECLARE v_ho uuid;
BEGIN
  INSERT INTO site (id, tenant_id, code, name, kind, timezone, day_starts_at)
  VALUES ('7e577e57-0000-4000-8000-00000000cccc',
          '11111111-1111-1111-1111-111111111111'::uuid,
          'HO-TEST', 'Head Office', 'HEAD_OFFICE', 'Africa/Kampala', '06:00')
  RETURNING id INTO v_ho;

  INSERT INTO tank (tenant_id, site_id, code, product_id, nominal_litres,
                    safe_fill, dead_stock, is_active)
  VALUES ('11111111-1111-1111-1111-111111111111'::uuid, v_ho, 'T-HO',
          (SELECT id FROM product LIMIT 1), 10000, 9000, 200, true);
END $body$;
$sql$, 'HEAD_OFFICE_DOES_NOT_TRADE');

-- =============================================================================
-- RETURN TO TANK
--
-- Litres the meter counted that went back into the tank. Excluded from what the
-- attendant owes and put back in the tank book -- and, because it relieves
-- somebody of a liability, the easiest place in the system to hide theft.
-- =============================================================================

SELECT test_refuses('an attendant cannot record their own return to tank', $sql$
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres,
                              reason, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '66666666-6666-6666-6666-666666666666', 20,
          'Line flushed after repair', '88888888-8888-8888-8888-888888888888');
$sql$, 'RTT_BY_ATTENDANT');

SELECT test_refuses('a return to tank needs a real reason', $sql$
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres,
                              reason, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '66666666-6666-6666-6666-666666666666', 20,
          'rtt', '77777777-7777-7777-7777-777777777777');
$sql$, 'return_to_tank_reason_check');

SELECT test_refuses('nobody witnesses their own return to tank', $sql$
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres,
                              reason, recorded_by, witnessed_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '66666666-6666-6666-6666-666666666666', 20,
          'Line flushed after repair',
          '77777777-7777-7777-7777-777777777777',
          '77777777-7777-7777-7777-777777777777');
$sql$, 'rtt_witness_is_someone_else');

SELECT test_refuses('no return to tank on a shift that is already closed', $sql$
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres,
                              reason, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'a9900000-0000-4000-8000-0000000000a1',
          '66666666-6666-6666-6666-666666666666', 20,
          'Line flushed after repair', '77777777-7777-7777-7777-777777777777');
$sql$, 'RTT_ON_CLOSED_SHIFT');

SELECT test_allows('RTT puts litres back into the tank, never out', $sql$
DO $body$
BEGIN
  -- Not a formality. movement_sign_correct only enforces the sign when this
  -- returns a non-zero value; an unregistered kind returns NULL, and a NEGATIVE
  -- RTT_IN would then pass and double the loss it was meant to cancel.
  IF fn_movement_sign('RTT_IN') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'RTT_SIGN_WRONG: fn_movement_sign(RTT_IN) = %, expected 1',
      fn_movement_sign('RTT_IN');
  END IF;
  RAISE NOTICE 'RTT_IN_IS_POSITIVE';
END $body$;
$sql$);

SELECT test_allows('an RTT litre cannot exist without the document explaining it', $sql$
DO $body$
DECLARE v_ev bigint;
BEGIN
  SELECT max(id) INTO v_ev FROM meter_event;
  IF v_ev IS NULL THEN
    RAISE EXCEPTION 'NO_METER_EVENT: nothing to test the disposition rule against';
  END IF;

  BEGIN
    INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres)
    VALUES ('11111111-1111-1111-1111-111111111111', v_ev, 'RTT', 5);
    RAISE EXCEPTION 'RTT_WITHOUT_DOCUMENT_ACCEPTED: an RTT disposition was saved '
      'with no return_to_tank row behind it.';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%rtt_needs_ref%' THEN
      RAISE;   -- refused, but by the wrong rule: that is not a pass
    END IF;
  END;

  RAISE NOTICE 'RTT_NEEDS_ITS_DOCUMENT';
END $body$;
$sql$);

SELECT test_allows('a supervisor records a return to tank on an open shift', $sql$
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres,
                              reason, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '66666666-6666-6666-6666-666666666666', 20,
          'Line flushed after repair', '77777777-7777-7777-7777-777777777777');
$sql$);

-- =============================================================================
-- THE CLOSE, RUN FOR REAL
--
-- Until this test, no test in the suite ran fn_close_shift. Every rule the
-- close relies on was tested -- every litre classified, every shilling
-- allocated -- by writing rows directly. The close's own arithmetic was not,
-- and that is exactly what the return-to-tank change altered.
--
-- An isolated site of its own, because the suite's main shift has been
-- mutated by sixty tests by this point and closing it would fail for reasons
-- that have nothing to do with RTT.
--
-- 100 litres through the meter, 20 poured back. The attendant must be billed
-- for 80, the 20 must be classified as RTT against its document, and the 20
-- must go back into the tank. The cash declared is exactly 80 litres' worth --
-- so if RTT were NOT deducted, the close would bill 100, the cash-up would be
-- a fifth short, and the test fails on CASH_UP_UNBALANCED rather than passing
-- quietly.
-- =============================================================================

SELECT test_allows('RTT inside a real close: billed net, classified, returned to the tank', $sql$
DO $body$
DECLARE
  t   uuid := '11111111-1111-1111-1111-111111111111';
  pms uuid := '33333333-3333-3333-3333-333333333333';
  s   uuid := 'b7000000-0000-4000-8000-000000000001';
  tk  uuid := 'b7000000-0000-4000-8000-000000000002';
  pu  uuid := 'b7000000-0000-4000-8000-000000000003';
  nz  uuid := 'b7000000-0000-4000-8000-000000000004';
  sup uuid := 'b7000000-0000-4000-8000-000000000005';
  att uuid := 'b7000000-0000-4000-8000-000000000006';
  mgr uuid := 'b7000000-0000-4000-8000-000000000007';
  sh  uuid := 'b7000000-0000-4000-8000-000000000008';
  asg uuid := 'b7000000-0000-4000-8000-000000000009';
  v_price numeric; v_sale numeric; v_rtt numeric; v_back numeric; v_ev bigint;
  v_seq text; v_tbl text;
BEGIN
  -- No acting user: this test builds a site and appoints its staff the way a
  -- seed does. If an earlier test leaked app.staff_id, the appointment rule
  -- would refuse the manager below for a reason unrelated to RTT.
  PERFORM set_config('app.staff_id', '', true);

  -- The fixture inserts identity ids by hand (OVERRIDING SYSTEM VALUE), which
  -- does not advance their sequences. The close inserts its own rows, so bring
  -- each sequence past the highest id or the first insert collides with id 1.
  FOREACH v_tbl IN ARRAY ARRAY['meter_reading','meter_event','metered_disposition',
                               'fuel_movement','money_movement','dip_reading',
                               'exception_flag','audit_log'] LOOP
    v_seq := pg_get_serial_sequence(v_tbl, 'id');
    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(id) FROM %I), 0) + 1, false)',
                     v_seq, v_tbl);
    END IF;
  END LOOP;

  INSERT INTO site (id, tenant_id, code, name) VALUES (s, t, 'RTTX', 'RTT Test Station');
  INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, max_dip_mm)
  VALUES (tk, t, s, pms, 'T1', 20000, 19000, 2400);
  INSERT INTO pump (id, tenant_id, site_id, code) VALUES (pu, t, s, 'P1');
  INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code) VALUES (nz, t, s, pu, tk, 'N1');
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
    (sup, t, s, 'RSUP', 'RTT Supervisor', 'SUPERVISOR'),
    (att, t, s, 'RATT', 'RTT Attendant',  'ATTENDANT'),
    (mgr, t, s, 'RMGR', 'RTT Manager',    'MANAGER');
  -- Opening stock, after the staff it names as recorder. FUEL_STOCK_NEGATIVE
  -- refuses a tank going below zero; the first run died there at -80 L --
  -- which, usefully, was -100 metered plus 20 returned: the RTT was already
  -- being counted back in before this line existed.
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                             litres, signed_litres, occurred_at, recorded_by)
  VALUES (t, s, tk, pms, 'OPENING_BALANCE', 10000, 10000,
          now() - interval '2 days', sup);
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from,
                            source, status, authorised_by, no_shift_to_break, executed_at)
  VALUES (t, s, pms, 5000, now() - interval '1 day', 'DEALER', 'EXECUTED', mgr, TRUE,
          now() - interval '1 day');
  INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment, state,
                     opened_at, opened_by)
  VALUES (sh, t, s, CURRENT_DATE, 'DAY', 1, 'OPEN', now() - interval '8 hours', sup);
  PERFORM fn_capture_shift_prices(sh);
  INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id,
                                 attendant_id, assigned_by, assigned_at)
  VALUES (asg, t, s, sh, nz, att, sup, now() - interval '8 hours');
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
                             is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES (t, s, nz, sh, asg, TRUE, 'MANUAL', 100000, sup, now() - interval '8 hours');

  -- Twenty litres poured back, recorded by the supervisor with a reason.
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres, reason, recorded_by)
  VALUES (t, s, sh, nz, 20, 'Line flushed after pump repair', sup);

  v_price := fn_shift_price(sh, pms);

  PERFORM fn_close_shift(
    sh, sup, 'SCHEDULED',
    jsonb_build_array(jsonb_build_object(
      'assignment_id', asg, 'volume_totalizer', 100100, 'is_rollover', false)),
    -- 500 litres of water, entered in LITRES. The alarm used to read
    -- millimetres only, so this would have passed in silence.
    jsonb_build_array(jsonb_build_object('tank_id', tk, 'product_litres', 9920,
                                         'water_litres', 500)),
    -- Exactly 80 litres' worth. If RTT were ignored the close would bill 100.
    jsonb_build_array(jsonb_build_object(
      'attendant_id', att, 'cash', 80 * v_price, 'tenders', '[]'::jsonb)));

  SELECT id INTO v_ev FROM meter_event WHERE assignment_id = asg;
  IF v_ev IS NULL THEN
    RAISE EXCEPTION 'CLOSE_MADE_NO_METER_EVENT for the assignment';
  END IF;

  SELECT litres INTO v_sale FROM metered_disposition WHERE meter_event_id = v_ev AND kind = 'SALE';
  SELECT litres INTO v_rtt  FROM metered_disposition WHERE meter_event_id = v_ev AND kind = 'RTT';
  SELECT COALESCE(SUM(signed_litres), 0) INTO v_back
    FROM fuel_movement WHERE shift_id = sh AND kind = 'RTT_IN';

  IF v_sale IS DISTINCT FROM 80 THEN
    RAISE EXCEPTION 'RTT_NOT_DEDUCTED: billed % L, expected 80 (100 metered - 20 back)', v_sale;
  END IF;
  IF v_rtt IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'RTT_NOT_CLASSIFIED: RTT disposition % L, expected 20', v_rtt;
  END IF;
  IF v_back IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'RTT_NOT_RETURNED: RTT_IN moved % L, expected +20', v_back;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM exception_flag
                  WHERE code = 'WATER_HIGH' AND entity_id = tk::text) THEN
    RAISE EXCEPTION 'WATER_ALARM_SILENT: 500 L of water entered in litres raised nothing';
  END IF;

  RAISE NOTICE 'RTT_END_TO_END: 100 metered, 20 back, 80 billed at %, 20 returned, water alarmed', v_price;
END $body$;
$sql$);

-- =============================================================================
-- EVERYONE WHO SOLD IS CASHED UP (360)
-- The RTT close above, rebuilt with its own ids and closed with no cash-ups.
-- =============================================================================

SELECT test_refuses('a close that leaves out someone who sold is refused', $sql$
DO $body$
DECLARE
  t   uuid := '11111111-1111-1111-1111-111111111111';
  pms uuid := '33333333-3333-3333-3333-333333333333';
  s   uuid := 'b8000000-0000-4000-8000-000000000001';
  tk  uuid := 'b8000000-0000-4000-8000-000000000002';
  pu  uuid := 'b8000000-0000-4000-8000-000000000003';
  nz  uuid := 'b8000000-0000-4000-8000-000000000004';
  sup uuid := 'b8000000-0000-4000-8000-000000000005';
  att uuid := 'b8000000-0000-4000-8000-000000000006';
  mgr uuid := 'b8000000-0000-4000-8000-000000000007';
  sh  uuid := 'b8000000-0000-4000-8000-000000000008';
  asg uuid := 'b8000000-0000-4000-8000-000000000009';
  v_price numeric; v_sale numeric; v_rtt numeric; v_back numeric; v_ev bigint;
  v_seq text; v_tbl text;
BEGIN
  -- No acting user: this test builds a site and appoints its staff the way a
  -- seed does. If an earlier test leaked app.staff_id, the appointment rule
  -- would refuse the manager below for a reason unrelated to RTT.
  PERFORM set_config('app.staff_id', '', true);

  -- The fixture inserts identity ids by hand (OVERRIDING SYSTEM VALUE), which
  -- does not advance their sequences. The close inserts its own rows, so bring
  -- each sequence past the highest id or the first insert collides with id 1.
  FOREACH v_tbl IN ARRAY ARRAY['meter_reading','meter_event','metered_disposition',
                               'fuel_movement','money_movement','dip_reading',
                               'exception_flag','audit_log'] LOOP
    v_seq := pg_get_serial_sequence(v_tbl, 'id');
    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(id) FROM %I), 0) + 1, false)',
                     v_seq, v_tbl);
    END IF;
  END LOOP;

  INSERT INTO site (id, tenant_id, code, name) VALUES (s, t, 'MCUX', 'Missing Cash-up Test Station');
  INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, max_dip_mm)
  VALUES (tk, t, s, pms, 'T1', 20000, 19000, 2400);
  INSERT INTO pump (id, tenant_id, site_id, code) VALUES (pu, t, s, 'P1');
  INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code) VALUES (nz, t, s, pu, tk, 'N1');
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
    (sup, t, s, 'XSUP', 'RTT Supervisor', 'SUPERVISOR'),
    (att, t, s, 'XATT', 'RTT Attendant',  'ATTENDANT'),
    (mgr, t, s, 'XMGR', 'RTT Manager',    'MANAGER');
  -- Opening stock, after the staff it names as recorder. FUEL_STOCK_NEGATIVE
  -- refuses a tank going below zero; the first run died there at -80 L --
  -- which, usefully, was -100 metered plus 20 returned: the RTT was already
  -- being counted back in before this line existed.
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                             litres, signed_litres, occurred_at, recorded_by)
  VALUES (t, s, tk, pms, 'OPENING_BALANCE', 10000, 10000,
          now() - interval '2 days', sup);
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from,
                            source, status, authorised_by, no_shift_to_break, executed_at)
  VALUES (t, s, pms, 5000, now() - interval '1 day', 'DEALER', 'EXECUTED', mgr, TRUE,
          now() - interval '1 day');
  INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment, state,
                     opened_at, opened_by)
  VALUES (sh, t, s, CURRENT_DATE, 'DAY', 1, 'OPEN', now() - interval '8 hours', sup);
  PERFORM fn_capture_shift_prices(sh);
  INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id,
                                 attendant_id, assigned_by, assigned_at)
  VALUES (asg, t, s, sh, nz, att, sup, now() - interval '8 hours');
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
                             is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES (t, s, nz, sh, asg, TRUE, 'MANUAL', 100000, sup, now() - interval '8 hours');

  -- Twenty litres poured back, recorded by the supervisor with a reason.
  INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id, litres, reason, recorded_by)
  VALUES (t, s, sh, nz, 20, 'Line flushed after pump repair', sup);

  v_price := fn_shift_price(sh, pms);

  PERFORM fn_close_shift(
    sh, sup, 'SCHEDULED',
    jsonb_build_array(jsonb_build_object(
      'assignment_id', asg, 'volume_totalizer', 100100, 'is_rollover', false)),
    -- 500 litres of water, entered in LITRES. The alarm used to read
    -- millimetres only, so this would have passed in silence.
    jsonb_build_array(jsonb_build_object('tank_id', tk, 'product_litres', 9920,
                                         'water_litres', 500)),
    -- Exactly 80 litres' worth. If RTT were ignored the close would bill 100.
    -- NO cash-ups. The attendant held the nozzle and sold 80 litres; before
    -- 360 this closed, and the takings belonged to nobody.
    '[]'::jsonb);

  SELECT id INTO v_ev FROM meter_event WHERE assignment_id = asg;
  IF v_ev IS NULL THEN
    RAISE EXCEPTION 'CLOSE_MADE_NO_METER_EVENT for the assignment';
  END IF;

  SELECT litres INTO v_sale FROM metered_disposition WHERE meter_event_id = v_ev AND kind = 'SALE';
  SELECT litres INTO v_rtt  FROM metered_disposition WHERE meter_event_id = v_ev AND kind = 'RTT';
  SELECT COALESCE(SUM(signed_litres), 0) INTO v_back
    FROM fuel_movement WHERE shift_id = sh AND kind = 'RTT_IN';

  IF v_sale IS DISTINCT FROM 80 THEN
    RAISE EXCEPTION 'RTT_NOT_DEDUCTED: billed % L, expected 80 (100 metered - 20 back)', v_sale;
  END IF;
  IF v_rtt IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'RTT_NOT_CLASSIFIED: RTT disposition % L, expected 20', v_rtt;
  END IF;
  IF v_back IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'RTT_NOT_RETURNED: RTT_IN moved % L, expected +20', v_back;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM exception_flag
                  WHERE code = 'WATER_HIGH' AND entity_id = tk::text) THEN
    RAISE EXCEPTION 'WATER_ALARM_SILENT: 500 L of water entered in litres raised nothing';
  END IF;

  RAISE NOTICE 'RTT_END_TO_END: 100 metered, 20 back, 80 billed at %, 20 returned, water alarmed', v_price;
END $body$;
$sql$, 'MISSING_CASH_UPS');

-- =============================================================================
-- CONTROLS CLOSED (280)
-- =============================================================================

SELECT test_refuses('a manager cannot appoint a manager through the staff table', $sql$
DO $body$
BEGIN
  -- The actor is a manager. The organisation endpoint asked the rule; the old
  -- /api/admin/staff route did not. The trigger makes every route ask.
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          'SNEAK1', 'Appointed Reviewer', 'MANAGER');
END $body$;
$sql$, 'MAY_NOT_APPOINT');

SELECT test_refuses('a manager cannot edit a supervisor into a manager', $sql$
DO $body$
BEGIN
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  UPDATE staff SET role = 'MANAGER' WHERE id = '77777777-7777-7777-7777-777777777777';
END $body$;
$sql$, 'MAY_NOT_APPOINT');

SELECT test_refuses('a manager cannot demote the other manager to remove a reviewer', $sql$
DO $body$
BEGIN
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  UPDATE staff SET role = 'ATTENDANT' WHERE id = 'a9900000-0000-4000-8000-000000000001';
END $body$;
$sql$, 'MAY_NOT_CHANGE_ROLE');

SELECT test_refuses('no recovering more than the shortage', $sql$
DO $body$
DECLARE v_id uuid; v_amt numeric;
BEGIN
  SELECT id, amount INTO v_id, v_amt FROM staff_shortage
   WHERE staff_id = '88888888-8888-8888-8888-888888888888' LIMIT 1;
  INSERT INTO shortage_recovery (tenant_id, staff_id, shortage_id, amount, method, approved_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888',
          v_id, COALESCE(v_amt, 0) + 1, 'CASH', '99999999-9999-9999-9999-999999999999');
END $body$;
$sql$, 'OVER_RECOVERY');

SELECT test_refuses('a traded product cannot change its unit', $sql$
  UPDATE product SET uom = 'KG' WHERE id = '33333333-3333-3333-3333-333333333333';
$sql$, 'PRODUCT_UNIT_FROZEN');

-- =============================================================================
-- THE PLATFORM AND THE GRANTS (290)
--
-- The organisation had rules nobody could use: the system administrator did
-- not hold system.admin, head office held nothing, and row-level security
-- refused creating any company but your own.
-- =============================================================================

SELECT test_allows('the system administrator holds system.admin', $sql$
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role_permission
                  WHERE role = 'SYSTEM_ADMIN' AND permission = 'system.admin') THEN
    RAISE EXCEPTION 'SYSADMIN_LACKS_SYSTEM_ADMIN: companies are unreachable by everyone';
  END IF;
END $body$;
$sql$);

SELECT test_allows('head office can appoint people and do all a manager can', $sql$
DO $body$
DECLARE v_missing int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role_permission
                  WHERE role = 'HEAD_OFFICE' AND permission = 'staff.manage') THEN
    RAISE EXCEPTION 'HEAD_OFFICE_CANNOT_APPOINT: the role whose job is appointing lacks staff.manage';
  END IF;
  SELECT count(*) INTO v_missing FROM role_permission m
   WHERE m.role = 'MANAGER'
     AND NOT EXISTS (SELECT 1 FROM role_permission h
                      WHERE h.role = 'HEAD_OFFICE' AND h.permission = m.permission);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'HEAD_OFFICE_BELOW_MANAGER: % manager permission(s) missing', v_missing;
  END IF;
END $body$;
$sql$);

SELECT test_allows('ADMIN can still appoint a supervisor', $sql$
DO $body$
DECLARE v_admin uuid;
BEGIN
  -- 280's trigger asks fn_may_create_staff, which did not know ADMIN -- so
  -- ADMIN silently lost the ability to appoint anyone.
  INSERT INTO staff (tenant_id, site_id, employee_no, full_name, role)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'ADMTEST', 'Staff Administrator', 'ADMIN')
  RETURNING id INTO v_admin;
  IF NOT fn_may_create_staff(v_admin, 'SUPERVISOR') THEN
    RAISE EXCEPTION 'ADMIN_CANNOT_APPOINT: fn_may_create_staff refuses ADMIN';
  END IF;
END $body$;
$sql$);

SELECT test_refuses('a manager cannot switch off the other manager', $sql$
DO $body$
BEGIN
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  UPDATE staff SET is_active = false WHERE id = 'a9900000-0000-4000-8000-000000000001';
END $body$;
$sql$, 'MAY_NOT_CHANGE_STATUS');

SELECT test_refuses('a manager cannot create a company', $sql$
DO $body$
BEGIN
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  PERFORM fn_platform_create_company('Rogue Fuels', NULL, NULL, NULL,
          'UG', 'UGX', 'Africa/Kampala', 'Rogue Head Office', NULL,
          'RG01', 'Rogue Operator', NULL);
END $body$;
$sql$, 'PLATFORM_ONLY');

SELECT test_allows('a system administrator creates a company with its head office', $sql$
DO $body$
DECLARE v_co uuid; v_ho uuid; v_admin uuid; v_cats int; v_role staff_role;
BEGIN
  PERFORM set_config('app.staff_id', '77777777-0000-4000-8000-0000000000ad', true);
  SELECT company_id, head_office_id, admin_staff_id INTO v_co, v_ho, v_admin
    FROM fn_platform_create_company('Test Petroleum', 'Test Petroleum Limited',
           '800200099', NULL, 'UG', 'UGX', 'Africa/Kampala',
           'Test Head Office', 'Kampala', 'TP01', 'Test Head Office Manager', NULL);

  -- Somebody must be able to sign in. A company created empty could never be
  -- staffed afterwards: appointing into another company is the write
  -- row-level security refuses.
  SELECT role INTO v_role FROM staff WHERE id = v_admin;
  IF v_role IS DISTINCT FROM 'HEAD_OFFICE' THEN
    RAISE EXCEPTION 'COMPANY_WITHOUT_ANYBODY: no head office person was created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = v_admin AND tenant_id = v_co AND site_id = v_ho) THEN
    RAISE EXCEPTION 'HEAD_OFFICE_PERSON_MISPLACED: not at their own company''s head office';
  END IF;

  IF v_ho IS NULL THEN
    RAISE EXCEPTION 'COMPANY_WITHOUT_HEAD_OFFICE: nobody could appoint its managers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM site WHERE id = v_ho AND kind = 'HEAD_OFFICE') THEN
    RAISE EXCEPTION 'HEAD_OFFICE_NOT_A_HEAD_OFFICE';
  END IF;
  SELECT count(*) INTO v_cats FROM income_category WHERE tenant_id = v_co;
  IF v_cats = 0 THEN
    RAISE EXCEPTION 'NO_INCOME_CATEGORIES for the new company';
  END IF;

  -- Leave no acting user behind for anything that runs after this.
  PERFORM set_config('app.staff_id', '', true);
END $body$;
$sql$);

-- =============================================================================
-- ROLES MATCH THE RULES (320)
-- =============================================================================

SELECT test_allows('head office can set up its own equipment', $sql$
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role_permission
                  WHERE role = 'HEAD_OFFICE' AND permission = 'equipment.manage') THEN
    RAISE EXCEPTION 'HEAD_OFFICE_CANNOT_EQUIP: a new company could never add a pump';
  END IF;
END $body$;
$sql$);

SELECT test_allows('nobody holds shift.approve whom the approval rule would refuse', $sql$
DO $body$
DECLARE v text;
BEGIN
  -- The trigger accepts MANAGER, HEAD_OFFICE and SYSTEM_ADMIN. A permission
  -- held by anyone else offers a button the database then refuses.
  SELECT string_agg(role::text, ', ') INTO v FROM role_permission
   WHERE permission = 'shift.approve'
     AND role NOT IN ('MANAGER', 'HEAD_OFFICE', 'SYSTEM_ADMIN');
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'APPROVAL_PROMISED_BUT_REFUSED: % hold shift.approve', v;
  END IF;
END $body$;
$sql$);

-- =============================================================================
-- ACCESS RULES (330)
-- =============================================================================

SELECT test_refuses('a manager cannot lock the other manager out', $sql$
DO $body$
BEGIN
  -- Give the other manager a credential FIRST. Deleting a row that does not
  -- exist fires no trigger, and a test like that passes while proving nothing.
  INSERT INTO staff_credential (staff_id, password_hash)
  VALUES ('a9900000-0000-4000-8000-000000000001', 'x')
  ON CONFLICT (staff_id) DO NOTHING;
  PERFORM set_config('app.staff_id', '99999999-9999-9999-9999-999999999999', true);
  DELETE FROM staff_credential WHERE staff_id = 'a9900000-0000-4000-8000-000000000001';
END $body$;
$sql$, 'MAY_NOT_REVOKE');

SELECT test_allows('head office can change the policy and end sessions', $sql$
DO $body$
BEGIN
  IF (SELECT count(*) FROM role_permission WHERE role = 'HEAD_OFFICE'
       AND permission IN ('policy.configure', 'session.revoke')) <> 2 THEN
    RAISE EXCEPTION 'HEAD_OFFICE_CANNOT_ADMINISTER: screens promise head office changes the policy';
  END IF;
END $body$;
$sql$);

-- =============================================================================
-- USED EQUIPMENT KEEPS ITS WIRING (340)
-- Nozzle 6666 has meter readings in the fixtures, and draws from tank 4444,
-- so both are genuinely USED -- a test on unused equipment would pass while
-- proving nothing.
-- =============================================================================

SELECT test_refuses('a used tank cannot change its product', $sql$
  UPDATE tank SET product_id = '77777777-0000-4000-8000-000000000001'
   WHERE id = '44444444-4444-4444-4444-444444444444';
$sql$, 'TANK_PRODUCT_FROZEN');

SELECT test_refuses('a used nozzle cannot change its digit count', $sql$
  UPDATE nozzle SET integer_digits = integer_digits + 1
   WHERE id = '66666666-6666-6666-6666-666666666666';
$sql$, 'NOZZLE_WIRING_FROZEN');

SELECT test_allows('a used tank can still have its settings corrected', $sql$
  UPDATE tank SET dead_stock = dead_stock, safe_fill = safe_fill
   WHERE id = '44444444-4444-4444-4444-444444444444';
$sql$);

SELECT test_allows('a used nozzle can still have its flow rate corrected', $sql$
  UPDATE nozzle SET max_flow_lpm = 60
   WHERE id = '66666666-6666-6666-6666-666666666666';
$sql$);

-- =============================================================================
-- THE CREDIT SWITCH (370)
-- A BEFORE INSERT trigger runs ahead of NOT NULL and foreign-key checks, so a
-- bare row reaches it first. The second test proves the switch ON lets a row
-- THROUGH: it then fails on a missing column instead -- a different error.
-- =============================================================================

SELECT test_refuses('with credit switched off, a credit sale is refused', $sql$
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'FIXTURE_HAS_NO_POLICY: the test would prove nothing';
  END IF;
  UPDATE tenant_policy SET allow_credit_sales = FALSE WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
  INSERT INTO credit_sale (tenant_id) VALUES ('11111111-1111-1111-1111-111111111111');
END $body$;
$sql$, 'CREDIT_SALES_OFF');

SELECT test_refuses('with credit switched on, the switch does not stand in the way', $sql$
  INSERT INTO credit_sale (tenant_id) VALUES ('11111111-1111-1111-1111-111111111111');
$sql$, 'null value');

-- =============================================================================
-- A PRICE EXECUTED EARLY TAKES EFFECT WHEN EXECUTED (400)
-- Its own site, so no open shift interferes: old price 5,000 in force; 5,500
-- scheduled an hour ahead and executed now. Without 400, 5,000 stays in force.
-- =============================================================================

SELECT test_allows('a price change executed early is the price from then on', $sql$
DO $body$
DECLARE s uuid := 'b9000000-0000-4000-8000-000000000001'; pc uuid; v numeric;
BEGIN
  INSERT INTO site (id, tenant_id, code, name) VALUES (s, '11111111-1111-1111-1111-111111111111', 'PBTX', 'Price Break Test Station');
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from, source,
                            status, authorised_by, no_shift_to_break, executed_at)
  VALUES ('11111111-1111-1111-1111-111111111111', s, '33333333-3333-3333-3333-333333333333', 5000, now() - interval '1 day', 'DEALER', 'EXECUTED', '99999999-9999-9999-9999-999999999999', TRUE, now() - interval '1 day');
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from, source, authorised_by)
  VALUES ('11111111-1111-1111-1111-111111111111', s, '33333333-3333-3333-3333-333333333333', 5500, now() + interval '1 hour', 'DEALER', '99999999-9999-9999-9999-999999999999')
  RETURNING id INTO pc;
  PERFORM fn_execute_price_break(pc, '99999999-9999-9999-9999-999999999999', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
  v := fn_current_price(s, '33333333-3333-3333-3333-333333333333', now());
  IF v <> 5500 THEN
    RAISE EXCEPTION 'EARLY_PRICE_NOT_IN_FORCE: executed 5,500 but % is in force', v;
  END IF;
END $body$;
$sql$);

-- =============================================================================
-- THE ATTENDANT WHO HANDED OVER IS BILLED (410)
-- A opens at 100,000 and hands over to B at 100,040 four hours in; B closes at
-- 100,100. By hand: A sold 40 L, B sold 60 L, and 100 L leave the book. Before
-- 410 only B's 60 L existed -- A's cash was an overage and the tank short 40.
-- =============================================================================

SELECT test_allows('a handover bills both attendants and takes all the fuel off the book', $sql$
DO $body$
DECLARE
  t   uuid := '11111111-1111-1111-1111-111111111111';
  pms uuid := '33333333-3333-3333-3333-333333333333';
  s   uuid := 'ba000000-0000-4000-8000-000000000001';
  tk  uuid := 'ba000000-0000-4000-8000-000000000002';
  pu  uuid := 'ba000000-0000-4000-8000-000000000003';
  nz  uuid := 'ba000000-0000-4000-8000-000000000004';
  sup uuid := 'ba000000-0000-4000-8000-000000000005';
  a   uuid := 'ba000000-0000-4000-8000-000000000006';
  b   uuid := 'ba000000-0000-4000-8000-000000000007';
  mgr uuid := 'ba000000-0000-4000-8000-000000000008';
  sh  uuid := 'ba000000-0000-4000-8000-000000000009';
  asa uuid := 'ba000000-0000-4000-8000-00000000000a';
  asb uuid := 'ba000000-0000-4000-8000-00000000000b';
  v_price numeric; v_a numeric; v_b numeric; v_out numeric; v_state text;
  v_seq text; v_tbl text;
BEGIN
  PERFORM set_config('app.staff_id', '', true);
  FOREACH v_tbl IN ARRAY ARRAY['meter_reading','meter_event','metered_disposition',
                               'fuel_movement','money_movement','dip_reading',
                               'exception_flag','audit_log'] LOOP
    v_seq := pg_get_serial_sequence(v_tbl, 'id');
    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(id) FROM %I), 0) + 1, false)', v_seq, v_tbl);
    END IF;
  END LOOP;

  INSERT INTO site (id, tenant_id, code, name) VALUES (s, t, 'HOVX', 'Handover Test Station');
  INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, max_dip_mm)
  VALUES (tk, t, s, pms, 'T1', 20000, 19000, 2400);
  INSERT INTO pump (id, tenant_id, site_id, code) VALUES (pu, t, s, 'P1');
  INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code) VALUES (nz, t, s, pu, tk, 'N1');
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
    (sup, t, s, 'HSUP', 'Handover Supervisor', 'SUPERVISOR'),
    (a,   t, s, 'HATA', 'Attendant A',         'ATTENDANT'),
    (b,   t, s, 'HATB', 'Attendant B',         'ATTENDANT'),
    (mgr, t, s, 'HMGR', 'Handover Manager',    'MANAGER');
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                             litres, signed_litres, occurred_at, recorded_by)
  VALUES (t, s, tk, pms, 'OPENING_BALANCE', 10000, 10000, now() - interval '2 days', sup);
  INSERT INTO price_change (tenant_id, site_id, product_id, new_price, effective_from,
                            source, status, authorised_by, no_shift_to_break, executed_at)
  VALUES (t, s, pms, 5000, now() - interval '1 day', 'DEALER', 'EXECUTED', mgr, TRUE, now() - interval '1 day');
  INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment, state, opened_at, opened_by)
  VALUES (sh, t, s, CURRENT_DATE, 'DAY', 1, 'OPEN', now() - interval '8 hours', sup);
  PERFORM fn_capture_shift_prices(sh);

  -- A holds the nozzle from the start.
  INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id, attendant_id, assigned_by, assigned_at)
  VALUES (asa, t, s, sh, nz, a, sup, now() - interval '8 hours');
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
                             is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES (t, s, nz, sh, asa, TRUE, 'MANUAL', 100000, sup, now() - interval '8 hours');

  -- The handover, as HandoverAsync writes it: A's closing reading, A released,
  -- B assigned, B's opening reading at the same totalizer.
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
                             is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES (t, s, nz, sh, asa, FALSE, 'MANUAL', 100040, sup, now() - interval '4 hours');
  UPDATE nozzle_assignment SET state = 'CLOSED', released_at = now() - interval '4 hours',
         released_by = sup WHERE id = asa;
  INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id, attendant_id, assigned_by, assigned_at)
  VALUES (asb, t, s, sh, nz, b, sup, now() - interval '4 hours');
  UPDATE nozzle_assignment SET state = 'HANDED_OVER', handed_to_id = asb WHERE id = asa;
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
                             is_opening, source, volume_totalizer, recorded_by, captured_at)
  VALUES (t, s, nz, sh, asb, TRUE, 'MANUAL', 100040, sup, now() - interval '4 hours');

  v_price := fn_shift_price(sh, pms);
  -- The screen submits ONLY the active nozzle -- B -- exactly as it does.
  PERFORM fn_close_shift(
    sh, sup, 'SCHEDULED',
    jsonb_build_array(jsonb_build_object('assignment_id', asb, 'volume_totalizer', 100100, 'is_rollover', false)),
    jsonb_build_array(jsonb_build_object('tank_id', tk, 'product_litres', 9900, 'water_litres', 0)),
    jsonb_build_array(
      jsonb_build_object('attendant_id', a, 'cash', 40 * v_price, 'tenders', '[]'::jsonb),
      jsonb_build_object('attendant_id', b, 'cash', 60 * v_price, 'tenders', '[]'::jsonb)));

  SELECT md.litres INTO v_a FROM meter_event me JOIN metered_disposition md
    ON md.meter_event_id = me.id AND md.kind = 'SALE' WHERE me.assignment_id = asa;
  SELECT md.litres INTO v_b FROM meter_event me JOIN metered_disposition md
    ON md.meter_event_id = me.id AND md.kind = 'SALE' WHERE me.assignment_id = asb;
  SELECT -SUM(signed_litres) INTO v_out FROM fuel_movement WHERE shift_id = sh AND kind = 'METER_OUT';
  SELECT state INTO v_state FROM nozzle_assignment WHERE id = asa;

  IF v_a IS DISTINCT FROM 40 THEN RAISE EXCEPTION 'HANDOVER_NOT_BILLED: A billed %, expected 40', v_a; END IF;
  IF v_b IS DISTINCT FROM 60 THEN RAISE EXCEPTION 'INCOMING_WRONG: B billed %, expected 60', v_b; END IF;
  IF v_out IS DISTINCT FROM 100 THEN RAISE EXCEPTION 'BOOK_WRONG: % L off the book, expected 100', v_out; END IF;
  IF v_state <> 'HANDED_OVER' THEN RAISE EXCEPTION 'HANDOVER_STATE_LOST: A is %', v_state; END IF;
END $body$;
$sql$);

-- =============================================================================
-- ONE ACCOUNT, AND WHAT IS PAID AHEAD (440, 450)
-- =============================================================================

SELECT test_allows('a depot load over the limit is recorded AND flagged', $sql$
DO $body$
DECLARE cust uuid := 'bb000000-0000-4000-8000-000000000001'; ld uuid; n int;
BEGIN
  INSERT INTO credit_customer (id, tenant_id, code, name, credit_limit)
  VALUES (cust, '11111111-1111-1111-1111-111111111111', 'OVRX', 'Over Limit Haulier', 1000);
  -- 100 L at 5,000 = 500,000 against a 1,000 limit.
  INSERT INTO bulk_sale (tenant_id, site_id, tank_id, product_id, customer_id, invoice_no,
                         truck_reg, litres, metered_litres, basis, unit_price, amount,
                         payment_terms, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', cust, 'INV-OVR-1', 'UAX 001A', 100, 100, 'METER',
          5000, 500000, 'CREDIT', '99999999-9999-9999-9999-999999999999')
  RETURNING id INTO ld;
  SELECT count(*) INTO n FROM exception_flag
   WHERE entity = 'bulk_sale' AND entity_id = ld::text AND code = 'CREDIT_LIMIT_EXCEEDED';
  IF n <> 1 THEN RAISE EXCEPTION 'OVER_LIMIT_NOT_FLAGGED: % flag(s)', n; END IF;
END $body$;
$sql$);

SELECT test_allows('money paid ahead is room to buy, and the depot debt counts', $sql$
DO $body$
DECLARE cust uuid := 'bb000000-0000-4000-8000-000000000002'; h numeric; b numeric; ua numeric;
BEGIN
  INSERT INTO credit_customer (id, tenant_id, code, name, credit_limit)
  VALUES (cust, '11111111-1111-1111-1111-111111111111', 'AHDX', 'Paid Ahead Transporter', 1000000);
  INSERT INTO bulk_sale (tenant_id, site_id, tank_id, product_id, customer_id, invoice_no,
                         truck_reg, litres, metered_litres, basis, unit_price, amount,
                         payment_terms, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', cust, 'INV-AHD-1', 'UAX 002A', 100, 100, 'METER',
          5000, 500000, 'CREDIT', '99999999-9999-9999-9999-999999999999');
  INSERT INTO credit_payment (tenant_id, customer_id, amount, method, received_by)
  VALUES ('11111111-1111-1111-1111-111111111111', cust, 700000, 'BANK', '99999999-9999-9999-9999-999999999999');
  -- Owed 500,000 at the depot, paid 700,000: 200,000 ahead.
  SELECT headroom, balance INTO h, b FROM fn_customer_headroom(cust);
  IF h <> 1200000 THEN RAISE EXCEPTION 'HEADROOM_WRONG: %, expected 1,200,000', h; END IF;
  IF b <> -200000 THEN RAISE EXCEPTION 'BALANCE_WRONG: %, expected -200,000', b; END IF;
  SELECT unapplied_credit INTO ua FROM v_credit_ageing_buckets WHERE customer_id = cust;
  IF ua <> 200000 THEN RAISE EXCEPTION 'PAID_AHEAD_NOT_SHOWN: %', ua; END IF;
END $body$;
$sql$);

-- =============================================================================
-- THE SHORTAGE LIMIT WARNS (460)
-- An attendant owing 300,000 against the 200,000 default is put on a nozzle:
-- the assignment goes ahead, AND one warning is raised. Its own station.
-- =============================================================================

SELECT test_allows('an attendant owing over the limit is put on a pump with a warning', $sql$
DO $body$
DECLARE
  s   uuid := 'bc000000-0000-4000-8000-000000000001';
  tk  uuid := 'bc000000-0000-4000-8000-000000000002';
  pu  uuid := 'bc000000-0000-4000-8000-000000000003';
  nz  uuid := 'bc000000-0000-4000-8000-000000000004';
  sup uuid := 'bc000000-0000-4000-8000-000000000005';
  att uuid := 'bc000000-0000-4000-8000-000000000006';
  sh  uuid := 'bc000000-0000-4000-8000-000000000007';
  cu  uuid := 'bc000000-0000-4000-8000-000000000008';
  asg uuid := 'bc000000-0000-4000-8000-000000000009';
  n int;
BEGIN
  IF (SELECT max_shortage_carry FROM tenant_policy WHERE tenant_id = '11111111-1111-1111-1111-111111111111') <> 200000 THEN
    RAISE EXCEPTION 'FIXTURE_POLICY_CHANGED: the test assumes the 200,000 default';
  END IF;
  INSERT INTO site (id, tenant_id, code, name) VALUES (s, '11111111-1111-1111-1111-111111111111', 'SCRX', 'Shortage Carry Test Station');
  INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, max_dip_mm)
  VALUES (tk, '11111111-1111-1111-1111-111111111111', s, '33333333-3333-3333-3333-333333333333', 'T1', 20000, 19000, 2400);
  INSERT INTO pump (id, tenant_id, site_id, code) VALUES (pu, '11111111-1111-1111-1111-111111111111', s, 'P1');
  INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code) VALUES (nz, '11111111-1111-1111-1111-111111111111', s, pu, tk, 'N1');
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
    (sup, '11111111-1111-1111-1111-111111111111', s, 'CSUP', 'Carry Supervisor', 'SUPERVISOR'),
    (att, '11111111-1111-1111-1111-111111111111', s, 'CATT', 'Owing Attendant',  'ATTENDANT');
  INSERT INTO shift (id, tenant_id, site_id, business_date, label, segment, state, opened_at, opened_by)
  VALUES (sh, '11111111-1111-1111-1111-111111111111', s, CURRENT_DATE, 'DAY', 1, 'OPEN', now() - interval '1 hour', sup);
  INSERT INTO cash_up (id, tenant_id, site_id, shift_id, staff_id, currency)
  VALUES (cu, '11111111-1111-1111-1111-111111111111', s, sh, att, 'UGX');
  INSERT INTO staff_shortage (tenant_id, site_id, staff_id, shift_id, cash_up_id, amount, currency, reason)
  VALUES ('11111111-1111-1111-1111-111111111111', s, att, sh, cu, 300000, 'UGX', 'earlier shortfall');

  INSERT INTO nozzle_assignment (id, tenant_id, site_id, shift_id, nozzle_id, attendant_id, assigned_by, assigned_at)
  VALUES (asg, '11111111-1111-1111-1111-111111111111', s, sh, nz, att, sup, now());

  SELECT count(*) INTO n FROM exception_flag
   WHERE entity = 'nozzle_assignment' AND entity_id = asg::text AND code = 'SHORTAGE_CARRY_EXCEEDED';
  IF n <> 1 THEN RAISE EXCEPTION 'CARRY_NOT_WARNED: % warning(s)', n; END IF;
END $body$;
$sql$);

-- =============================================================================
-- A DEPOT DAY OPENS AND CLOSES (490)
-- Through the real functions -- the path no test took, which is how two faults
-- that stopped every depot day stayed hidden.
-- =============================================================================

SELECT test_allows('a depot day opens and closes through its functions', $sql$
DO $body$
DECLARE
  s   uuid := 'bd000000-0000-4000-8000-000000000001';
  tk  uuid := 'bd000000-0000-4000-8000-000000000002';
  mgr uuid := 'bd000000-0000-4000-8000-000000000003';
  sh  uuid; res jsonb; v_state text; v_gross numeric;
BEGIN
  INSERT INTO site (id, tenant_id, code, name, kind) VALUES (s, '11111111-1111-1111-1111-111111111111', 'DPTX', 'Depot Day Test', 'DEPOT');
  INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, max_dip_mm)
  VALUES (tk, '11111111-1111-1111-1111-111111111111', s, '33333333-3333-3333-3333-333333333333', 'BT1', 60000, 57000, 4000);
  INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role)
  VALUES (mgr, '11111111-1111-1111-1111-111111111111', s, 'DMGR', 'Depot Manager', 'MANAGER');
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                             litres, signed_litres, occurred_at, recorded_by)
  VALUES ('11111111-1111-1111-1111-111111111111', s, tk, '33333333-3333-3333-3333-333333333333', 'OPENING_BALANCE', 20000, 20000, now() - interval '1 day', mgr);

  sh := fn_open_depot_day(s, mgr, jsonb_build_array(jsonb_build_object('tank_id', tk, 'product_litres', 20000)));
  SELECT gross_litres INTO v_gross FROM dip_reading WHERE shift_id = sh AND context = 'SHIFT_OPEN';
  IF v_gross IS DISTINCT FROM 20000 THEN RAISE EXCEPTION 'OPENING_DIP_WRONG: gross %', v_gross; END IF;

  res := fn_close_depot_day(sh, mgr, jsonb_build_array(jsonb_build_object('tank_id', tk, 'product_litres', 20000)));
  SELECT state::text INTO v_state FROM shift WHERE id = sh;
  IF v_state = 'OPEN' THEN RAISE EXCEPTION 'DEPOT_DAY_STILL_OPEN after close: %', res; END IF;
END $body$;
$sql$);


-- =============================================================================
-- RESULTS
-- =============================================================================
-- Back to a readable table for the results themselves.
\pset tuples_only off
\pset format aligned

-- =============================================================================
-- WHAT THE APP ITSELF MAY DO (510)
-- Run as fcms_app, the role the API connects as. Three features deleted rows
-- the app had no DELETE privilege on, so each failed on first use -- and the
-- suite could not see it, because it runs as the superuser.
-- =============================================================================

-- Fixtures, as the superuser: a person here with a sign-in, a person at the
-- rival company with a sign-in, and a saved roster. No acting person, so the
-- appointment rule does not judge the fixtures themselves.
SELECT set_config('app.staff_id', '', true);
INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
  ('bf000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'SUP77', 'Revocable Supervisor', 'SUPERVISOR'),
  ('bf000000-0000-4000-8000-000000000002', '99999999-0000-4000-8000-000000000002', '99999999-0000-4000-8000-000000000003', 'RMGR', 'Rival Manager', 'MANAGER');
INSERT INTO staff_credential (staff_id, password_hash) VALUES
  ('bf000000-0000-4000-8000-000000000001', 'x'),
  ('bf000000-0000-4000-8000-000000000002', 'x');
INSERT INTO roster_template (id, tenant_id, site_id, name)
VALUES ('bf000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Weekday'),
       ('bf000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Rival roster');
INSERT INTO roster_template_line (template_id, nozzle_id, attendant_id)
VALUES ('bf000000-0000-4000-8000-000000000003', '66666666-6666-6666-6666-666666666666',
        '88888888-8888-8888-8888-888888888888');

SET LOCAL ROLE fcms_app;
-- (No acting person: the revoke rule's appointment check is tested in 77.)

SELECT test_allows('the app can re-save a roster (replace its lines)', $sql$
  DELETE FROM roster_template_line WHERE template_id = 'bf000000-0000-4000-8000-000000000003';
$sql$);

SELECT test_allows('the app can replace a calibration chart', $sql$
  DELETE FROM tank_calibration WHERE tank_id = '44444444-4444-4444-4444-444444444444';
$sql$);

SELECT test_allows('the app can revoke a sign-in at this company', $sql$
DO $body$
DECLARE n int;
BEGIN
  DELETE FROM staff_credential WHERE staff_id = 'bf000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'REVOKE_DID_NOTHING: % rows', n; END IF;
END $body$;
$sql$);

SELECT test_allows('another company''s sign-ins cannot be seen, revoked or unlocked', $sql$
DO $body$
DECLARE seen int; gone int; unlocked int;
BEGIN
  SELECT count(*) INTO seen FROM staff_credential WHERE staff_id = 'bf000000-0000-4000-8000-000000000002';
  DELETE FROM staff_credential WHERE staff_id = 'bf000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS gone = ROW_COUNT;
  UPDATE staff_credential SET locked_until = NULL WHERE staff_id = 'bf000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS unlocked = ROW_COUNT;
  IF seen + gone + unlocked <> 0 THEN
    RAISE EXCEPTION 'CROSS_TENANT_CREDENTIAL: saw %, deleted %, unlocked %', seen, gone, unlocked;
  END IF;
END $body$;
$sql$);

SELECT test_refuses('a roster line cannot name another company''s person', $sql$
  INSERT INTO roster_template_line (template_id, nozzle_id, attendant_id)
  VALUES ('bf000000-0000-4000-8000-000000000004', '66666666-6666-6666-6666-666666666666',
          'bf000000-0000-4000-8000-000000000002');
$sql$);

RESET ROLE;

-- =============================================================================
-- ONE STATION CANNOT WRITE ANOTHER'S RECORDS (530)
-- =============================================================================
SELECT set_config('app.staff_id', '', true);
INSERT INTO site (id, tenant_id, code, name, kind) VALUES
  ('bf100000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'OTHR', 'Other Station', 'STATION'),
  ('bf100000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'DEPX', 'Company Depot', 'DEPOT'),
  ('bf100000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'HOX',  'Test Head Office', 'HEAD_OFFICE');
INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
  ('bf100000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'bf100000-0000-4000-8000-000000000003',
   'ACCHO', 'Head Office Accountant', 'ACCOUNTANT');

-- Grace Supervisor works at the fixture station.
SELECT set_config('app.staff_id', '77777777-7777-7777-7777-777777777777', true);
SELECT test_refuses('a station supervisor cannot write another station''s records', $sql$
  INSERT INTO exception_flag (tenant_id, site_id, entity, entity_id, code, level) VALUES ('11111111-1111-1111-1111-111111111111', 'bf100000-0000-4000-8000-000000000001', 'test', 's1', 'SCOPE_TEST', 'WARN');
$sql$);
SELECT test_allows('a station supervisor writes their own station''s records', $sql$
  INSERT INTO exception_flag (tenant_id, site_id, entity, entity_id, code, level) VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'test', 's2', 'SCOPE_TEST', 'WARN');
$sql$);
SELECT test_allows('a station supervisor can still work the company depot', $sql$
  INSERT INTO exception_flag (tenant_id, site_id, entity, entity_id, code, level) VALUES ('11111111-1111-1111-1111-111111111111', 'bf100000-0000-4000-8000-000000000002', 'test', 's3', 'SCOPE_TEST', 'WARN');
$sql$);
SELECT set_config('app.staff_id', 'bf100000-0000-4000-8000-000000000004', true);
SELECT test_allows('someone based at head office can write any station''s records', $sql$
  INSERT INTO exception_flag (tenant_id, site_id, entity, entity_id, code, level) VALUES ('11111111-1111-1111-1111-111111111111', 'bf100000-0000-4000-8000-000000000001', 'test', 's4', 'SCOPE_TEST', 'WARN');
$sql$);
SELECT set_config('app.staff_id', '', true);

-- =============================================================================
-- DAY, MID AND NIGHT (570) -- the three shifts Kiboga runs, and nothing else
-- =============================================================================
SELECT test_allows('a MID shift pattern is accepted', $sql$
  INSERT INTO shift_pattern (tenant_id, site_id, label, starts_at, nominal_hours)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'MID', '10:00', 8);
$sql$);
SELECT test_refuses('an invented shift name (MORNING) is refused', $sql$
  INSERT INTO shift_pattern (tenant_id, site_id, label, starts_at, nominal_hours)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'MORNING', '06:00', 8);
$sql$);

\echo ''
\echo '=============================================================='
\echo 'FCMS INTEGRITY TESTS'
\echo '=============================================================='

SELECT lpad(id::text, 3) AS "#",
       CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       name, left(detail, 74) AS detail
  FROM test_result ORDER BY id;

SELECT count(*) FILTER (WHERE passed)       AS passed,
       count(*) FILTER (WHERE NOT passed)   AS failed,
       count(*)                             AS total
  FROM test_result;

DO $$
DECLARE v_failed int;
BEGIN
  SELECT count(*) INTO v_failed FROM test_result WHERE NOT passed;
  IF v_failed > 0 THEN
    RAISE EXCEPTION
      'INTEGRITY TESTS FAILED: % invariant(s) are not enforced. The schema '
      'does not guarantee what it claims -- do not deploy.', v_failed;
  END IF;
  RAISE NOTICE 'All invariants hold.';
END $$;

ROLLBACK;
