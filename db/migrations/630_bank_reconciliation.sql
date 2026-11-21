-- =============================================================================
-- FCMS v2 -- 630_bank_reconciliation.sql
--
-- BANK AND MOBILE MONEY, against their statements.
--
--   money_account         a bank account or a mobile-money wallet (by channel),
--                         with the ledger account it lives in (1010 or 1020)
--   money_transfer        money moved between them: a MoMo withdrawal to the
--                         bank, bank to bank -- with its fee. Posts itself.
--   bank_statement(_line) a statement as the bank or the network issued it,
--                         imported once (a line seen before is skipped)
--   bank_match            statement lines and book lines that are the same
--                         money; their sums must agree
--
--   fn_bank_auto_match(account)      bank: one book line to one statement line,
--                                    same amount, within 5 days, reference first.
--                                    Mobile money: one day's book total per
--                                    channel against the day's statement lines.
--   fn_bank_match / fn_bank_unmatch  by hand, sums equal
--   fn_bank_post_statement_line      a charge, interest or direct debit the books
--                                    do not have: posted and matched in one step
--   fn_bank_reconciliation(account, as_of)  the statement, the books, and every
--                                    item in one but not the other
--
-- Matching is reconciliation work, not the books: a match can be undone.
-- The books themselves are still never edited.
-- =============================================================================

CREATE TABLE money_account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid REFERENCES site(id),
  kind           text NOT NULL CHECK (kind IN ('BANK', 'MOBILE_MONEY')),
  name           text NOT NULL,                 -- 'Stanbic Kiboga collections', 'MTN merchant 123456'
  institution    text NOT NULL,                 -- 'Stanbic Bank', 'MTN'
  account_ref    text,                          -- the number as printed on the statement
  channel_id     uuid REFERENCES payment_channel(id),   -- a wallet's tender channel
  is_default     boolean NOT NULL DEFAULT FALSE,        -- the bank account untagged 1010 lines belong to
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_names_its_channel CHECK (kind <> 'MOBILE_MONEY' OR channel_id IS NOT NULL),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX money_account_one_default ON money_account (tenant_id) WHERE is_default;
CREATE UNIQUE INDEX money_account_one_wallet_per_channel ON money_account (channel_id) WHERE channel_id IS NOT NULL;

-- A bank line in the books may name its account.
ALTER TABLE gl_line ADD COLUMN money_account_id uuid REFERENCES money_account(id);
CREATE INDEX ON gl_line (account_id, money_account_id);

-- The ledger account and tag for a money account's lines.
CREATE OR REPLACE FUNCTION fn_money_account_line(p_account uuid, p_amount numeric, p_memo text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
           'code', CASE ma.kind WHEN 'BANK' THEN '1010' ELSE '1020' END,
           'amount', p_amount, 'money_account_id', ma.id, 'channel_id', ma.channel_id,
           'site_id', ma.site_id, 'memo', p_memo)
    FROM money_account ma WHERE ma.id = p_account
$$;

-- ---------------------------------------------------------------------------
-- fn_gl_post, as in 610, also carrying money_account_id on a line.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_post(p_tenant uuid, p_site uuid, p_source text, p_source_id text,
                                      p_event_at timestamptz, p_memo text, p_lines jsonb,
                                      p_posted_by uuid DEFAULT NULL, p_reverses uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_date date; v_tz text; v_l jsonb; v_acct uuid; v_amt numeric;
BEGIN
  IF p_source <> 'manual' AND p_reverses IS NULL THEN
    SELECT id INTO v_id FROM gl_journal
     WHERE tenant_id = p_tenant AND source = p_source AND source_id = p_source_id AND reverses_id IS NULL;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
                  WHERE round((l->>'amount')::numeric, 2) <> 0 OR COALESCE((l->>'qty')::numeric, 0) <> 0) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(s.timezone, t.default_tz) INTO v_tz
    FROM tenant t LEFT JOIN site s ON s.id = p_site WHERE t.id = p_tenant;
  v_date := (p_event_at AT TIME ZONE COALESCE(v_tz, 'Africa/Kampala'))::date;
  WHILE EXISTS (SELECT 1 FROM gl_period WHERE tenant_id = p_tenant AND closed_at IS NOT NULL
                   AND period_start = date_trunc('month', v_date)::date) LOOP
    v_date := (date_trunc('month', v_date) + interval '1 month')::date;
  END LOOP;

  INSERT INTO gl_journal (tenant_id, site_id, posting_date, event_at, source, source_id, memo, reverses_id, posted_by)
  VALUES (p_tenant, p_site, v_date, p_event_at, p_source, p_source_id, p_memo, p_reverses, p_posted_by)
  RETURNING id INTO v_id;

  FOR v_l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_amt := round((v_l->>'amount')::numeric, 2);
    CONTINUE WHEN v_amt = 0 AND COALESCE((v_l->>'qty')::numeric, 0) = 0;
    SELECT id INTO v_acct FROM gl_account WHERE tenant_id = p_tenant AND code = v_l->>'code';
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_ACCOUNT: no account % in this company''s chart', v_l->>'code'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, qty, site_id, customer_id, supplier_id,
                         staff_id, tank_id, item_id, channel_id, product_id, memo, money_account_id)
    VALUES (p_tenant, v_id, v_acct, v_amt, (v_l->>'qty')::numeric,
            COALESCE((v_l->>'site_id')::uuid, p_site), (v_l->>'customer_id')::uuid, (v_l->>'supplier_id')::uuid,
            (v_l->>'staff_id')::uuid, (v_l->>'tank_id')::uuid, (v_l->>'item_id')::uuid,
            (v_l->>'channel_id')::uuid, (v_l->>'product_id')::uuid, v_l->>'memo',
            (v_l->>'money_account_id')::uuid);
  END LOOP;
  RETURN v_id;
END $$;
ALTER FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) SECURITY DEFINER;
ALTER FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) TO fcms_ledger;

-- ---------------------------------------------------------------------------
-- Money moved between accounts -- a MoMo withdrawal to the bank, bank to
-- bank. The fee comes out of the sending account.
-- ---------------------------------------------------------------------------
CREATE TABLE money_transfer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid REFERENCES site(id),
  from_account   uuid NOT NULL REFERENCES money_account(id),
  to_account     uuid NOT NULL REFERENCES money_account(id),
  amount         numeric(16,2) NOT NULL CHECK (amount > 0),   -- what arrived
  fee            numeric(16,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  reference      text,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid NOT NULL REFERENCES staff(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_moves CHECK (from_account <> to_account)
);

CREATE OR REPLACE FUNCTION fn_gl_post_money_transfer(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t money_transfer%ROWTYPE; v_from text; v_to text;
BEGIN
  SELECT * INTO t FROM money_transfer WHERE id = p_id;
  SELECT name INTO v_from FROM money_account WHERE id = t.from_account;
  SELECT name INTO v_to FROM money_account WHERE id = t.to_account;
  RETURN fn_gl_post(t.tenant_id, t.site_id, 'money_transfer', p_id::text, t.transferred_at,
    'Moved ' || v_from || ' to ' || v_to || COALESCE(' ' || t.reference, ''),
    jsonb_build_array(
      fn_money_account_line(t.to_account, t.amount, COALESCE(t.reference, 'Transfer in')),
      fn_money_account_line(t.from_account, -(t.amount + t.fee), COALESCE(t.reference, 'Transfer out')),
      jsonb_build_object('code', '6100', 'amount', t.fee, 'memo', 'Transfer fee')));
END $$;

-- Banking now names its account when the bank's name matches one.
CREATE OR REPLACE FUNCTION fn_gl_post_banking(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b banking%ROWTYPE; v_acct uuid;
BEGIN
  SELECT * INTO b FROM banking WHERE id = p_id;
  SELECT id INTO v_acct FROM money_account
   WHERE tenant_id = b.tenant_id AND kind = 'BANK'
     AND (lower(institution) = lower(b.bank_name) OR lower(name) = lower(b.bank_name)
          OR (b.account_ref IS NOT NULL AND account_ref = b.account_ref))
   ORDER BY (b.account_ref IS NOT NULL AND account_ref = b.account_ref) DESC, is_default DESC LIMIT 1;
  RETURN fn_gl_post(b.tenant_id, b.site_id, 'banking', p_id::text, b.banked_at,
    'Banked ' || b.bank_name || ' slip ' || b.slip_no,
    jsonb_build_array(
      jsonb_build_object('code', '1010', 'amount', b.amount, 'money_account_id', v_acct,
                         'memo', b.bank_name || ' ' || COALESCE(b.account_ref, '') || ' slip ' || b.slip_no),
      jsonb_build_object('code', '1000', 'amount', -b.amount, 'memo', 'Takings of ' || b.business_date)));
END $$;

CREATE TRIGGER gl_post AFTER INSERT ON money_transfer FOR EACH ROW EXECUTE FUNCTION trg_gl_post();

CREATE OR REPLACE FUNCTION trg_gl_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF    TG_TABLE_NAME = 'fuel_movement'     THEN PERFORM fn_gl_post_fuel_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'dry_movement'      THEN PERFORM fn_gl_post_dry_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'banking'           THEN PERFORM fn_gl_post_banking(NEW.id);
  ELSIF TG_TABLE_NAME = 'credit_payment'    THEN PERFORM fn_gl_post_credit_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'expense'           THEN PERFORM fn_gl_post_expense(NEW.id);
  ELSIF TG_TABLE_NAME = 'other_income'      THEN PERFORM fn_gl_post_other_income(NEW.id);
  ELSIF TG_TABLE_NAME = 'shortage_recovery' THEN PERFORM fn_gl_post_shortage_recovery(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_invoice'  THEN PERFORM fn_gl_post_supplier_invoice(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_payment'  THEN PERFORM fn_gl_post_supplier_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'bulk_sale'         THEN PERFORM fn_gl_post_bulk_sale(NEW.id);
  ELSIF TG_TABLE_NAME = 'money_transfer'    THEN PERFORM fn_gl_post_money_transfer(NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Statements. A line already imported (same account, date, amount, reference
-- and text) is skipped: importing an overlapping statement twice is harmless.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  money_account_id uuid NOT NULL REFERENCES money_account(id),
  period_from      date NOT NULL,
  period_to        date NOT NULL CHECK (period_to >= period_from),
  opening_balance  numeric(16,2),
  closing_balance  numeric(16,2),
  source_name      text,                         -- the file it came from
  imported_by      uuid NOT NULL REFERENCES staff(id),
  imported_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  statement_id     uuid NOT NULL REFERENCES bank_statement(id),
  money_account_id uuid NOT NULL REFERENCES money_account(id),
  txn_date         date NOT NULL,
  -- Mobile-money statements carry the time of each payment. With it a
  -- shift's MoMo matches the payments made while it was open; without it,
  -- day totals are all there is.
  txn_at           timestamptz,
  description      text NOT NULL DEFAULT '',
  reference        text NOT NULL DEFAULT '',
  amount           numeric(16,2) NOT NULL CHECK (amount <> 0),   -- in +, out -
  balance          numeric(16,2),
  line_no          int NOT NULL,     -- position in the statement: two identical lines on one day are two lines
  UNIQUE (money_account_id, txn_date, amount, reference, description, line_no)
);
CREATE INDEX ON bank_statement_line (money_account_id, txn_date);

CREATE TABLE bank_match (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  money_account_id uuid NOT NULL REFERENCES money_account(id),
  kind             text NOT NULL CHECK (kind IN ('AUTO', 'MANUAL', 'POSTED')),
  matched_by       uuid REFERENCES staff(id),
  matched_at       timestamptz NOT NULL DEFAULT now(),
  undone_at        timestamptz,
  undone_by        uuid REFERENCES staff(id),
  note             text
);
CREATE TABLE bank_match_statement (
  match_id  uuid NOT NULL REFERENCES bank_match(id),
  line_id   uuid NOT NULL REFERENCES bank_statement_line(id),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  PRIMARY KEY (match_id, line_id)
);
CREATE TABLE bank_match_book (
  match_id   uuid NOT NULL REFERENCES bank_match(id),
  gl_line_id bigint NOT NULL REFERENCES gl_line(id),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  PRIMARY KEY (match_id, gl_line_id)
);

-- The book side of a money account: its ledger lines.
CREATE OR REPLACE FUNCTION fn_money_account_book(p_account uuid)
RETURNS TABLE (gl_line_id bigint, on_date date, amount numeric, memo text, source text)
LANGUAGE sql STABLE AS $$
  SELECT l.id, (j.event_at AT TIME ZONE 'Africa/Kampala')::date, l.amount, COALESCE(l.memo, j.memo), j.source
    FROM money_account ma
    JOIN gl_account a ON a.tenant_id = ma.tenant_id
                     AND a.code = CASE ma.kind WHEN 'BANK' THEN '1010' ELSE '1020' END
    JOIN gl_line l ON l.account_id = a.id
    JOIN gl_journal j ON j.id = l.journal_id
   WHERE ma.id = p_account
     AND CASE WHEN ma.kind = 'MOBILE_MONEY' THEN l.channel_id = ma.channel_id
              ELSE l.money_account_id = ma.id OR (l.money_account_id IS NULL AND ma.is_default) END
$$;

-- Live (not undone) matches.
CREATE OR REPLACE VIEW v_bank_matched_statement AS
  SELECT ms.line_id FROM bank_match_statement ms JOIN bank_match m ON m.id = ms.match_id WHERE m.undone_at IS NULL;
CREATE OR REPLACE VIEW v_bank_matched_book AS
  SELECT mb.gl_line_id FROM bank_match_book mb JOIN bank_match m ON m.id = mb.match_id WHERE m.undone_at IS NULL;

-- ---------------------------------------------------------------------------
-- Matching.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bank_match(p_account uuid, p_lines uuid[], p_book bigint[], p_kind text,
                                         p_actor uuid, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_s numeric; v_b numeric; v_id uuid; v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM money_account WHERE id = p_account;
  IF COALESCE(array_length(p_lines, 1), 0) = 0 OR COALESCE(array_length(p_book, 1), 0) = 0 THEN
    RAISE EXCEPTION 'MATCH_NEEDS_BOTH: a match joins statement lines to book lines' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_lines) x WHERE x IN (SELECT line_id FROM v_bank_matched_statement))
     OR EXISTS (SELECT 1 FROM unnest(p_book) x WHERE x IN (SELECT gl_line_id FROM v_bank_matched_book)) THEN
    RAISE EXCEPTION 'ALREADY_MATCHED: one of those lines is matched already' USING ERRCODE = 'check_violation';
  END IF;
  SELECT SUM(amount) INTO v_s FROM bank_statement_line WHERE id = ANY(p_lines) AND money_account_id = p_account;
  SELECT SUM(b.amount) INTO v_b FROM fn_money_account_book(p_account) b WHERE b.gl_line_id = ANY(p_book);
  IF v_s IS NULL OR v_b IS NULL OR v_s <> v_b THEN
    RAISE EXCEPTION 'MATCH_DOES_NOT_AGREE: the statement lines come to %, the book lines to %', v_s, v_b
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO bank_match (tenant_id, money_account_id, kind, matched_by, note)
  VALUES (v_tenant, p_account, p_kind, p_actor, p_note) RETURNING id INTO v_id;
  INSERT INTO bank_match_statement (match_id, line_id, tenant_id) SELECT v_id, x, v_tenant FROM unnest(p_lines) x;
  INSERT INTO bank_match_book (match_id, gl_line_id, tenant_id) SELECT v_id, x, v_tenant FROM unnest(p_book) x;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION fn_bank_unmatch(p_match uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bank_match SET undone_at = now(), undone_by = p_actor WHERE id = p_match AND undone_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_MATCH: %', p_match USING ERRCODE = 'no_data_found'; END IF;
END $$;

-- Automatic matching. Bank: each book line to one statement line of the same
-- amount, the statement up to 5 days later (a deposit takes time to clear),
-- a line whose reference or text carries the book's slip first, then the
-- nearest date. Mobile money: each book line of exactly one statement line's
-- amount on the same day, then each remaining day's book total against the
-- day's remaining statement receipts.
CREATE OR REPLACE FUNCTION fn_bank_auto_match(p_account uuid, p_actor uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; v_line uuid; n int := 0; v_kind text; v_lines uuid[]; v_sum numeric;
BEGIN
  SELECT kind INTO v_kind FROM money_account WHERE id = p_account;
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
END $$;

-- A statement line the books do not have -- a charge, interest, a direct
-- debit: posted to the account named, and matched, in one step.
CREATE OR REPLACE FUNCTION fn_bank_post_statement_line(p_line uuid, p_code text, p_memo text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sl bank_statement_line%ROWTYPE; v_role staff_role; v_j uuid; v_book bigint; v_site uuid;
BEGIN
  SELECT role INTO v_role FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'MANAGER', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: statement items are posted by an accountant, manager or head office'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO sl FROM bank_statement_line WHERE id = p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_LINE: %', p_line USING ERRCODE = 'no_data_found'; END IF;
  IF p_line IN (SELECT line_id FROM v_bank_matched_statement) THEN
    RAISE EXCEPTION 'ALREADY_MATCHED: that statement line is matched already' USING ERRCODE = 'check_violation';
  END IF;
  IF p_code IN ('1010', '1020', '1100', '2000', '1200', '1210', '1110') THEN
    RAISE EXCEPTION 'USE_ITS_SCREEN: a % item is recorded on its own screen (payment, banking, transfer), then matched', p_code
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT site_id INTO v_site FROM money_account WHERE id = sl.money_account_id;
  v_j := fn_gl_post(sl.tenant_id, v_site, 'bank_statement_line', p_line::text,
                    (sl.txn_date + time '12:00') AT TIME ZONE 'Africa/Kampala',
                    COALESCE(NULLIF(trim(p_memo), ''), sl.description),
                    jsonb_build_array(
                      fn_money_account_line(sl.money_account_id, sl.amount, sl.description),
                      jsonb_build_object('code', p_code, 'amount', -sl.amount, 'memo', sl.description)),
                    p_actor);
  SELECT l.id INTO v_book FROM gl_line l JOIN gl_account a ON a.id = l.account_id
   WHERE l.journal_id = v_j AND a.code IN ('1010', '1020');
  PERFORM fn_bank_match(sl.money_account_id, ARRAY[p_line], ARRAY[v_book], 'POSTED', p_actor, p_memo);
  RETURN v_j;
END $$;

-- ---------------------------------------------------------------------------
-- The reconciliation, as of a date.
--   statement balance
--   + money in the books not yet on the statement   (deposits in transit)
--   - money out of the books not yet on the statement (payments not presented)
--   - statement items the books do not have (net)
--   = the books' balance                            -- difference must be nil
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bank_reconciliation(p_account uuid, p_as_of date)
RETURNS TABLE (statement_balance numeric, statement_date date, in_transit numeric, not_presented numeric,
               statement_only numeric, book_balance numeric, difference numeric,
               unmatched_book int, unmatched_statement int, stale_book int)
LANGUAGE sql STABLE AS $$
  WITH book AS (SELECT * FROM fn_money_account_book(p_account) WHERE on_date <= p_as_of),
  stmt AS (SELECT * FROM bank_statement_line WHERE money_account_id = p_account AND txn_date <= p_as_of),
  ub AS (SELECT * FROM book WHERE gl_line_id NOT IN (SELECT gl_line_id FROM v_bank_matched_book)),
  us AS (SELECT * FROM stmt WHERE id NOT IN (SELECT line_id FROM v_bank_matched_statement)),
  sb AS (
    -- The statement's own running balance on its last line to the date, else
    -- the sum of its lines (a statement without a balance column).
    SELECT COALESCE(
      (SELECT balance FROM stmt WHERE balance IS NOT NULL ORDER BY txn_date DESC, line_no DESC LIMIT 1),
      (SELECT SUM(amount) FROM stmt), 0) AS v,
      (SELECT max(txn_date) FROM stmt) AS d)
  SELECT sb.v, sb.d,
         COALESCE((SELECT SUM(amount) FROM ub WHERE amount > 0), 0),
         COALESCE((SELECT -SUM(amount) FROM ub WHERE amount < 0), 0),
         COALESCE((SELECT SUM(amount) FROM us), 0),
         COALESCE((SELECT SUM(amount) FROM book), 0),
         sb.v + COALESCE((SELECT SUM(amount) FROM ub), 0) - COALESCE((SELECT SUM(amount) FROM us), 0)
           - COALESCE((SELECT SUM(amount) FROM book), 0),
         (SELECT count(*)::int FROM ub), (SELECT count(*)::int FROM us),
         -- In the books, and still not on a statement that runs 5 days past it:
         -- not in transit any more -- missing.
         (SELECT count(*)::int FROM ub WHERE ub.on_date < sb.d - 5)
    FROM sb
$$;

-- The items behind it.
CREATE OR REPLACE FUNCTION fn_bank_unmatched(p_account uuid, p_as_of date)
RETURNS TABLE (side text, id text, on_date date, amount numeric, description text, reference text)
LANGUAGE sql STABLE AS $$
  SELECT 'BOOK', b.gl_line_id::text, b.on_date, b.amount, b.memo, b.source
    FROM fn_money_account_book(p_account) b
   WHERE b.on_date <= p_as_of AND b.gl_line_id NOT IN (SELECT gl_line_id FROM v_bank_matched_book)
  UNION ALL
  SELECT 'STATEMENT', sl.id::text, sl.txn_date, sl.amount, sl.description, sl.reference
    FROM bank_statement_line sl
   WHERE sl.money_account_id = p_account AND sl.txn_date <= p_as_of
     AND sl.id NOT IN (SELECT line_id FROM v_bank_matched_statement)
   ORDER BY 3, 1
$$;

-- ---------------------------------------------------------------------------
-- Rights. Money accounts, statements and matches are written by the app (the
-- functions check who); the books only through fcms_ledger.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON money_account TO fcms_app;
GRANT SELECT, INSERT ON money_transfer, bank_statement, bank_statement_line TO fcms_app;
GRANT SELECT, INSERT, UPDATE ON bank_match TO fcms_app;
GRANT SELECT, INSERT ON bank_match_statement, bank_match_book TO fcms_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fcms_ledger;
GRANT INSERT ON bank_match, bank_match_statement, bank_match_book TO fcms_ledger;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['fn_gl_post_money_transfer(uuid)', 'fn_gl_post_banking(uuid)',
                           'fn_bank_post_statement_line(uuid,text,text,uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO fcms_ledger', f);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f);
  END LOOP;
END $$;

-- The reconciliation's controls page gains each money account.
CREATE OR REPLACE FUNCTION fn_gl_controls_checked(p_as_of date)
RETURNS TABLE (control text, detail text, ledger numeric, record numeric, difference numeric, unit text, ok boolean)
LANGUAGE sql STABLE AS $$
  SELECT c.control, c.detail, c.ledger, c.record,
         COALESCE(c.difference, CASE WHEN c.record IS NOT NULL THEN c.ledger - c.record END),
         c.unit,
         CASE WHEN c.record IS NULL AND c.difference IS NULL THEN NULL
              ELSE abs(COALESCE(c.difference, c.ledger - c.record)) < 0.005 END
    FROM fn_gl_controls(p_as_of) c
  UNION ALL
  -- Each account with a statement. The total alone proves little: matched
  -- lines agree by construction. What matters is what is still open -- a
  -- statement line the books do not have, or a book item that should have
  -- cleared 5 days ago and has not. Either is a problem until explained.
  SELECT CASE ma.kind WHEN 'BANK' THEN 'Bank (1010)' ELSE 'Mobile money (1020)' END,
         ma.name || ': ' || CASE WHEN r.unmatched_statement + r.stale_book = 0
                                 THEN 'every statement line is in the books'
                                      || CASE WHEN r.unmatched_book > 0 THEN ' (' || r.unmatched_book || ' in transit)' ELSE '' END
                                 ELSE r.unmatched_statement || ' statement line(s) not in the books, '
                                      || r.stale_book || ' book item(s) not on the statement' END,
         r.book_balance, r.statement_balance,
         r.book_balance - r.statement_balance, 'UGX',
         r.unmatched_statement = 0 AND r.stale_book = 0 AND abs(r.difference) < 0.005
    FROM money_account ma CROSS JOIN LATERAL fn_bank_reconciliation(ma.id, p_as_of) r
   WHERE EXISTS (SELECT 1 FROM bank_statement s WHERE s.money_account_id = ma.id)
$$;
