-- =============================================================================
-- FCMS v2 -- 640_year_end.sql
--
-- CLOSING A YEAR. Every income and expense account's balance for the year is
-- moved into retained earnings (3100), site by site, in one journal dated the
-- year's last day. The year's profit then sits in equity, and the next year's
-- profit and loss starts from nothing.
--
--   * every month of the year that has postings, and December, must be closed
--     first (fn_gl_close_period) -- so nothing can post into the year after
--   * by an accountant, head office or a director; once per year, never undone
--   * the profit and loss leaves this journal out (fn_gl_trial_balance with
--     p_trading_only), so a closed year still shows what it made
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_gl_close_year(p_year int, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_role staff_role; v_tenant uuid; v_from date := make_date(p_year, 1, 1); v_to date := make_date(p_year, 12, 31);
        v_open text; v_id uuid; v_re uuid; r record; v_n int := 0;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a year is closed by an accountant or head office' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_journal WHERE tenant_id = v_tenant AND source = 'year_end' AND source_id = p_year::text) THEN
    RAISE EXCEPTION 'YEAR_CLOSED: % is closed already', p_year USING ERRCODE = 'check_violation';
  END IF;
  -- Every month with postings, and December, closed.
  SELECT string_agg(to_char(m, 'Mon'), ', ' ORDER BY m) INTO v_open
    FROM (SELECT DISTINCT date_trunc('month', posting_date)::date AS m FROM gl_journal
           WHERE tenant_id = v_tenant AND posting_date BETWEEN v_from AND v_to
          UNION SELECT make_date(p_year, 12, 1)) months
   WHERE NOT EXISTS (SELECT 1 FROM gl_period p WHERE p.tenant_id = v_tenant AND p.period_start = months.m
                        AND p.closed_at IS NOT NULL);
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'MONTHS_STILL_OPEN: close % % first', v_open, p_year USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_re FROM gl_account WHERE tenant_id = v_tenant AND code = '3100';
  -- Written here, not through fn_gl_post: December is closed by now, and this
  -- journal belongs in it.
  INSERT INTO gl_journal (tenant_id, site_id, posting_date, event_at, source, source_id, memo, posted_by)
  VALUES (v_tenant, NULL, v_to, (v_to + time '23:59') AT TIME ZONE 'Africa/Kampala', 'year_end', p_year::text,
          'Year ' || p_year || ' closed: income and expenses to retained earnings', p_actor)
  RETURNING id INTO v_id;

  FOR r IN
    SELECT l.account_id, l.site_id, SUM(l.amount) AS balance
      FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id JOIN gl_account a ON a.id = l.account_id
     WHERE l.tenant_id = v_tenant AND a.type IN ('INCOME', 'EXPENSE') AND j.posting_date BETWEEN v_from AND v_to
     GROUP BY l.account_id, l.site_id HAVING SUM(l.amount) <> 0
  LOOP
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, site_id, memo)
    VALUES (v_tenant, v_id, r.account_id, -r.balance, r.site_id, 'Closed to retained earnings');
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, site_id, memo)
    VALUES (v_tenant, v_id, v_re, r.balance, r.site_id, 'Year ' || p_year || ' result');
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_CLOSE: % has no income or expense', p_year USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_id;
END $$;
ALTER FUNCTION fn_gl_close_year(int, uuid) OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_close_year(int, uuid) SECURITY DEFINER;
ALTER FUNCTION fn_gl_close_year(int, uuid) SET search_path = public, pg_temp;
