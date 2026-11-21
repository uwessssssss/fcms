-- =============================================================================
-- tools/replay/kiboga_station_seed.sql -- Kiboga station as its workbook shows it.
--
-- Shape from the October 2026 workbook: tanks for PMS, AGO and BIK (30,000 L
-- each on the sheet headers); pump 1 carries PMS 1-2, AGO 1-2 and BIK 1-2,
-- pump 2 carries PMS 3-4 and AGO 3-4. People are ROLES, not names: the
-- workbook records one cash-up for the whole station per day, so one
-- "forecourt team" attendant holds every nozzle.
--
-- Costs here are PLACEHOLDERS -- the workbook carries no purchase costs --
-- so the replay reconciles litres and money, not margins.
-- =============================================================================
BEGIN;
INSERT INTO tenant (id, name, country_code, base_currency, default_tz)
VALUES ('a0000000-0000-4000-8000-000000000001', 'Astro Investments (Kiboga replay)', 'UG', 'UGX', 'Africa/Kampala');
-- attendant_cash_cap 0: the workbook records no cash drops, so the check
-- would fire on every day and say nothing.
-- max_shortage_carry high: one "team" attendant carries the whole station's
-- shortages, which no single person would.
INSERT INTO tenant_policy (tenant_id, shift_variance_pct, shift_variance_litres, cash_variance_alert, attendant_cash_cap,
                           max_shortage_carry)
VALUES ('a0000000-0000-4000-8000-000000000001', 0.50, 50.00, 20000, 0, 100000000);
SELECT set_config('app.tenant_id', 'a0000000-0000-4000-8000-000000000001', TRUE);

INSERT INTO site (id, tenant_id, code, name, ownership, timezone, day_starts_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'KIB', 'Kiboga Station', 'DODO', 'Africa/Kampala', '06:00');

INSERT INTO product (id, tenant_id, code, name) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'PMS', 'Petrol'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'AGO', 'Diesel'),
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'BIK', 'Kerosene');

INSERT INTO tank (id, tenant_id, site_id, product_id, code, nominal_litres, safe_fill, dead_stock, max_dip_mm) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001', 'T1-PMS', 30000, 29000, 300, 3000),
  ('a3000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000002', 'T2-AGO', 30000, 29000, 300, 3000),
  ('a3000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000003', 'T3-BIK', 30000, 29000, 300, 3000);
-- The sheets dip in LITRES; a linear chart only so millimetres are possible.
INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
SELECT 'a0000000-0000-4000-8000-000000000001', t, g * 50, g * 500
  FROM unnest(ARRAY['a3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002',
                    'a3000000-0000-4000-8000-000000000003']::uuid[]) t, generate_series(0, 60) g;

INSERT INTO pump (id, tenant_id, site_id, code) VALUES
  ('a4000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'P1'),
  ('a4000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'P2');
INSERT INTO nozzle (id, tenant_id, site_id, pump_id, tank_id, code, integer_digits, max_flow_lpm)
SELECT v.id::uuid, 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
       ('a4000000-0000-4000-8000-00000000000' || v.pump)::uuid,
       ('a3000000-0000-4000-8000-00000000000' || v.tank)::uuid, v.code, 6, 60
  FROM (VALUES ('a5000000-0000-4000-8000-000000000001', 'PMS1', 1, 1), ('a5000000-0000-4000-8000-000000000002', 'PMS2', 1, 1),
               ('a5000000-0000-4000-8000-000000000003', 'PMS3', 2, 1), ('a5000000-0000-4000-8000-000000000004', 'PMS4', 2, 1),
               ('a5000000-0000-4000-8000-000000000005', 'AGO1', 1, 2), ('a5000000-0000-4000-8000-000000000006', 'AGO2', 1, 2),
               ('a5000000-0000-4000-8000-000000000007', 'AGO3', 2, 2), ('a5000000-0000-4000-8000-000000000008', 'AGO4', 2, 2),
               ('a5000000-0000-4000-8000-000000000009', 'BIK1', 1, 3), ('a5000000-0000-4000-8000-000000000010', 'BIK2', 1, 3))
       AS v(id, code, pump, tank);

INSERT INTO staff (id, tenant_id, site_id, employee_no, full_name, role) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'MGR', 'Station manager', 'MANAGER'),
  ('a6000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'SUP', 'Shift supervisor', 'SUPERVISOR'),
  ('a6000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'TEAM', 'Forecourt team (all attendants)', 'ATTENDANT');

INSERT INTO payment_channel (tenant_id, site_id, code, name, kind) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'MTN_MOMO', 'MTN Mobile Money', 'MOBILE_MONEY'),
  ('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'AIRTEL', 'Airtel Money', 'MOBILE_MONEY');

INSERT INTO supplier (tenant_id, code, name) VALUES ('a0000000-0000-4000-8000-000000000001', 'DEPOT', 'Kiboga Depot (Astro Investments)');
COMMIT;
