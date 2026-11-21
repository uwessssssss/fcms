-- =============================================================================
-- 670 Wallet matching by shift window first (audit November 2026, R1)
--
-- fn_bank_auto_match matched one statement line to one book line by amount and
-- day before it tried shift windows. For a wallet that is wrong: two customers
-- paying the same amount on one day are told apart only by time. A shift whose
-- whole MoMo total equalled one customer's payment took the first such payment
-- of the day, often another shift's; that shift's window then summed short and
-- the first shift's window long, so both stayed open (the simulator, seed 97:
-- 41 statement lines and 3 book items open on the Airtel wallet; seed 555: 33
-- and 3). The order is now: shift window, then one-to-one, then day totals.
-- Banks are unchanged.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_bank_auto_match(p_account uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE r record; v_line uuid; n int := 0; v_kind text; v_lines uuid[]; v_sum numeric;
BEGIN
  SELECT kind INTO v_kind FROM money_account WHERE id = p_account;
  -- (670) A wallet is matched by shift window FIRST. Matching one payment to one
  -- book line by amount alone, before that, could take a same-amount payment
  -- from another shift's window (two customers paying 37,900 on one day) and
  -- leave two shifts unmatchable. Found by the November 2026 audit, seed 97.
  IF v_kind = 'MOBILE_MONEY' THEN
    -- A shift's MoMo in the books (dated at its close) against the payments
    -- the statement timed between its open and its close.
    FOR r IN SELECT sh.id AS shift_id, sh.opened_at, sh.closed_at, array_agg(b.gl_line_id) AS ids,
                    SUM(b.amount) AS total
               FROM fn_money_account_book(p_account) b
               JOIN gl_line l ON l.id = b.gl_line_id JOIN gl_journal j ON j.id = l.journal_id
               JOIN shift sh ON j.source = 'shift' AND sh.id::text = j.source_id
              WHERE b.gl_line_id NOT IN (SELECT gl_line_id FROM v_bank_matched_book) AND b.amount > 0
              GROUP BY sh.id, sh.opened_at, sh.closed_at LOOP
      SELECT array_agg(sl.id), SUM(sl.amount) INTO v_lines, v_sum FROM bank_statement_line sl
       WHERE sl.money_account_id = p_account AND sl.txn_at >= r.opened_at AND sl.txn_at < r.closed_at
         AND sl.amount > 0 AND sl.id NOT IN (SELECT line_id FROM v_bank_matched_statement)
      HAVING SUM(sl.amount) = r.total;
      IF v_lines IS NOT NULL THEN
        PERFORM fn_bank_match(p_account, v_lines, r.ids, 'AUTO', p_actor, 'Shift total');
        n := n + 1;
      END IF;
      v_lines := NULL;
    END LOOP;
  END IF;

  FOR r IN SELECT b.* FROM fn_money_account_book(p_account) b
            WHERE b.gl_line_id NOT IN (SELECT gl_line_id FROM v_bank_matched_book)
            ORDER BY b.on_date, b.gl_line_id LOOP
    SELECT sl.id INTO v_line FROM bank_statement_line sl
     WHERE sl.money_account_id = p_account AND sl.amount = r.amount
       AND sl.txn_date BETWEEN r.on_date - CASE v_kind WHEN 'BANK' THEN 1 ELSE 0 END
                           AND r.on_date + CASE v_kind WHEN 'BANK' THEN 5 ELSE 0 END
       AND sl.id NOT IN (SELECT line_id FROM v_bank_matched_statement)
     ORDER BY (r.memo IS NOT NULL AND (position(sl.reference IN r.memo) > 0 AND sl.reference <> '')) DESC,
              abs(sl.txn_date - r.on_date), sl.line_no
     LIMIT 1;
    IF v_line IS NOT NULL THEN
      PERFORM fn_bank_match(p_account, ARRAY[v_line], ARRAY[r.gl_line_id], 'AUTO', p_actor);
      n := n + 1;
    END IF;
  END LOOP;

  IF v_kind = 'MOBILE_MONEY' THEN
    -- Day totals, for statements without times.
    FOR r IN SELECT b.on_date, array_agg(b.gl_line_id) AS ids, SUM(b.amount) AS total
               FROM fn_money_account_book(p_account) b
              WHERE b.gl_line_id NOT IN (SELECT gl_line_id FROM v_bank_matched_book) AND b.amount > 0
              GROUP BY b.on_date LOOP
      SELECT array_agg(sl.id), SUM(sl.amount) INTO v_lines, v_sum FROM bank_statement_line sl
       WHERE sl.money_account_id = p_account AND sl.txn_date = r.on_date AND sl.amount > 0 AND sl.txn_at IS NULL
         AND sl.id NOT IN (SELECT line_id FROM v_bank_matched_statement)
      HAVING SUM(sl.amount) = r.total;
      IF v_lines IS NOT NULL THEN
        PERFORM fn_bank_match(p_account, v_lines, r.ids, 'AUTO', p_actor, 'Day total ' || r.on_date);
        n := n + 1;
      END IF;
      v_lines := NULL;
    END LOOP;
  END IF;
  RETURN n;
END $function$;
