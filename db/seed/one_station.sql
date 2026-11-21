-- =============================================================================
-- FCMS v2 -- seed/one_station.sql
--
-- One working station, ready to open a shift against. Real shapes: a Kiboga
-- forecourt with PMS and AGO, four nozzles on two pumps, three attendants who
-- do not sign in, and a supervisor and manager who do.
--
-- Calibration charts here are LINEAR PLACEHOLDERS. A real tank's chart comes
-- from its calibration certificate and is not a straight line -- the ends of a
-- cylindrical tank are curved, so litres per millimetre changes with depth.
-- Replace these before the station trades, or every dip will be wrong in a way
-- that looks plausible.
-- =============================================================================

BEGIN;

-- Safe to re-run: if the station is already here, say so and stop rather than
-- producing thirty "current transaction is aborted" lines that bury the one
-- real message.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant
              WHERE id = '0a000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION
      'ALREADY_SEEDED: this station already exists. To start over:  '
      'dropdb fcms && createdb fcms && ./migrate.sh test  '
      'then re-run both seed files.';
  END IF;
END $guard$;

INSERT INTO tenant (id, name, country_code, base_currency, default_tz)
VALUES ('0a000000-0000-4000-8000-000000000001',
        'Kiboga Fuels Ltd','UG','UGX','Africa/Kampala');

INSERT INTO tenant_policy (tenant_id,
  shift_variance_pct, shift_variance_litres, cash_variance_alert)
VALUES ('0a000000-0000-4000-8000-000000000001', 0.50, 50.00, 20000);

SELECT set_config('app.tenant_id','0a000000-0000-4000-8000-000000000001', TRUE);

INSERT INTO site (id, tenant_id, code, name, ownership, timezone, day_starts_at)
VALUES ('0b000000-0000-4000-8000-000000000001',
        '0a000000-0000-4000-8000-000000000001',
        'KIB01','Kiboga Town Service Station','DODO','Africa/Kampala','06:00');

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
INSERT INTO product (id, tenant_id, code, name) VALUES
  ('0c000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001','PMS','Petrol'),
  ('0c000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001','AGO','Diesel');

-- ---------------------------------------------------------------------------
-- Tanks
-- ---------------------------------------------------------------------------
INSERT INTO tank (id, tenant_id, site_id, product_id, code,
                  nominal_litres, safe_fill, dead_stock, max_dip_mm, commissioned_on) VALUES
  ('0d000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-000000000001',
   'T1-PMS', 20000, 19000, 300, 2400,'2019-03-01'),
  ('0d000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-000000000002',
   'T2-AGO', 30000, 28500, 400, 2600,'2019-03-01');

-- PLACEHOLDER charts, 50mm steps. Replace from the certificates.
INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT '0a000000-0000-4000-8000-000000000001',
       '0d000000-0000-4000-8000-000000000001', g*50, round(g*50*7.9167, 2)
  FROM generate_series(0, 48) g;

INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT '0a000000-0000-4000-8000-000000000001',
       '0d000000-0000-4000-8000-000000000002', g*50, round(g*50*10.9615, 2)
  FROM generate_series(0, 52) g;

-- ---------------------------------------------------------------------------
-- Pumps and nozzles. Nozzles carry no product of their own -- they dispense
-- whatever their tank holds.
-- ---------------------------------------------------------------------------
INSERT INTO pump (id, tenant_id, site_id, code, make, serial_no) VALUES
  ('0e000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','P1','Gilbarco','GB-2019-4471'),
  ('0e000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','P2','Gilbarco','GB-2019-4472'),
  -- A single-nozzle pump. Nothing in the schema stores a nozzle count -- a
  -- pump has however many nozzle rows point at it, so 1, 2, 4 and 6 all just
  -- work without a special case anywhere.
  ('0e000000-0000-4000-8000-000000000003','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','P3','Wayne','WY-2021-0088');

INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code,
                    integer_digits, max_flow_lpm) VALUES
  ('0f000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000001','N1', 6, 45),
  ('0f000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000002','N2', 6, 45),
  ('0f000000-0000-4000-8000-000000000003','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-000000000001','N3', 6, 45),
  ('0f000000-0000-4000-8000-000000000004','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-000000000002','N4', 6, 45),

  -- P1 and P2 each carry FOUR nozzles: two on the petrol tank, two on the
  -- diesel tank. A pump mixing products is ordinary, and it works only because
  -- product lives on the TANK and is never set on the nozzle or the pump. A
  -- nozzle labelled petrol wired to the diesel tank is not a reporting
  -- inconvenience -- it is a wrecked engine and a claim.
  ('0f000000-0000-4000-8000-000000000005','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000001','N5', 6, 45),
  ('0f000000-0000-4000-8000-000000000006','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000002','N6', 6, 45),
  ('0f000000-0000-4000-8000-000000000007','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-000000000001','N7', 6, 45),
  ('0f000000-0000-4000-8000-000000000008','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000002',
   '0d000000-0000-4000-8000-000000000002','N8', 6, 45),

  -- P3, one nozzle, on the petrol tank. Note that BOTH tanks are now fed to
  -- nozzles on THREE different pumps. That is why wet stock reconciles by
  -- tank and never by pump: a per-pump total would miss the other pumps'
  -- litres and look perfectly reasonable doing it.
  ('0f000000-0000-4000-8000-000000000009','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000003',
   '0d000000-0000-4000-8000-000000000001','N9', 6, 40);

-- ---------------------------------------------------------------------------
-- People. Attendants have no credential row and never will.
-- ---------------------------------------------------------------------------
INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role, phone) VALUES
  ('10000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','MGR01','Sarah Nakato','MANAGER','+256700000001'),
  ('10000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','SUP01','Grace Auma','SUPERVISOR','+256700000002'),
  ('10000000-0000-4000-8000-000000000003','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','SUP02','David Okello','SUPERVISOR','+256700000003'),
  ('10000000-0000-4000-8000-000000000004','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','ACC01','Joseph Mubiru','ACCOUNTANT','+256700000004'),
  ('10000000-0000-4000-8000-000000000010','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','ATT01','Moses Kato','ATTENDANT','+256700000010'),
  ('10000000-0000-4000-8000-000000000011','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','ATT02','Peter Ssali','ATTENDANT','+256700000011'),
  ('10000000-0000-4000-8000-000000000012','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','ATT03','Alice Nabirye','ATTENDANT','+256700000012'),
  ('10000000-0000-4000-8000-000000000013','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','ATT04','John Wasswa','ATTENDANT','+256700000013');

-- ---------------------------------------------------------------------------
-- The organisation (migrations 230-290).
--
-- A company is run from a HEAD OFFICE, which trades nothing and appoints the
-- managers. A SYSTEM ADMINISTRATOR sits above it and creates companies. And
-- the station has TWO managers: one closes a shift, the other approves it --
-- a site with one manager can close but never approve its own shifts.
-- ---------------------------------------------------------------------------
UPDATE tenant
   SET legal_name = 'Kiboga Fuels Limited', registration_no = '80020001234567'
 WHERE id = '0a000000-0000-4000-8000-000000000001';

INSERT INTO site (id, tenant_id, code, name, kind, ownership, timezone, day_starts_at, address)
VALUES ('0b000000-0000-4000-8000-0000000000f0', '0a000000-0000-4000-8000-000000000001', 'HO', 'Kiboga Fuels Head Office', 'HEAD_OFFICE', 'COCO',
        'Africa/Kampala', '00:00', 'Plot 12, Kampala Road, Kiboga');

UPDATE tenant SET head_office_id = '0b000000-0000-4000-8000-0000000000f0' WHERE id = '0a000000-0000-4000-8000-000000000001';

INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role, phone) VALUES
  -- The platform. Rename freely; SYSADMIN is only a starting login.
  ('10000000-0000-4000-8000-0000000000a0', '0a000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-0000000000f0',
   'SYSADMIN', 'System Administrator', 'SYSTEM_ADMIN', '+256700000099'),
  -- Head office: appoints managers, approves any site's shifts.
  ('10000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-0000000000f0',
   'HO01', 'Ruth Namusoke', 'HEAD_OFFICE', '+256700000020'),
  -- The second manager, so the station can approve its own shifts.
  ('10000000-0000-4000-8000-000000000005', '0a000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000001',
   'MGR02', 'Paul Mugisha', 'MANAGER', '+256700000005');

-- The named manager: responsible for the station, set deliberately rather
-- than inferred from whoever holds the role there.
UPDATE site
   SET manager_id = '10000000-0000-4000-8000-000000000001',
       address = 'Kampala Road, Kiboga'
 WHERE id = '0b000000-0000-4000-8000-000000000001';

-- Kinds of non-fuel income. Migration 250 seeded these only for companies that
-- existed when it ran, and this one is created afterwards.
INSERT INTO income_category (tenant_id, code, name) VALUES
  ('0a000000-0000-4000-8000-000000000001', 'CARWASH', 'Car wash'),
  ('0a000000-0000-4000-8000-000000000001', 'TYRES',   'Tyre service'),
  ('0a000000-0000-4000-8000-000000000001', 'RENT',    'Rent received'),
  ('0a000000-0000-4000-8000-000000000001', 'PARKING', 'Parking'),
  ('0a000000-0000-4000-8000-000000000001', 'OTHER',   'Other income')
ON CONFLICT (tenant_id, code) DO NOTHING;

-- No credential rows here, on purpose.
--
-- A bcrypt hash written by hand into a SQL file is a hash nobody has verified.
-- The first version of this file shipped one, and it produced
-- "BCrypt.Net.SaltParseException: Invalid salt version" on the first login --
-- which reads like a bug in the application rather than a bad literal in a
-- fixture.
--
-- Set the operator passwords with the API instead, which generates a real hash:
--
--     cd ../api
--     dotnet run -- --set-password ALL 'ChangeMe123!'
--
-- Attendants never get a row here regardless: they do not sign in.

-- ---------------------------------------------------------------------------
-- Shift patterns
-- ---------------------------------------------------------------------------
INSERT INTO shift_pattern (tenant_id, site_id, label, starts_at, nominal_hours,
                           crosses_midnight) VALUES
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'DAY','06:00', 12, FALSE),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'NIGHT','18:00', 12, TRUE);

-- ---------------------------------------------------------------------------
-- Tenders. Cash, credit, discount and shortage are NOT channels -- each has its
-- own capture path with its own authorisation, so only real electronic tenders
-- appear here.
-- ---------------------------------------------------------------------------
INSERT INTO payment_channel (tenant_id, site_id, code, name, kind, till_number) VALUES
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'MTN_MOMO','MTN Mobile Money','MOBILE_MONEY','4471220'),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'AIRTEL','Airtel Money','MOBILE_MONEY','4471221'),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'VISA_MC','Visa / Mastercard','CARD', NULL),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   'FUEL_VOUCHER','Fuel Voucher','VOUCHER', NULL);

-- ---------------------------------------------------------------------------
-- Opening pump prices. `no_shift_to_break` is TRUE because the station has not
-- traded yet -- there is no shift to cut.
-- ---------------------------------------------------------------------------
INSERT INTO price_change (tenant_id, site_id, product_id, new_price,
  effective_from, source, status, authorised_by, no_shift_to_break, executed_at) VALUES
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   '0c000000-0000-4000-8000-000000000001', 5180, now() - interval '1 day',
   'OMC_DIRECTIVE','EXECUTED','10000000-0000-4000-8000-000000000001', TRUE,
   now() - interval '1 day'),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   '0c000000-0000-4000-8000-000000000002', 4990, now() - interval '1 day',
   'OMC_DIRECTIVE','EXECUTED','10000000-0000-4000-8000-000000000001', TRUE,
   now() - interval '1 day');

-- ---------------------------------------------------------------------------
-- Dry stock. LPG is two SKUs -- full out, empty in -- linked as an exchange pair.
-- ---------------------------------------------------------------------------
INSERT INTO dry_item (id, tenant_id, sku, name, category, sell_unit, pack_size,
                      is_cylinder, cylinder_state, deposit_amount, reorder_level) VALUES
  ('11000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   'HLX-HX5-4L','Shell Helix HX5 4L','LUBRICANT','EACH', 4, FALSE, NULL, 0, 12),
  ('11000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   'HLX-HX5-1L','Shell Helix HX5 1L','LUBRICANT','EACH', 1, FALSE, NULL, 0, 24),
  ('11000000-0000-4000-8000-000000000003','0a000000-0000-4000-8000-000000000001',
   'RIM-15W40-20L','Rimula R4 15W-40 20L','LUBRICANT','EACH', 20, FALSE, NULL, 0, 4),
  ('11000000-0000-4000-8000-000000000004','0a000000-0000-4000-8000-000000000001',
   'BRK-500ML','Brake Fluid DOT4 500ml','LUBRICANT','EACH', 0.5, FALSE, NULL, 0, 10),
  ('11000000-0000-4000-8000-000000000010','0a000000-0000-4000-8000-000000000001',
   'LPG-13KG-F','LPG Cylinder 13kg (full)','LPG','EACH', 13, TRUE,'FULL', 150000, 6),
  ('11000000-0000-4000-8000-000000000011','0a000000-0000-4000-8000-000000000001',
   'LPG-13KG-E','LPG Cylinder 13kg (empty)','LPG','EACH', 13, TRUE,'EMPTY', 0, 0),
  ('11000000-0000-4000-8000-000000000012','0a000000-0000-4000-8000-000000000001',
   'LPG-6KG-F','LPG Cylinder 6kg (full)','LPG','EACH', 6, TRUE,'FULL', 90000, 6),
  ('11000000-0000-4000-8000-000000000013','0a000000-0000-4000-8000-000000000001',
   'LPG-6KG-E','LPG Cylinder 6kg (empty)','LPG','EACH', 6, TRUE,'EMPTY', 0, 0),
  ('11000000-0000-4000-8000-000000000020','0a000000-0000-4000-8000-000000000001',
   'WTR-500ML','Drinking Water 500ml','SHOP','EACH', 1, FALSE, NULL, 0, 48),
  ('11000000-0000-4000-8000-000000000021','0a000000-0000-4000-8000-000000000001',
   'AIRTIME-5K','Airtime 5,000','SHOP','EACH', 1, FALSE, NULL, 0, 20);

UPDATE dry_item SET exchange_pair_id = '11000000-0000-4000-8000-000000000011'
 WHERE id = '11000000-0000-4000-8000-000000000010';
UPDATE dry_item SET exchange_pair_id = '11000000-0000-4000-8000-000000000010'
 WHERE id = '11000000-0000-4000-8000-000000000011';
UPDATE dry_item SET exchange_pair_id = '11000000-0000-4000-8000-000000000013'
 WHERE id = '11000000-0000-4000-8000-000000000012';
UPDATE dry_item SET exchange_pair_id = '11000000-0000-4000-8000-000000000012'
 WHERE id = '11000000-0000-4000-8000-000000000013';

INSERT INTO dry_price (tenant_id, site_id, item_id, unit_price, set_by)
SELECT '0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
       i.id, v.price, '10000000-0000-4000-8000-000000000001'
  FROM (VALUES
    ('11000000-0000-4000-8000-000000000001'::uuid, 68000),
    ('11000000-0000-4000-8000-000000000002'::uuid, 19000),
    ('11000000-0000-4000-8000-000000000003'::uuid, 285000),
    ('11000000-0000-4000-8000-000000000004'::uuid, 15000),
    ('11000000-0000-4000-8000-000000000010'::uuid, 62000),
    ('11000000-0000-4000-8000-000000000012'::uuid, 32000),
    ('11000000-0000-4000-8000-000000000020'::uuid, 1500),
    ('11000000-0000-4000-8000-000000000021'::uuid, 5000)
  ) v(item_id, price)
  JOIN dry_item i ON i.id = v.item_id;

-- Opening dry stock, as a ledger movement. Even day-one stock enters through
-- the ledger -- there is no other door.
INSERT INTO dry_movement (tenant_id, site_id, item_id, kind, qty, signed_qty,
                          unit_cost, note, recorded_by)
SELECT '0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
       v.item_id,'OPENING_BALANCE', v.qty, v.qty, v.cost,
       'Commissioning count','10000000-0000-4000-8000-000000000001'
  FROM (VALUES
    ('11000000-0000-4000-8000-000000000001'::uuid, 24, 52000),
    ('11000000-0000-4000-8000-000000000002'::uuid, 48, 14500),
    ('11000000-0000-4000-8000-000000000003'::uuid, 8, 228000),
    ('11000000-0000-4000-8000-000000000004'::uuid, 20, 11000),
    ('11000000-0000-4000-8000-000000000010'::uuid, 14, 48000),
    ('11000000-0000-4000-8000-000000000011'::uuid, 6, 0),
    ('11000000-0000-4000-8000-000000000012'::uuid, 10, 24000),
    ('11000000-0000-4000-8000-000000000013'::uuid, 4, 0),
    ('11000000-0000-4000-8000-000000000020'::uuid, 120, 900),
    ('11000000-0000-4000-8000-000000000021'::uuid, 40, 4850)
  ) v(item_id, qty, cost);

-- ---------------------------------------------------------------------------
-- Credit customers
-- ---------------------------------------------------------------------------
INSERT INTO credit_customer (id, tenant_id, site_id, code, name, contact_phone,
                             credit_limit, payment_terms_days) VALUES
  ('12000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','KIB-01','Kiboga District Farm',
   '+256700000101', 2000000, 30),
  ('12000000-0000-4000-8000-000000000002','0a000000-0000-4000-8000-000000000001',
   '0b000000-0000-4000-8000-000000000001','KIB-02','Nsamizi Transporters Ltd',
   '+256700000102', 5000000, 14);

INSERT INTO credit_vehicle (tenant_id, customer_id, plate_no, description) VALUES
  ('0a000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',
   'UAX 442J','Farm tipper'),
  ('0a000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002',
   'UBK 119Q','Fuso FN 10-tonne'),
  ('0a000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002',
   'UBL 806C','Fuso FN 10-tonne');

-- ---------------------------------------------------------------------------
-- Suppliers, and opening wet stock.
-- ---------------------------------------------------------------------------
INSERT INTO supplier (tenant_id, code, name, contact) VALUES
  ('0a000000-0000-4000-8000-000000000001','VIVO','Vivo Energy Uganda','+256414000000'),
  ('0a000000-0000-4000-8000-000000000001','TOTAL','TotalEnergies Uganda','+256414000001');

-- Commissioning stock. Same rule as dry: fuel enters through the ledger.
INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, kind,
                           litres, signed_litres, unit_cost, occurred_at, recorded_by) VALUES
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000001','0c000000-0000-4000-8000-000000000001',
   'OPENING_BALANCE', 12400, 12400, 4720, now() - interval '2 days',
   '10000000-0000-4000-8000-000000000001'),
  ('0a000000-0000-4000-8000-000000000001','0b000000-0000-4000-8000-000000000001',
   '0d000000-0000-4000-8000-000000000002','0c000000-0000-4000-8000-000000000002',
   'OPENING_BALANCE', 18900, 18900, 4560, now() - interval '2 days',
   '10000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Roster template: one tap assigns the whole forecourt.
-- ---------------------------------------------------------------------------
INSERT INTO roster_template (id, tenant_id, site_id, name, label)
VALUES ('13000000-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000001',
        '0b000000-0000-4000-8000-000000000001','Standard day','DAY');

INSERT INTO roster_template_line (template_id, nozzle_id, attendant_id) VALUES
  ('13000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000010'),
  ('13000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000011'),
  ('13000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000012'),
  ('13000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-000000000004',
   '10000000-0000-4000-8000-000000000013');

COMMIT;

\echo ''
\echo 'Seeded: Kiboga Town Service Station'
\echo '  2 tanks * 3 pumps * 9 nozzles * 2 products'
\echo '  P1 and P2 carry 4 nozzles each (2 PMS, 2 AGO); P3 carries 1'
\echo '  4 operators (login ChangeMe123!, forced change) * 4 attendants (no login)'
\echo '  10 dry SKUs * 2 credit customers * opening stock in both ledgers'
\echo ''
\echo 'Dips are entered in LITRES. The calibration charts below are kept only'
\echo 'for stations that record stick readings -- nothing in the close uses them.'
