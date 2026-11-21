-- =============================================================================
-- FCMS -- the simulated months, checked.  psql -d fcms_sim -f tools/sim/check.sql
--
-- Hard checks raise and stop. Figures are printed for a person to read.
-- =============================================================================
\set ON_ERROR_STOP 1
\pset footer off

\echo ''
\echo '== hard checks'
DO $$
DECLARE n bigint; v numeric;
BEGIN
  -- Every shift closed and signed off.
  SELECT count(*) INTO n FROM shift WHERE state NOT IN ('APPROVED');
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % shift(s) not approved', n; END IF;

  -- Every cash-up balances to the shilling: sales = settlements.
  SELECT count(*) INTO n FROM (SELECT cash_up_id FROM money_movement GROUP BY 1 HAVING abs(SUM(amount)) > 0.005) x;
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % cash-up(s) do not balance', n; END IF;

  -- Every live drop settled as cash, once.
  SELECT abs((SELECT COALESCE(SUM(amount), 0) FROM cash_drop WHERE voided_at IS NULL)
           + (SELECT COALESCE(SUM(amount), 0) FROM money_movement WHERE reference LIKE 'DROP %'))
    INTO v;
  IF v > 0.005 THEN RAISE EXCEPTION 'SIM: drops and their cash settlements differ by %', v; END IF;

  -- Every litre that came in carries a cost.
  SELECT count(*) INTO n FROM fuel_movement
   WHERE kind IN ('DELIVERY_IN', 'BULK_IN', 'OPENING_BALANCE') AND COALESCE(unit_cost, 0) <= 0;
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % fuel receipt(s) at no cost', n; END IF;

  -- No tank below empty in the books.
  SELECT count(*) INTO n FROM tank t WHERE fn_book_stock(t.id) < 0;
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % tank(s) negative in the books', n; END IF;

  -- Shortages raised are exactly the cash-ups short.
  SELECT count(*) INTO n FROM staff_shortage ss
   WHERE NOT EXISTS (SELECT 1 FROM money_movement mm WHERE mm.shortage_id = ss.id);
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % shortage(s) not on a cash-up', n; END IF;

  -- Banked never exceeds what the shifts took in cash.
  SELECT (SELECT COALESCE(SUM(amount), 0) FROM banking)
       - (SELECT COALESCE(-SUM(amount), 0) FROM money_movement WHERE settlement = 'CASH') INTO v;
  IF v > 0.005 THEN RAISE EXCEPTION 'SIM: % more banked than taken in cash', v; END IF;

  -- (600) What each credit customer owes is what they were billed: the
  -- agreed price where one was in force, the pump price otherwise.
  SELECT count(*) INTO n FROM credit_sale cs
   WHERE cs.shift_id IS NOT NULL
     AND cs.unit_price <> COALESCE((SELECT cp.price FROM customer_price cp WHERE cp.id = cs.customer_price_id),
                                   (SELECT round(cs.pump_price + cp.margin, 2) FROM customer_price cp WHERE cp.id = cs.customer_price_id),
                                   cs.pump_price);
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % credit sale(s) billed at neither the agreed nor the pump price', n; END IF;

  -- (610/620) The books: every control account agrees with its record --
  -- trial balance, receivables, staff shortages, every tank to the litre, shop
  -- stock, cash on hand per site, transfers, payables, received-not-invoiced.
  -- The bank control is left to the simulator's own check: it plants a
  -- short-credited deposit and an unrecorded standing order, so the bank must
  -- differ -- by exactly those (simulate.py, reconcile_money).
  SELECT count(*) INTO n FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date) WHERE ok = FALSE AND control <> 'Bank (1010)';
  IF n > 0 THEN
    RAISE EXCEPTION 'SIM: % control(s) do not agree with their records: %', n,
      (SELECT string_agg(control || ' ' || detail || ' off by ' || difference, '; ')
         FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date) WHERE ok = FALSE AND control <> 'Bank (1010)');
  END IF;
  -- Every month's journals balance on their own, and every journal does.
  SELECT count(*) INTO n FROM (SELECT journal_id FROM gl_line GROUP BY 1 HAVING SUM(amount) <> 0) x;
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % unbalanced journal(s)', n; END IF;
  -- Every closed shift is in the books, once.
  SELECT count(*) INTO n FROM shift sh WHERE sh.state IN ('DECLARED', 'APPROVED')
     AND NOT EXISTS (SELECT 1 FROM gl_journal j WHERE j.source = 'shift' AND j.source_id = sh.id::text);
  IF n > 0 THEN RAISE EXCEPTION 'SIM: % closed shift(s) never reached the books', n; END IF;

  RAISE NOTICE 'all hard checks pass';
END $$;

\echo ''
\echo '== the months'
SELECT to_char(date_trunc('month', sh.business_date), 'Mon YYYY')      AS month,
       count(DISTINCT sh.id)                                            AS shifts,
       to_char(SUM(md.litres) FILTER (WHERE md.kind = 'SALE'), 'FM999,999,990') AS litres_sold,
       to_char(SUM(md.litres * md.unit_price) FILTER (WHERE md.kind = 'SALE'), 'FM999,999,999,990') AS fuel_revenue
  FROM shift sh
  JOIN meter_event me ON me.shift_id = sh.id
  JOIN metered_disposition md ON md.meter_event_id = me.id
 GROUP BY date_trunc('month', sh.business_date) ORDER BY date_trunc('month', sh.business_date);

\echo ''
\echo '== money'
SELECT settlement::text AS how_paid, count(*) AS lines,
       to_char(-SUM(amount), 'FM999,999,999,990') AS ugx
  FROM money_movement WHERE entry = 'SETTLEMENT'
 GROUP BY settlement ORDER BY -SUM(amount) DESC;

SELECT (SELECT count(*) FROM cash_drop) AS drops,
       to_char((SELECT SUM(amount) FROM cash_drop WHERE voided_at IS NULL), 'FM999,999,999,990') AS dropped_ugx,
       (SELECT count(*) FROM banking) AS bankings,
       to_char((SELECT SUM(amount) FROM banking), 'FM999,999,999,990') AS banked_ugx,
       (SELECT count(*) FROM staff_shortage) AS shortages,
       to_char((SELECT SUM(amount) FROM staff_shortage), 'FM999,999,990') AS short_ugx;

\echo ''
\echo '== stock: book against the last dip, and the exceptions the closes raised'
SELECT t.code, round(fn_book_stock(t.id)) AS book_litres,
       round(fn_weighted_avg_cost(t.id), 2) AS avg_cost
  FROM tank t JOIN site s ON s.id = t.site_id WHERE s.kind = 'STATION' ORDER BY t.code;

SELECT code, level::text, count(*) FROM exception_flag GROUP BY 1, 2 ORDER BY 3 DESC;

\echo ''
\echo '== prices the pumps sold at'
SELECT p.code, to_char(pc.effective_from, 'DD Mon') AS from_day, pc.old_price, pc.new_price, pc.status
  FROM price_change pc JOIN product p ON p.id = pc.product_id
 WHERE pc.site_id = (SELECT id FROM site WHERE kind = 'STATION' LIMIT 1)
 ORDER BY pc.effective_from, p.code;

\echo ''
\echo '== credit customers'
SELECT cc.code, cc.name, h.balance, cc.credit_limit
  FROM credit_customer cc CROSS JOIN LATERAL fn_customer_headroom(cc.id) h
 WHERE cc.site_id = (SELECT id FROM site WHERE kind = 'STATION' LIMIT 1);

\echo ''
\echo '== the books'
SELECT control, detail, ledger, record, difference, unit,
       CASE ok WHEN TRUE THEN 'agrees' WHEN FALSE THEN 'DIFFERS' ELSE 'for information' END AS status
  FROM fn_gl_controls_checked((now() AT TIME ZONE 'Africa/Kampala')::date);

SELECT code, name, to_char(closing, 'FM999,999,999,990.00') AS balance
  FROM fn_gl_trial_balance(date '2000-01-01', current_date);

\echo ''
\echo '== closing the year (640), tried and rolled back'
BEGIN;
DO $$
DECLARE c_acc uuid := '10000000-0000-4000-8000-000000000004'; m date; v_profit numeric; v_after numeric; v_re numeric;
BEGIN
  v_profit := -(SELECT COALESCE(SUM(closing), 0) FROM fn_gl_trial_balance(date '2026-01-01', date '2026-12-31')
                 WHERE type IN ('INCOME', 'EXPENSE'));
  -- Not before its months are closed.
  BEGIN
    PERFORM fn_gl_close_year(2026, c_acc);
    RAISE EXCEPTION 'SIM: a year closed with its months open';
  EXCEPTION WHEN check_violation THEN NULL; END;
  FOR m IN SELECT generate_series(date '2026-01-01', date '2026-12-01', interval '1 month')::date LOOP
    PERFORM fn_gl_close_period(m, c_acc);
  END LOOP;
  PERFORM fn_gl_close_year(2026, c_acc);
  -- Income and expense emptied into retained earnings, to the shilling.
  IF EXISTS (SELECT 1 FROM fn_gl_trial_balance(date '2026-01-01', date '2026-12-31')
              WHERE type IN ('INCOME', 'EXPENSE') AND closing <> 0) THEN
    RAISE EXCEPTION 'SIM: income or expense left after closing the year';
  END IF;
  SELECT -closing INTO v_re FROM fn_gl_trial_balance(date '2026-01-01', date '2026-12-31') WHERE code = '3100';
  IF v_re IS DISTINCT FROM v_profit THEN
    RAISE EXCEPTION 'SIM: retained earnings % but the year made %', v_re, v_profit;
  END IF;
  -- The year's profit and loss still shows what it made.
  v_after := -(SELECT COALESCE(SUM(debits - credits), 0)
                 FROM fn_gl_trial_balance(date '2026-01-01', date '2026-12-31', NULL, TRUE)
                WHERE type IN ('INCOME', 'EXPENSE'));
  IF v_after IS DISTINCT FROM v_profit THEN
    RAISE EXCEPTION 'SIM: the closed year''s profit and loss shows %, not %', v_after, v_profit;
  END IF;
  IF (SELECT SUM(amount) FROM gl_line) <> 0 THEN RAISE EXCEPTION 'SIM: books out of balance after year end'; END IF;
  BEGIN
    PERFORM fn_gl_close_year(2026, c_acc);
    RAISE EXCEPTION 'SIM: a year closed twice';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'year end: % to retained earnings; the year''s P&L still shows it; books balance', round(v_profit);
END $$;
ROLLBACK;
