-- =============================================================================
-- FCMS v2 -- 210_credit_limit_race.sql
--
-- The credit limit could be exceeded by two sales at once.
--
-- Both paths -- a retail credit sale at the pump and a bulk load at the depot
-- -- read the customer's headroom and then insert against it:
--
--     SELECT credit_limit - balance INTO v_headroom ...   <- both read 500,000
--     IF amount > v_headroom THEN RAISE ...               <- both see room
--     INSERT INTO credit_sale ...                         <- both succeed
--
-- Two transactions interleaved there both pass a check that only one of them
-- should have. Each sees the balance BEFORE the other's insert, because
-- neither took a lock, and Postgres at READ COMMITTED is entitled to show them
-- both the same starting picture.
--
-- This is not a rare theoretical interleaving. It is a haulier with two trucks
-- on the forecourt and an attendant on each, which is an ordinary Tuesday.
-- Both vouchers are written, both are legitimate on their face, and the
-- customer is over their limit by the smaller of the two.
--
-- The fix is one line in each path: lock the CUSTOMER row before reading the
-- headroom. The second transaction then waits for the first to commit and
-- reads the balance including it. Locking the customer rather than the sales
-- is deliberate -- it is the row both paths have in common, and it is the row
-- whose limit is being spent.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_customer_headroom(p_customer_id uuid)
RETURNS TABLE (name text, headroom numeric, balance numeric)
LANGUAGE plpgsql AS $$
DECLARE v_limit numeric; v_name text; v_balance numeric;
BEGIN
  -- FOR UPDATE. Everything else in this function depends on it.
  --
  -- The lock is held until the calling transaction commits, so a second sale
  -- to the same customer waits here and then reads a balance that includes the
  -- first. Sales to DIFFERENT customers are unaffected -- the lock is one row.
  SELECT c.name, c.credit_limit
    INTO v_name, v_limit
    FROM credit_customer c
   WHERE c.id = p_customer_id
     FOR UPDATE;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: no credit customer with that id'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT COALESCE(SUM(s.outstanding), 0)
    INTO v_balance
    FROM v_credit_sale_settlement s
   WHERE s.customer_id = p_customer_id;

  RETURN QUERY SELECT v_name, v_limit - v_balance, v_balance;
END $$;

COMMENT ON FUNCTION fn_customer_headroom IS
  'Headroom, read under a row lock on the customer. Both the retail and the '
  'bulk path must go through this -- reading the balance without the lock lets '
  'two simultaneous sales each pass a limit only one of them should have.';

-- ---------------------------------------------------------------------------
-- The bulk path, rewritten to take the lock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_record_bulk_credit(p_bulk_sale_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_bs       bulk_sale%ROWTYPE;
  v_id       uuid;
  v_name     text;
  v_headroom numeric;
  v_balance  numeric;
BEGIN
  SELECT * INTO v_bs FROM bulk_sale WHERE id = p_bulk_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BULK_SALE_NOT_FOUND: %', p_bulk_sale_id;
  END IF;

  IF v_bs.payment_terms <> 'CREDIT' THEN
    RETURN NULL;      -- cash and prepaid loads owe nothing
  END IF;

  SELECT h.name, h.headroom, h.balance
    INTO v_name, v_headroom, v_balance
    FROM fn_customer_headroom(v_bs.customer_id) h;

  -- Checked here rather than in the application, because a load can also be
  -- recorded by an import or a script and the limit has to hold either way.
  IF v_bs.amount > v_headroom THEN
    RAISE EXCEPTION
      'CREDIT_LIMIT_EXCEEDED: % has % of headroom and this load is %. '
      'Take a payment first, or a director has to raise the limit.',
      v_name, round(v_headroom, 0), round(v_bs.amount, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  -- staff_id is who made the sale. credit_sale has no separate recorded_by,
  -- deliberately: two author columns is two answers to one question.
  INSERT INTO credit_sale (tenant_id, site_id, shift_id, customer_id, vehicle_id,
                           nozzle_id, product_id, litres, unit_price, amount,
                           voucher_no, staff_id, bulk_sale_id, recorded_at)
  VALUES (v_bs.tenant_id, v_bs.site_id, NULL, v_bs.customer_id, NULL,
          NULL, v_bs.product_id, v_bs.litres, v_bs.unit_price, v_bs.amount,
          v_bs.invoice_no, v_bs.recorded_by, v_bs.id, v_bs.loaded_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- The retail path.
--
-- The application reads the headroom and decides. It must read it through the
-- locking function, or the check it performs is the same racy one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_credit_headroom(
  p_customer_id uuid,
  p_amount      numeric
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_name text; v_headroom numeric; v_balance numeric;
BEGIN
  SELECT h.name, h.headroom, h.balance
    INTO v_name, v_headroom, v_balance
    FROM fn_customer_headroom(p_customer_id) h;

  IF p_amount > v_headroom THEN
    RAISE EXCEPTION
      'CREDIT_LIMIT_EXCEEDED: % owes % against a limit that leaves % of room, '
      'and this sale is %. Take a payment first, or a director raises the limit.',
      v_name, round(v_balance, 0), round(v_headroom, 0), round(p_amount, 0)
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMENT ON FUNCTION fn_check_credit_headroom IS
  'Refuses a credit sale that would breach the limit, holding a lock on the '
  'customer so two simultaneous sales cannot both pass.';
