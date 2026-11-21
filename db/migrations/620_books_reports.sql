-- =============================================================================
-- FCMS v2 -- 620_books_reports.sql
--
-- What the books say, and whether they agree with the operations.
--
--   fn_gl_trial_balance(from, to, site)  every account: opening, debits, credits, closing
--   fn_gl_account_ledger(code, from, to, site)  one account, line by line, running balance
--   fn_ar_reconciliation(as_of)          each credit customer: sub-ledger against the
--                                        ledger, and how old what they owe is
--   fn_gl_controls(as_of)                every control account against the record it
--                                        summarises -- the reconciliations on one page
--   fn_gl_close_period(month, actor)     a month closed: nothing more posts into it
--
-- All read through row-level security: a company sees its own books only.
-- =============================================================================

-- p_trading_only: leave out the year-end closing journal (640), so a profit
-- and loss for a closed year still shows what the year made.
CREATE OR REPLACE FUNCTION fn_gl_trial_balance(p_from date, p_to date, p_site uuid DEFAULT NULL,
                                               p_trading_only boolean DEFAULT FALSE)
RETURNS TABLE (code text, name text, type gl_account_type, opening numeric, debits numeric,
               credits numeric, closing numeric)
LANGUAGE sql STABLE AS $$
  SELECT a.code, a.name, a.type,
         COALESCE(SUM(l.amount) FILTER (WHERE j.posting_date < p_from), 0),
         COALESCE(SUM(l.amount) FILTER (WHERE j.posting_date BETWEEN p_from AND p_to AND l.amount > 0), 0),
         COALESCE(-SUM(l.amount) FILTER (WHERE j.posting_date BETWEEN p_from AND p_to AND l.amount < 0), 0),
         COALESCE(SUM(l.amount) FILTER (WHERE j.posting_date <= p_to), 0)
    FROM gl_account a
    LEFT JOIN gl_line l ON l.account_id = a.id AND (p_site IS NULL OR l.site_id = p_site)
     AND (NOT p_trading_only OR NOT EXISTS (SELECT 1 FROM gl_journal y WHERE y.id = l.journal_id AND y.source = 'year_end'))
    LEFT JOIN gl_journal j ON j.id = l.journal_id
   GROUP BY a.code, a.name, a.type
  HAVING COALESCE(SUM(l.amount) FILTER (WHERE j.posting_date <= p_to), 0) <> 0
      OR COALESCE(SUM(abs(l.amount)) FILTER (WHERE j.posting_date BETWEEN p_from AND p_to), 0) <> 0
   ORDER BY a.code
$$;

CREATE OR REPLACE FUNCTION fn_gl_account_ledger(p_code text, p_from date, p_to date, p_site uuid DEFAULT NULL)
RETURNS TABLE (posting_date date, event_at timestamptz, journal_id uuid, source text, memo text, party text,
               qty numeric, debit numeric, credit numeric, balance numeric)
LANGUAGE sql STABLE AS $$
  WITH a AS (SELECT id FROM gl_account WHERE code = p_code),
  opening AS (
    SELECT COALESCE(SUM(l.amount), 0) AS v FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id
     WHERE l.account_id = (SELECT id FROM a) AND j.posting_date < p_from AND (p_site IS NULL OR l.site_id = p_site)),
  lines AS (
    SELECT j.posting_date, j.event_at, j.id AS journal_id, j.source, COALESCE(l.memo, j.memo) AS memo,
           COALESCE(cc.name, su.name, st.full_name, t.code, di.name, pc.name) AS party,
           l.qty, l.amount, l.id
      FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id
      LEFT JOIN credit_customer cc ON cc.id = l.customer_id
      LEFT JOIN supplier su ON su.id = l.supplier_id
      LEFT JOIN staff st ON st.id = l.staff_id
      LEFT JOIN tank t ON t.id = l.tank_id
      LEFT JOIN dry_item di ON di.id = l.item_id
      LEFT JOIN payment_channel pc ON pc.id = l.channel_id
     WHERE l.account_id = (SELECT id FROM a) AND j.posting_date BETWEEN p_from AND p_to
       AND (p_site IS NULL OR l.site_id = p_site))
  SELECT NULL::date, NULL::timestamptz, NULL::uuid, 'opening', 'Balance brought forward', NULL, NULL,
         NULL, NULL, (SELECT v FROM opening)
  UNION ALL
  SELECT posting_date, event_at, journal_id, source, memo, party, qty,
         CASE WHEN amount > 0 THEN amount END, CASE WHEN amount < 0 THEN -amount END,
         (SELECT v FROM opening) + SUM(amount) OVER (ORDER BY posting_date, event_at, id)
    FROM lines
$$;

-- ---------------------------------------------------------------------------
-- RECEIVABLES. The customer's own account (credit sales and depot credit
-- sales, less payments) set beside the ledger's control account for that
-- customer; what they owe aged by the date of each sale, payments taken
-- against the oldest first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ar_reconciliation(p_as_of date)
RETURNS TABLE (customer_id uuid, code text, name text, credit_limit numeric, billed numeric, paid numeric,
               subledger numeric, ledger numeric, difference numeric, in_open_shifts numeric,
               current_0_30 numeric, days_31_60 numeric, days_61_90 numeric, over_90 numeric,
               last_payment date, oldest_unpaid date)
LANGUAGE sql STABLE AS $$
  WITH cut AS (SELECT ((p_as_of + 1)::timestamp AT TIME ZONE 'Africa/Kampala') AS t),
  -- A credit sale reaches the books when its shift is declared: until then it
  -- is on the account of the customer but not in the ledger -- a timing
  -- difference, shown on its own (in_open_shifts), never mixed in.
  pending AS (
    SELECT cs.customer_id, SUM(cs.amount) AS amount FROM credit_sale cs JOIN shift sh ON sh.id = cs.shift_id, cut
     WHERE cs.recorded_at < cut.t AND sh.state IN ('OPEN', 'COUNTING') GROUP BY cs.customer_id),
  charges AS (
    SELECT cs.customer_id, cs.recorded_at AS at, cs.id, cs.amount FROM credit_sale cs
      LEFT JOIN shift sh ON sh.id = cs.shift_id, cut
     WHERE cs.recorded_at < cut.t AND (sh.id IS NULL OR sh.state NOT IN ('OPEN', 'COUNTING'))
    UNION ALL
    SELECT bs.customer_id, bs.loaded_at, bs.id, bs.amount FROM bulk_sale bs, cut
     WHERE bs.payment_terms = 'CREDIT' AND bs.loaded_at < cut.t),
  paid AS (
    SELECT cp.customer_id, SUM(cp.amount) AS amount, max(cp.received_at) AS last_at
      FROM credit_payment cp, cut WHERE cp.received_at < cut.t GROUP BY cp.customer_id),
  fifo AS (
    SELECT c.*, SUM(c.amount) OVER (PARTITION BY c.customer_id ORDER BY c.at, c.id) AS through
      FROM charges c),
  open_items AS (
    SELECT f.customer_id, f.at,
           f.amount - GREATEST(0, LEAST(f.amount, COALESCE(p.amount, 0) - (f.through - f.amount))) AS outstanding
      FROM fifo f LEFT JOIN paid p ON p.customer_id = f.customer_id),
  gl AS (
    SELECT l.customer_id, SUM(l.amount) AS v
      FROM gl_line l JOIN gl_journal j ON j.id = l.journal_id JOIN gl_account a ON a.id = l.account_id
     WHERE a.code = '1100' AND j.posting_date <= p_as_of GROUP BY l.customer_id)
  SELECT cc.id, cc.code, cc.name, cc.credit_limit,
         COALESCE((SELECT SUM(amount) FROM charges c WHERE c.customer_id = cc.id), 0),
         COALESCE(p.amount, 0),
         COALESCE((SELECT SUM(amount) FROM charges c WHERE c.customer_id = cc.id), 0) - COALESCE(p.amount, 0),
         COALESCE(gl.v, 0),
         COALESCE(gl.v, 0)
           - (COALESCE((SELECT SUM(amount) FROM charges c WHERE c.customer_id = cc.id), 0) - COALESCE(p.amount, 0)),
         COALESCE((SELECT amount FROM pending pd WHERE pd.customer_id = cc.id), 0),
         COALESCE(SUM(o.outstanding) FILTER (WHERE p_as_of - (o.at AT TIME ZONE 'Africa/Kampala')::date <= 30), 0),
         COALESCE(SUM(o.outstanding) FILTER (WHERE p_as_of - (o.at AT TIME ZONE 'Africa/Kampala')::date BETWEEN 31 AND 60), 0),
         COALESCE(SUM(o.outstanding) FILTER (WHERE p_as_of - (o.at AT TIME ZONE 'Africa/Kampala')::date BETWEEN 61 AND 90), 0),
         COALESCE(SUM(o.outstanding) FILTER (WHERE p_as_of - (o.at AT TIME ZONE 'Africa/Kampala')::date > 90), 0),
         (p.last_at AT TIME ZONE 'Africa/Kampala')::date,
         (min(o.at) FILTER (WHERE o.outstanding > 0) AT TIME ZONE 'Africa/Kampala')::date
    FROM credit_customer cc
    LEFT JOIN paid p ON p.customer_id = cc.id
    LEFT JOIN gl ON gl.customer_id = cc.id
    LEFT JOIN open_items o ON o.customer_id = cc.id
   GROUP BY cc.id, cc.code, cc.name, cc.credit_limit, p.amount, p.last_at, gl.v
   ORDER BY cc.code
$$;

-- ---------------------------------------------------------------------------
-- THE CONTROLS. Each control account against the record it stands for. A
-- difference is a fact to explain, never rounded away.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_controls(p_as_of date)
RETURNS TABLE (control text, detail text, ledger numeric, record numeric, difference numeric, unit text)
LANGUAGE sql STABLE AS $$
  WITH cut AS (SELECT ((p_as_of + 1)::timestamp AT TIME ZONE 'Africa/Kampala') AS t),
  gl AS (
    SELECT a.code, l.*, j.posting_date FROM gl_line l
      JOIN gl_journal j ON j.id = l.journal_id JOIN gl_account a ON a.id = l.account_id
     WHERE j.posting_date <= p_as_of)
  -- 1. The books balance.
  SELECT 'Trial balance', 'debits less credits', COALESCE((SELECT SUM(amount) FROM gl), 0), 0::numeric,
         COALESCE((SELECT SUM(amount) FROM gl), 0), 'UGX'
  UNION ALL
  -- 2. Receivables: the control account against the customers' accounts.
  SELECT 'Receivables (1100)', 'against every customer''s account',
         (SELECT COALESCE(SUM(ledger), 0) FROM fn_ar_reconciliation(p_as_of)),
         (SELECT COALESCE(SUM(subledger), 0) FROM fn_ar_reconciliation(p_as_of)),
         (SELECT COALESCE(SUM(difference), 0) FROM fn_ar_reconciliation(p_as_of)), 'UGX'
  UNION ALL
  -- 3. Staff shortages: the control account against what is still owed.
  SELECT 'Staff shortages (1110)', 'against shortages less recoveries',
         COALESCE((SELECT SUM(amount) FROM gl WHERE code = '1110'), 0),
         COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss, cut WHERE ss.created_at < cut.t), 0)
       - COALESCE((SELECT SUM(sr.amount) FROM shortage_recovery sr, cut WHERE sr.recovered_at < cut.t), 0),
         COALESCE((SELECT SUM(amount) FROM gl WHERE code = '1110'), 0)
       - (COALESCE((SELECT SUM(ss.amount) FROM staff_shortage ss, cut WHERE ss.created_at < cut.t), 0)
        - COALESCE((SELECT SUM(sr.amount) FROM shortage_recovery sr, cut WHERE sr.recovered_at < cut.t), 0)), 'UGX'
  UNION ALL
  -- 4. Fuel stock: the ledger's litres in each tank against its last dip.
  SELECT 'Fuel stock (1200)', t.code || ' litres against the last dip',
         COALESCE((SELECT SUM(qty) FROM gl WHERE code = '1200' AND tank_id = t.id), 0),
         d.product_litres,
         COALESCE((SELECT SUM(qty) FROM gl WHERE code = '1200' AND tank_id = t.id), 0) - d.product_litres, 'L'
    FROM tank t
    CROSS JOIN LATERAL (SELECT dr.product_litres FROM dip_reading dr, cut
                         WHERE dr.tank_id = t.id AND dr.context = 'SHIFT_CLOSE' AND dr.captured_at < cut.t
                         ORDER BY dr.captured_at DESC LIMIT 1) d
  UNION ALL
  -- 5. Shop stock: items in the ledger against items on hand.
  SELECT 'Shop stock (1210)', s.code || ': items against stock on hand',
         COALESCE((SELECT SUM(qty) FROM gl WHERE code = '1210' AND site_id = s.id), 0),
         COALESCE((SELECT SUM(dm.signed_qty) FROM dry_movement dm, cut WHERE dm.site_id = s.id AND dm.occurred_at < cut.t), 0),
         COALESCE((SELECT SUM(qty) FROM gl WHERE code = '1210' AND site_id = s.id), 0)
       - COALESCE((SELECT SUM(dm.signed_qty) FROM dry_movement dm, cut WHERE dm.site_id = s.id AND dm.occurred_at < cut.t), 0),
         'items'
    FROM site s WHERE EXISTS (SELECT 1 FROM dry_movement dm WHERE dm.site_id = s.id)
  UNION ALL
  -- 6. Cash on hand: the ledger against cash taken, less banked and paid out.
  SELECT 'Cash on hand (1000)', s.code || ': cash taken less banked and paid out',
         COALESCE((SELECT SUM(amount) FROM gl WHERE code = '1000' AND site_id = s.id), 0),
         COALESCE((SELECT -SUM(mm.amount) FROM money_movement mm, cut
                    WHERE mm.site_id = s.id AND mm.settlement = 'CASH' AND mm.recorded_at < cut.t), 0)
       - COALESCE((SELECT SUM(b.amount) FROM banking b, cut WHERE b.site_id = s.id AND b.banked_at < cut.t), 0)
       - COALESCE((SELECT SUM(e.amount) FROM expense e, cut WHERE e.site_id = s.id AND e.paid_from = 'TILL_CASH'
                      AND e.recorded_at < cut.t), 0),
         NULL::numeric, 'UGX'
    FROM site s
  UNION ALL
  -- 7. Transfers between sites: nothing should be left in transit.
  SELECT 'Transfers in transit (2200)', 'should be nil across the company',
         COALESCE((SELECT SUM(amount) FROM gl WHERE code = '2200'), 0), 0::numeric,
         COALESCE((SELECT SUM(amount) FROM gl WHERE code = '2200'), 0), 'UGX'
  UNION ALL
  -- 8. Payables: the control account against invoices less payments, by supplier.
  SELECT 'Payables (2000)', su.name || ': invoices less payments',
         COALESCE((SELECT -SUM(amount) FROM gl WHERE code = '2000' AND supplier_id = su.id), 0),
         COALESCE((SELECT SUM(i.amount) FROM supplier_invoice i, cut WHERE i.supplier_id = su.id AND i.recorded_at < cut.t), 0)
       - COALESCE((SELECT SUM(p.amount) FROM supplier_payment p, cut WHERE p.supplier_id = su.id AND p.recorded_at < cut.t), 0)
       + COALESCE((SELECT SUM(e.amount) FROM expense e, cut WHERE e.supplier_id = su.id AND e.paid_from = 'CREDIT'
                      AND e.recorded_at < cut.t), 0),
         NULL::numeric, 'UGX'
    FROM supplier su
   WHERE EXISTS (SELECT 1 FROM supplier_invoice i WHERE i.supplier_id = su.id)
      OR EXISTS (SELECT 1 FROM expense e WHERE e.supplier_id = su.id AND e.paid_from = 'CREDIT')
  UNION ALL
  -- 9. Received, not invoiced, by supplier: what was delivered (as loaded, at
  -- cost) against what their invoices have claimed.
  SELECT 'Received, not invoiced (2010)', su.name || ': delivered against invoiced',
         COALESCE((SELECT -SUM(amount) FROM gl WHERE code = '2010' AND supplier_id = su.id), 0),
         COALESCE((SELECT SUM(round(COALESCE(dl.loaded_litres, fm.litres) * fm.unit_cost, 2))
                     FROM fuel_movement fm JOIN delivery_line dl ON dl.id = fm.delivery_line_id
                     JOIN delivery d ON d.id = dl.delivery_id, cut
                    WHERE fm.kind = 'DELIVERY_IN' AND d.supplier_id = su.id AND fm.occurred_at < cut.t), 0)
       - COALESCE((SELECT SUM(i.amount) FROM supplier_invoice i, cut WHERE i.supplier_id = su.id AND i.recorded_at < cut.t), 0),
         NULL::numeric, 'UGX'
    FROM supplier su
   WHERE EXISTS (SELECT 1 FROM delivery d WHERE d.supplier_id = su.id)
  UNION ALL
  -- 10. Shop purchases received with no supplier named, waiting for an invoice.
  SELECT 'Received, not invoiced (2010)', 'shop purchases, no supplier named',
         COALESCE((SELECT -SUM(amount) FROM gl WHERE code = '2010' AND supplier_id IS NULL), 0), NULL::numeric,
         NULL::numeric, 'UGX'
$$;

-- Cash on hand: the difference is the ledger less the record (filled here,
-- since the record is a sum of three parts above).
CREATE OR REPLACE FUNCTION fn_gl_controls_checked(p_as_of date)
RETURNS TABLE (control text, detail text, ledger numeric, record numeric, difference numeric, unit text, ok boolean)
LANGUAGE sql STABLE AS $$
  SELECT c.control, c.detail, c.ledger, c.record,
         COALESCE(c.difference, CASE WHEN c.record IS NOT NULL THEN c.ledger - c.record END),
         c.unit,
         CASE WHEN c.record IS NULL AND c.difference IS NULL THEN NULL
              ELSE abs(COALESCE(c.difference, c.ledger - c.record)) < 0.005 END
    FROM fn_gl_controls(p_as_of) c
$$;

-- ---------------------------------------------------------------------------
-- Closing a month. Every shift in it must be closed; after this nothing posts
-- into it -- a late event lands in the next open month, dated as it happened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_close_period(p_month date, p_actor uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role staff_role; v_tenant uuid; v_start date := date_trunc('month', p_month)::date; n int;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a month is closed by an accountant or head office' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO n FROM shift
   WHERE tenant_id = v_tenant AND state IN ('OPEN', 'COUNTING')
     AND business_date >= v_start AND business_date < v_start + interval '1 month';
  IF n > 0 THEN
    RAISE EXCEPTION 'SHIFTS_STILL_OPEN: % shift(s) of that month are not closed yet', n USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM gl_period WHERE tenant_id = v_tenant AND period_start = v_start AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: % is closed already', to_char(v_start, 'Mon YYYY') USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO gl_period (tenant_id, period_start, closed_at, closed_by) VALUES (v_tenant, v_start, now(), p_actor)
  ON CONFLICT (tenant_id, period_start) DO UPDATE SET closed_at = now(), closed_by = p_actor;
END $$;
-- A closed month never reopens through the app: the period rows are written
-- only by fn_gl_close_period.
REVOKE INSERT, UPDATE ON gl_period FROM fcms_app;
GRANT INSERT, UPDATE ON gl_period TO fcms_ledger;
ALTER FUNCTION fn_gl_close_period(date, uuid) OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_close_period(date, uuid) SECURITY DEFINER;
ALTER FUNCTION fn_gl_close_period(date, uuid) SET search_path = public, pg_temp;
