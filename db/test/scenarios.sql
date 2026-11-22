-- =============================================================================
-- FCMS v2 -- test/scenarios.sql
--
-- The demo day, carried on through the REAL functions exactly as the API calls
-- them, as the app's own role -- the four things the demo leaves for a person
-- to do in the app. Every one of them was broken when first run this way:
--   * the delivery could never be received (it did not fit in the tank);
--   * the night shift could not be closed soon after seeding (implausible meter);
--   * a closed shift reported a 4,000 L hole (the demo's dips missed a transfer);
--   * the due price rise never reached the pumps (560).
-- Run AFTER the three seeds:  psql -d <db> -f db/test/scenarios.sql
-- Everything rolls back; the database is left as seeded.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SET LOCAL ROLE fcms_app;
\set T    '0a000000-0000-4000-8000-000000000001'
\set SITE '0b000000-0000-4000-8000-000000000001'
\set SUP  '10000000-0000-4000-8000-000000000002'
\set SUP2 '10000000-0000-4000-8000-000000000003'
\set MGR1 '10000000-0000-4000-8000-000000000001'
SELECT set_config('app.tenant_id', :'T', true) \gset

\echo '  scenario: yesterday''s day shift balanced, credit set against the right person'
DO $$
DECLARE peter_credit numeric; peter_short numeric; john_short numeric;
BEGIN
  SELECT -SUM(mm.amount) FILTER (WHERE mm.settlement = 'CREDIT'),
         COALESCE(-SUM(mm.amount) FILTER (WHERE mm.settlement = 'SHORTAGE'), 0)
    INTO peter_credit, peter_short
    FROM cash_up cu JOIN staff st ON st.id = cu.staff_id JOIN money_movement mm ON mm.cash_up_id = cu.id
    JOIN shift sh ON sh.id = cu.shift_id
   WHERE sh.label = 'DAY' AND st.full_name = 'Peter Ssali';
  SELECT COALESCE(-SUM(mm.amount) FILTER (WHERE mm.settlement = 'SHORTAGE'), 0) INTO john_short
    FROM cash_up cu JOIN staff st ON st.id = cu.staff_id JOIN money_movement mm ON mm.cash_up_id = cu.id
    JOIN shift sh ON sh.id = cu.shift_id
   WHERE sh.label = 'DAY' AND st.full_name = 'John Wasswa';
  IF peter_credit IS DISTINCT FROM 1097800 OR peter_short <> 0 THEN
    RAISE EXCEPTION 'SCENARIO: Peter credited % with % short; expected 1,097,800 and none (520)', peter_credit, peter_short;
  END IF;
  IF john_short <> 40000 THEN RAISE EXCEPTION 'SCENARIO: John short %, expected the seeded 40,000', john_short; END IF;
END $$;

\echo '  scenario: the demo raises no false stock alarm'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM exception_flag WHERE code = 'STOCK_VARIANCE' AND abs((detail->>'variance_litres')::numeric) > 100) THEN
    RAISE EXCEPTION 'SCENARIO: a stock variance over 100 L on demo data -- the dips and the ledger disagree';
  END IF;
END $$;

\echo '  scenario: fuel carries a real cost (540)'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tank t JOIN site s ON s.id = t.site_id
              WHERE s.tenant_id = '0a000000-0000-4000-8000-000000000001'
                AND COALESCE(fn_weighted_avg_cost(t.id), 0) <= 0) THEN
    RAISE EXCEPTION 'SCENARIO: a tank has no cost basis -- its sales would read as pure margin';
  END IF;
  IF EXISTS (SELECT 1 FROM fuel_movement WHERE kind = 'BULK_IN' AND COALESCE(unit_cost, 0) <= 0) THEN
    RAISE EXCEPTION 'SCENARIO: fuel transferred in at no cost';
  END IF;
END $$;

\echo '  scenario: receive the waiting delivery'
\set T  '0a000000-0000-4000-8000-000000000001'
\set SUP '10000000-0000-4000-8000-000000000002'
SELECT set_config('app.staff_id', :'SUP', true) \gset
SELECT id AS dlv FROM delivery WHERE delivery_note_no = 'DN-88213' \gset
SELECT id AS shf FROM shift WHERE state = 'OPEN' \gset
SELECT '0d000000-0000-4000-8000-000000000001' AS tank \gset
SELECT round(fn_book_stock(:'tank'), 1) AS book \gset
INSERT INTO dip_reading (tenant_id, site_id, tank_id, context, dip_mm, water_dip_mm, product_litres, water_litres, gross_litres, evidence, recorded_by, captured_at)
SELECT :'T', t.site_id, t.id, 'PRE_DELIVERY', NULL, 0, :book, 0, :book, 'PENDING', :'SUP', now() FROM tank t WHERE t.id = :'tank' RETURNING id AS d1 \gset
INSERT INTO dip_reading (tenant_id, site_id, tank_id, context, dip_mm, water_dip_mm, product_litres, water_litres, gross_litres, evidence, recorded_by, captured_at)
SELECT :'T', t.site_id, t.id, 'POST_DELIVERY', NULL, 0, :book + 3990, 0, :book + 3990, 'PENDING', :'SUP', now() FROM tank t WHERE t.id = :'tank' RETURNING id AS d2 \gset
UPDATE delivery_line SET dip_before_id = :d1, dip_after_id = :d2,
       received_litres = (SELECT product_litres FROM dip_reading WHERE id = :d2) - (SELECT product_litres FROM dip_reading WHERE id = :d1)
 WHERE delivery_id = :'dlv' AND tank_id = :'tank';
UPDATE delivery SET seals_intact = true, decant_ended_at = now(), status = 'DECANTING' WHERE id = :'dlv';
SELECT fn_receive_delivery(:'dlv', :'shf', :'SUP')::text AS result;

DO $$
DECLARE st text; got numeric; cost numeric;
BEGIN
  SELECT d.status, dl.received_litres INTO st, got FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id
   WHERE d.delivery_note_no = 'DN-88213';
  SELECT unit_cost INTO cost FROM fuel_movement WHERE kind = 'DELIVERY_IN';
  IF st <> 'RECEIVED' OR got <> 3990 OR cost <> 4735 THEN
    RAISE EXCEPTION 'SCENARIO: delivery % with % L at %; expected RECEIVED, 3,990 at 4,735', st, got, cost;
  END IF;
END $$;

\echo '  scenario: cash is dropped to the safe during the night, witnessed (580)'
SELECT set_config('app.staff_id', '10000000-0000-4000-8000-000000000003', true) \gset
SELECT id AS shf FROM shift WHERE state = 'OPEN' \gset
-- Two real drops by attendant 13, and one typed wrong and voided.
SELECT fn_record_cash_drop(:'shf', '10000000-0000-4000-8000-000000000013', 1000000,
       '10000000-0000-4000-8000-000000000003', 'DB p.14 l.1', '10000000-0000-4000-8000-000000000003') IS NOT NULL AS ok \gset
SELECT fn_record_cash_drop(:'shf', '10000000-0000-4000-8000-000000000013', 50000,
       '10000000-0000-4000-8000-000000000003', NULL, '10000000-0000-4000-8000-000000000003') AS bad_drop \gset
SELECT fn_void_cash_drop(:'bad_drop', 'typed 50,000 for 500,000', '10000000-0000-4000-8000-000000000003');
SELECT fn_record_cash_drop(:'shf', '10000000-0000-4000-8000-000000000013', 1000000,
       '10000000-0000-4000-8000-000000000003', 'DB p.14 l.3', '10000000-0000-4000-8000-000000000003') IS NOT NULL AS ok \gset
DO $$
DECLARE v_shf uuid := (SELECT id FROM shift WHERE state = 'OPEN');
BEGIN
  BEGIN
    PERFORM fn_record_cash_drop(v_shf, '10000000-0000-4000-8000-000000000013', 10000,
      '10000000-0000-4000-8000-000000000013', NULL, '10000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'SCENARIO: an attendant witnessed their own drop';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM fn_record_cash_drop(v_shf, '10000000-0000-4000-8000-000000000013', 10000,
      '10000000-0000-4000-8000-000000000011', NULL, '10000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'SCENARIO: another attendant was accepted as witness';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE cash_drop SET amount = 1 WHERE shift_id = v_shf AND seq_no = 1;
    RAISE EXCEPTION 'SCENARIO: a cash drop was edited';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT array_agg(seq_no ORDER BY seq_no) FROM cash_drop WHERE shift_id = v_shf) <> ARRAY[1,2,3] THEN
    RAISE EXCEPTION 'SCENARIO: drops are not numbered 1, 2, 3';
  END IF;
END $$;

\echo '  scenario: close the night shift; everyone who handed in what they owed balances'
\set T  '0a000000-0000-4000-8000-000000000001'
\set SUP2 '10000000-0000-4000-8000-000000000003'
SELECT set_config('app.staff_id', :'SUP2', true) \gset
SELECT id AS shf FROM shift WHERE state = 'OPEN' \gset
SELECT round(fn_book_stock('0d000000-0000-4000-8000-000000000001'), 1) - 600 AS dip_pms,
       round(fn_book_stock('0d000000-0000-4000-8000-000000000002'), 1) - 700 AS dip_ago \gset
SELECT fn_close_shift(:'shf', :'SUP2', 'SCHEDULED',
  (SELECT jsonb_agg(jsonb_build_object('assignment_id', na.id, 'is_rollover', false,
     'volume_totalizer', (SELECT volume_totalizer FROM meter_reading mr WHERE mr.assignment_id = na.id AND mr.is_opening)
        + CASE n.code WHEN 'N1' THEN 400 WHEN 'N2' THEN 300 WHEN 'N3' THEN 200 ELSE 400 END, 'electronic_totalizer', (SELECT volume_totalizer FROM meter_reading mr WHERE mr.assignment_id = na.id AND mr.is_opening)
        + CASE n.code WHEN 'N1' THEN 400 WHEN 'N2' THEN 300 WHEN 'N3' THEN 200 ELSE 400 END))
     FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id WHERE na.shift_id = :'shf' AND na.state = 'ACTIVE'),
  jsonb_build_array(
    jsonb_build_object('tank_id', '0d000000-0000-4000-8000-000000000001', 'product_litres', :dip_pms, 'water_litres', 0),
    jsonb_build_object('tank_id', '0d000000-0000-4000-8000-000000000002', 'product_litres', :dip_ago, 'water_litres', 0)),
  jsonb_build_array(
    -- 13 dropped 2,000,000 during the night, so holds only the rest at close (580)
    jsonb_build_object('attendant_id', '10000000-0000-4000-8000-000000000013', 'cash', 400 * 5180 - 2000000, 'tenders', '[]'::jsonb),
    jsonb_build_object('attendant_id', '10000000-0000-4000-8000-000000000011', 'cash', 200 * 5180, 'tenders', '[]'::jsonb),
    jsonb_build_object('attendant_id', '10000000-0000-4000-8000-000000000012', 'cash', 1000000,
                       'tenders', jsonb_build_array(jsonb_build_object('channel_code', 'MTN_MOMO', 'amount', 497000, 'reference', 'MP99'))),
    jsonb_build_object('attendant_id', '10000000-0000-4000-8000-000000000010', 'cash', 400 * 4990, 'tenders', '[]'::jsonb))
)::text AS result;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM money_movement mm JOIN shift sh ON sh.id = mm.shift_id
              WHERE sh.label = 'NIGHT' AND mm.settlement IN ('SHORTAGE', 'OVERAGE')) THEN
    RAISE EXCEPTION 'SCENARIO: a night cash-up did not balance though every attendant handed in exactly what they owed';
  END IF;
  IF EXISTS (SELECT 1 FROM exception_flag ef JOIN shift sh ON sh.id = ef.shift_id
              WHERE sh.label = 'NIGHT' AND ef.code = 'STOCK_VARIANCE' AND ef.level = 'CRITICAL') THEN
    RAISE EXCEPTION 'SCENARIO: a few litres of dip noise raised a CRITICAL stock variance (550)';
  END IF;
  -- (580) the drops settled as cash, the void did not. (590) The flag is the
  -- most an attendant CARRIED -- their largest drop or the cash at close: 10,
  -- 11 and 12 never dropped, and 13 walked a million at a time to the safe.
  -- All four are over the 500,000 cap. Hourly drops are proved by the demo
  -- day (no flag) and the simulator (tools/sim).
  IF (SELECT count(*) FROM money_movement mm JOIN shift sh ON sh.id = mm.shift_id
       WHERE sh.label = 'NIGHT' AND mm.reference LIKE 'DROP %' AND mm.settlement = 'CASH') <> 2 THEN
    RAISE EXCEPTION 'SCENARIO: two live drops should settle as two cash lines';
  END IF;
  IF (SELECT array_agg((ef.detail->>'attendant_id') ORDER BY (ef.detail->>'attendant_id')) FROM exception_flag ef
        JOIN shift sh ON sh.id = ef.shift_id
       WHERE sh.label = 'NIGHT' AND ef.code = 'CASH_HELD_OVER_CAP')
     IS DISTINCT FROM ARRAY['10000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000011',
                            '10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000013'] THEN
    RAISE EXCEPTION 'SCENARIO: over-cap flags were %', (SELECT array_agg((ef.detail->>'attendant_id') || ':' || (ef.detail->>'held_at_close') || ':' || sh.label) FROM exception_flag ef JOIN shift sh ON sh.id = ef.shift_id WHERE ef.code = 'CASH_HELD_OVER_CAP');
  END IF;
END $$;

\echo '  scenario: a supervisor cannot approve; the manager can'
SELECT set_config('app.staff_id', :'SUP', true) \gset
DO $$
BEGIN
  BEGIN
    UPDATE shift SET state = 'APPROVED', approved_by = '10000000-0000-4000-8000-000000000002', approved_at = now()
     WHERE label = 'NIGHT' AND state = 'DECLARED';
    RAISE EXCEPTION 'SCENARIO_FAIL: a supervisor approved a shift';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SELECT set_config('app.staff_id', :'MGR1', true) \gset
UPDATE shift SET state = 'APPROVED', approved_by = :'MGR1', approved_at = now()
 WHERE label = 'NIGHT' AND state = 'DECLARED';
DO $$ BEGIN
  IF (SELECT state FROM shift WHERE label = 'NIGHT') <> 'APPROVED' THEN RAISE EXCEPTION 'SCENARIO: the manager could not approve'; END IF;
END $$;

\echo '  scenario: the next shift sells at the price that fell due (560)'
SELECT set_config('app.staff_id', :'SUP', true) \gset
SELECT fn_open_shift(:'SITE', 'DAY', :'SUP',
  jsonb_build_array(
    jsonb_build_object('tank_id', '0d000000-0000-4000-8000-000000000001', 'product_litres', round(fn_book_stock('0d000000-0000-4000-8000-000000000001'), 1)),
    jsonb_build_object('tank_id', '0d000000-0000-4000-8000-000000000002', 'product_litres', round(fn_book_stock('0d000000-0000-4000-8000-000000000002'), 1))),
  (SELECT jsonb_agg(jsonb_build_object('nozzle_id', n.id, 'attendant_id', '10000000-0000-4000-8000-000000000010',
          'volume_totalizer', (SELECT max(volume_totalizer) FROM meter_reading mr WHERE mr.nozzle_id = n.id), 'electronic_totalizer', (SELECT max(volume_totalizer) FROM meter_reading mr WHERE mr.nozzle_id = n.id)))
     FROM nozzle n WHERE n.code = 'N1' AND n.site_id = :'SITE'),
  NULL, NULL) AS new_shift \gset
DO $$
DECLARE v numeric; st text;
BEGIN
  SELECT fn_shift_price(sh.id, p.id) INTO v
    FROM shift sh JOIN product p ON p.tenant_id = sh.tenant_id AND p.code = 'PMS'
   WHERE sh.state = 'OPEN' AND sh.site_id = '0b000000-0000-4000-8000-000000000001';
  SELECT status INTO st FROM price_change WHERE old_price = 5180 AND new_price = 5240;
  IF v IS DISTINCT FROM 5240 OR st <> 'EXECUTED' THEN
    RAISE EXCEPTION 'SCENARIO: the new shift sells PMS at % (change %), not the 5,240 that fell due', v, st;
  END IF;
END $$;

\echo '  scenario: an agreed customer price is set by a manager and billed (600)'
DO $$
DECLARE
  v_shift uuid := (SELECT id FROM shift WHERE state = 'OPEN' AND site_id = '0b000000-0000-4000-8000-000000000001');
  v_cp uuid; v_id uuid; v_pump numeric;
  c_kib2 uuid := '12000000-0000-4000-8000-000000000002';
  c_kib1 uuid := '12000000-0000-4000-8000-000000000001';
  c_pms  uuid := '0c000000-0000-4000-8000-000000000001';
  c_n1   uuid := '0f000000-0000-4000-8000-000000000001';
  c_att  uuid := '10000000-0000-4000-8000-000000000010';
  c_sup  uuid := '10000000-0000-4000-8000-000000000002';
  c_mgr  uuid := '10000000-0000-4000-8000-000000000001';
  c_t    uuid := '0a000000-0000-4000-8000-000000000001';
  c_site uuid := '0b000000-0000-4000-8000-000000000001';
BEGIN
  -- A supervisor cannot agree a price.
  BEGIN
    INSERT INTO customer_price (tenant_id, customer_id, product_id, price, reason, authorised_by)
    VALUES (c_t, c_kib2, c_pms, 5200, 'Volume deal', c_sup);
    RAISE EXCEPTION 'SCENARIO: a supervisor set an agreed price';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  INSERT INTO customer_price (tenant_id, customer_id, product_id, price, reason, authorised_by)
  VALUES (c_t, c_kib2, c_pms, 5200, 'Volume deal, signed contract', c_mgr) RETURNING id INTO v_cp;

  -- One agreement at a time for a customer and grade.
  BEGIN
    INSERT INTO customer_price (tenant_id, customer_id, product_id, price, reason, authorised_by)
    VALUES (c_t, c_kib2, c_pms, 5100, 'A second deal', c_mgr);
    RAISE EXCEPTION 'SCENARIO: two agreements overlapped';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Billing the pump price to a customer with an agreement is refused...
  BEGIN
    INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, staff_id, attendant_id, nozzle_id,
                             product_id, litres, unit_price, amount)
    VALUES (c_t, c_site, v_shift, c_kib2, c_sup, c_att, c_n1, c_pms, 100, 5240, 524000);
    RAISE EXCEPTION 'SCENARIO: the pump price was billed over an agreement';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- ...and so is an agreed price for a customer without one.
  BEGIN
    INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, staff_id, attendant_id, nozzle_id,
                             product_id, litres, unit_price, amount)
    VALUES (c_t, c_site, v_shift, c_kib1, c_sup, c_att, c_n1, c_pms, 100, 5200, 520000);
    RAISE EXCEPTION 'SCENARIO: a customer with no agreement was billed below the pump';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, staff_id, attendant_id, nozzle_id,
                           product_id, litres, unit_price, amount, customer_price_id)
  VALUES (c_t, c_site, v_shift, c_kib2, c_sup, c_att, c_n1, c_pms, 100, 5200, 520000, v_cp)
  RETURNING id, pump_price INTO v_id, v_pump;
  IF v_pump <> 5240 THEN RAISE EXCEPTION 'SCENARIO: pump price stored as %, not 5,240', v_pump; END IF;

  -- An agreement is never edited; it is ended.
  BEGIN
    UPDATE customer_price SET price = 5000 WHERE id = v_cp;
    RAISE EXCEPTION 'SCENARIO: an agreed price was edited';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE customer_price SET valid_to = now() + interval '1 second', ended_by = c_mgr WHERE id = v_cp;

  -- A margin follows the pump: KIB-01 on "pump + 80" pays 5,320 at 5,240.
  INSERT INTO customer_price (tenant_id, customer_id, product_id, margin, reason, authorised_by)
  VALUES (c_t, c_kib1, c_pms, 80, 'Credit terms: pump + 80', c_mgr) RETURNING id INTO v_cp;
  IF (SELECT price FROM fn_customer_price(c_kib1, c_pms, 5240)) <> 5320 THEN
    RAISE EXCEPTION 'SCENARIO: pump + 80 at 5,240 is not 5,320';
  END IF;
  BEGIN
    INSERT INTO customer_price (tenant_id, customer_id, product_id, price, margin, reason, authorised_by)
    VALUES (c_t, c_kib2, '0c000000-0000-4000-8000-000000000002', 5000, 50, 'Both', c_mgr);
    RAISE EXCEPTION 'SCENARIO: an agreement had a price AND a margin';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

\echo '  scenario: the books -- written only by their functions, balanced, never edited (610/620)'
DO $$
DECLARE
  c_t   uuid := '0a000000-0000-4000-8000-000000000001';
  c_sup uuid := '10000000-0000-4000-8000-000000000002';
  c_mgr uuid := '10000000-0000-4000-8000-000000000001';
  v_j uuid; v_r uuid; v_acct uuid;
BEGIN
  -- Every closed shift is in the books, and the books balance.
  IF EXISTS (SELECT 1 FROM shift sh WHERE sh.state IN ('DECLARED', 'APPROVED')
               AND NOT EXISTS (SELECT 1 FROM gl_journal j WHERE j.source = 'shift' AND j.source_id = sh.id::text)) THEN
    RAISE EXCEPTION 'SCENARIO: a closed shift never reached the books';
  END IF;
  IF (SELECT SUM(amount) FROM gl_line) <> 0 THEN RAISE EXCEPTION 'SCENARIO: the books do not balance'; END IF;
  -- As of the business day in Kampala, as the API asks (BooksService.Today,
  -- UTC+3). current_date on a UTC server is still yesterday from midnight to
  -- 03:00 in Kampala, so this failed for three hours every night. (T2)
  IF EXISTS (SELECT 1 FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date) WHERE ok = FALSE) THEN
    RAISE EXCEPTION 'SCENARIO: controls differ: %', (SELECT string_agg(control || ' ' || detail, '; ')
                                                      FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date) WHERE ok = FALSE);
  END IF;

  -- The app cannot write the books itself...
  SELECT id INTO v_acct FROM gl_account WHERE code = '1010';
  BEGIN
    INSERT INTO gl_journal (tenant_id, posting_date, event_at, source, memo) VALUES (c_t, current_date, now(), 'x', 'x');
    RAISE EXCEPTION 'SCENARIO: the app wrote a journal directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- ...nor change them.
  BEGIN
    UPDATE gl_journal SET memo = 'changed' WHERE id = (SELECT id FROM gl_journal LIMIT 1);
    RAISE EXCEPTION 'SCENARIO: a journal was edited';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  -- A manual journal: not by a supervisor; not unbalanced; by a manager, yes.
  -- (650) each actor is the signed-in user, so each signs in first.
  PERFORM set_config('app.staff_id', c_sup::text, true);
  BEGIN
    PERFORM fn_gl_manual_journal(NULL, current_date, 'Bank charges for October',
      '[{"code":"6100","amount":15000},{"code":"1010","amount":-15000}]', c_sup);
    RAISE EXCEPTION 'SCENARIO: a supervisor posted a manual journal';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('app.staff_id', c_mgr::text, true);
  BEGIN
    PERFORM fn_gl_manual_journal(NULL, current_date, 'Bank charges for October',
      '[{"code":"6100","amount":15000},{"code":"1010","amount":-14000}]', c_mgr);
    SET CONSTRAINTS gl_line_balanced IMMEDIATE;
    RAISE EXCEPTION 'SCENARIO: an unbalanced journal was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SET CONSTRAINTS gl_line_balanced DEFERRED;
  v_j := fn_gl_manual_journal(NULL, current_date, 'Bank charges for October',
    '[{"code":"6100","amount":15000},{"code":"1010","amount":-15000}]', c_mgr);

  -- A reversal: not a manager's (accountant or head office, as the API says);
  -- it mirrors the journal line for line; a second is refused.
  BEGIN
    PERFORM fn_gl_reverse(v_j, 'posted to the wrong month', c_mgr);
    RAISE EXCEPTION 'SCENARIO: a manager reversed a journal';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('app.staff_id', '10000000-0000-4000-8000-000000000004', true);
  v_r := fn_gl_reverse(v_j, 'posted to the wrong month', '10000000-0000-4000-8000-000000000004');
  IF (SELECT SUM(l.amount) FROM gl_line l WHERE l.journal_id IN (v_j, v_r) AND l.account_id = v_acct) <> 0 THEN
    RAISE EXCEPTION 'SCENARIO: the reversal did not undo the bank line';
  END IF;
  BEGIN
    PERFORM fn_gl_reverse(v_j, 'again', '10000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'SCENARIO: a journal was reversed twice';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Closing a month: not a supervisor's, and not with a shift still open.
  PERFORM set_config('app.staff_id', c_sup::text, true);
  BEGIN
    PERFORM fn_gl_close_period(current_date, c_sup);
    RAISE EXCEPTION 'SCENARIO: a supervisor closed a month';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- (650) the books act only as the signed-in user: sign in as the accountant.
  PERFORM set_config('app.staff_id', '10000000-0000-4000-8000-000000000004', true);
  BEGIN
    PERFORM fn_gl_close_period(current_date, '10000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'SCENARIO: a month closed with a shift still open';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

\echo '  scenario: a depot day closes 120 L short and the books show the loss (610)'
DO $$
DECLARE
  c_site uuid := '0b000000-0000-4000-8000-000000000002';
  c_tank uuid := '0d000000-0000-4000-8000-00000000d001';
  c_mgr  uuid := '10000000-0000-4000-8000-000000000001';
  v_qty numeric; v_avg numeric; v_day uuid; v_loss numeric;
BEGIN
  PERFORM set_config('app.staff_id', c_mgr::text, true);
  v_qty := fn_gl_tank_qty(c_tank);
  v_avg := fn_gl_tank_avg(c_tank);
  v_day := fn_open_depot_day(c_site, c_mgr, jsonb_build_array(
             jsonb_build_object('tank_id', c_tank, 'product_litres', v_qty),
             jsonb_build_object('tank_id', '0d000000-0000-4000-8000-00000000d002',
                                'product_litres', fn_gl_tank_qty('0d000000-0000-4000-8000-00000000d002'))));
  PERFORM fn_close_depot_day(v_day, c_mgr, jsonb_build_array(
             jsonb_build_object('tank_id', c_tank, 'product_litres', v_qty - 120,
                                'variance_reason', 'Gantry meter drift, under investigation'),
             jsonb_build_object('tank_id', '0d000000-0000-4000-8000-00000000d002',
                                'product_litres', fn_gl_tank_qty('0d000000-0000-4000-8000-00000000d002'))));
  -- The day is in the books, the tank is at its dip, and the loss is costed.
  SELECT SUM(l.amount) INTO v_loss FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id
    JOIN gl_account a ON a.id = l.account_id
   WHERE j.source = 'shift' AND j.source_id = v_day::text AND a.code = '5100';
  IF v_loss IS DISTINCT FROM round(120 * v_avg, 2) THEN
    RAISE EXCEPTION 'SCENARIO: depot loss posted as %, expected %', v_loss, round(120 * v_avg, 2);
  END IF;
  IF fn_gl_tank_qty(c_tank) <> v_qty - 120 THEN
    RAISE EXCEPTION 'SCENARIO: depot tank at % L in the books, dip says %', fn_gl_tank_qty(c_tank), v_qty - 120;
  END IF;
  PERFORM set_config('app.staff_id', '10000000-0000-4000-8000-000000000002', true);
END $$;

ROLLBACK;
\echo ''
\echo '  ALL SCENARIOS PASS: receive, close, approve, re-open at the new price, agreed prices, the books, a depot day.'
