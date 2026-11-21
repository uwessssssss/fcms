-- =============================================================================
-- FCMS v2 -- 450_paid_ahead.sql
--
-- A customer who pays more than they owe has money on account. It vanished:
-- settlement allocates payments against charges and stops, so anything beyond
-- the last charge counted nowhere -- not as room under the limit, not on the
-- ageing, not in the flag that says where the account stands.
--
-- Receivables stay GROSS (the directors' figure must not be netted against a
-- liability); headroom grows by what is paid ahead; ageing gains an
-- unapplied_credit column at the end.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_customer_headroom(p_customer_id uuid)
RETURNS TABLE (name text, headroom numeric, balance numeric)
LANGUAGE plpgsql AS $$
DECLARE v_limit numeric; v_name text; v_owed numeric; v_ahead numeric;
BEGIN
  SELECT c.name, c.credit_limit INTO v_name, v_limit
    FROM credit_customer c WHERE c.id = p_customer_id
     FOR UPDATE;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: no credit customer with that id'
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT COALESCE(SUM(s.outstanding), 0) INTO v_owed
    FROM v_credit_sale_settlement s WHERE s.customer_id = p_customer_id;
  SELECT amount INTO v_ahead FROM (
    SELECT GREATEST(0,
      COALESCE((SELECT SUM(amount) FROM credit_payment WHERE customer_id = p_customer_id), 0)
    - COALESCE((SELECT SUM(amount) FROM credit_sale  WHERE customer_id = p_customer_id), 0)
    - COALESCE((SELECT SUM(amount) FROM bulk_sale    WHERE customer_id = p_customer_id
                                                       AND payment_terms = 'CREDIT'), 0)) AS amount) x;
  -- balance is NET here -- negative when the customer is in credit -- so the
  -- flag and the screen say what the account actually stands at.
  RETURN QUERY SELECT v_name, v_limit - v_owed + v_ahead, v_owed - v_ahead;
END $$;

CREATE OR REPLACE VIEW v_credit_ageing_buckets AS
WITH paid_ahead AS (
  -- Paid beyond everything billed, pump and depot alike: money the customer
  -- has on account. Kept OUT of balance -- a prepayment is owed to them, a
  -- liability, and netting it would understate receivables.
  SELECT c.id AS customer_id,
         GREATEST(0,
           COALESCE((SELECT SUM(amount) FROM credit_payment p WHERE p.customer_id = c.id), 0)
         - COALESCE((SELECT SUM(amount) FROM credit_sale cs WHERE cs.customer_id = c.id), 0)
         - COALESCE((SELECT SUM(amount) FROM bulk_sale bs
                      WHERE bs.customer_id = c.id AND bs.payment_terms = 'CREDIT'), 0)) AS amount
    FROM credit_customer c
)
SELECT
  c.id                                   AS customer_id,
  c.tenant_id,
  c.code,
  c.name,
  c.credit_limit,
  c.payment_terms_days,
  COALESCE(SUM(s.outstanding), 0)                                   AS balance,
  COALESCE(SUM(s.outstanding) FILTER (WHERE s.age_days <= 30), 0)   AS current_30,
  COALESCE(SUM(s.outstanding) FILTER (WHERE s.age_days BETWEEN 31 AND 60), 0)  AS days_31_60,
  COALESCE(SUM(s.outstanding) FILTER (WHERE s.age_days BETWEEN 61 AND 90), 0)  AS days_61_90,
  COALESCE(SUM(s.outstanding) FILTER (WHERE s.age_days > 90), 0)    AS over_90,
  MAX(s.age_days) FILTER (WHERE s.outstanding > 0)                  AS oldest_days,
  -- Past their own agreed terms, which is the number that starts a
  -- conversation. A 30-day customer at 45 days is late; a 60-day customer at
  -- 45 days is not, and treating them the same loses you one of them.
  COALESCE(SUM(s.outstanding) FILTER (
    WHERE s.age_days > c.payment_terms_days), 0)                    AS past_terms,
  -- Money paid ahead is room to buy with: it was ignored, understating it.
  c.credit_limit - COALESCE(SUM(s.outstanding), 0) + COALESCE(MAX(pa.amount), 0) AS headroom,
  c.is_active,
  COALESCE(MAX(pa.amount), 0)                                       AS unapplied_credit
FROM credit_customer c
LEFT JOIN v_credit_sale_settlement s
       ON s.customer_id = c.id AND s.outstanding > 0
LEFT JOIN paid_ahead pa ON pa.customer_id = c.id
GROUP BY c.id, c.tenant_id, c.code, c.name, c.credit_limit,
         c.payment_terms_days, c.is_active;

