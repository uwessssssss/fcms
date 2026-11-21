-- =============================================================================
-- FCMS v2 -- 440_one_account_per_customer.sql
--
-- A trade customer has ONE account: what they took at the pump and what they
-- loaded at the depot, against everything they paid.
--
-- Depot loads on credit are sold to the same credit_customer, but the account
-- was built from forecourt sales alone:
--   * the limit ignored depot debt -- a customer owing hundreds of millions at
--     the depot still had full headroom at the pump;
--   * a depot credit load was checked against no limit at all;
--   * payments were applied oldest-first against FORECOURT sales only -- money
--     paid for a depot invoice settled pump sales, and any excess vanished;
--   * ageing, and the directors' receivables built on it, left out the depot
--     -- in this business, most of what customers owe;
--   * the customer's statement listed every payment but no depot load: a
--     customer who owed 228 million could be sent a statement showing credit.
--
-- Columns keep their names and order; `source` is added at the end.
-- =============================================================================

CREATE OR REPLACE VIEW v_credit_sale_settlement AS
WITH charges AS (
  SELECT cs.id, cs.tenant_id, cs.site_id, cs.customer_id, cs.recorded_at,
         cs.voucher_no, cs.amount, 'FORECOURT'::text AS source
    FROM credit_sale cs
  UNION ALL
  SELECT bs.id, bs.tenant_id, bs.site_id, bs.customer_id, bs.loaded_at,
         bs.invoice_no, bs.amount, 'DEPOT'::text
    FROM bulk_sale bs
   WHERE bs.payment_terms = 'CREDIT'
), sales AS (
  SELECT c.*,
         -- Everything billed up to and including this charge, pump and depot alike.
         SUM(c.amount) OVER (
           PARTITION BY c.customer_id
           ORDER BY c.recorded_at, c.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS billed_through
    FROM charges c
), receipts AS (
  SELECT customer_id, SUM(amount) AS paid
    FROM credit_payment GROUP BY customer_id
)
SELECT
  s.id                          AS credit_sale_id,
  s.tenant_id,
  s.site_id,
  s.customer_id,
  s.recorded_at,
  s.voucher_no,
  s.amount,
  GREATEST(0, LEAST(s.amount,
    COALESCE(r.paid, 0) - (s.billed_through - s.amount)))          AS settled,
  s.amount - GREATEST(0, LEAST(s.amount,
    COALESCE(r.paid, 0) - (s.billed_through - s.amount)))          AS outstanding,
  (current_date - s.recorded_at::date)                             AS age_days,
  s.source
FROM sales s
LEFT JOIN receipts r ON r.customer_id = s.customer_id;

CREATE OR REPLACE VIEW v_credit_statement AS
SELECT customer_id, tenant_id, at, kind, reference, vehicle, litres, debit, credit,
       SUM(debit - credit) OVER (
         PARTITION BY customer_id ORDER BY at, kind, reference
       ) AS running_balance
FROM (
  SELECT cs.customer_id, cs.tenant_id, cs.recorded_at AS at, 'FUEL' AS kind,
         COALESCE(cs.voucher_no, 'no voucher') AS reference,
         cv.plate_no AS vehicle, cs.litres,
         cs.amount AS debit, 0::numeric AS credit
    FROM credit_sale cs
    LEFT JOIN credit_vehicle cv ON cv.id = cs.vehicle_id
  UNION ALL
  -- Depot loads on account: the invoice, the truck, the litres.
  SELECT bs.customer_id, bs.tenant_id, bs.loaded_at, 'DEPOT_LOAD',
         bs.invoice_no, bs.truck_reg, bs.litres,
         bs.amount, 0::numeric
    FROM bulk_sale bs
   WHERE bs.payment_terms = 'CREDIT'
  UNION ALL
  SELECT cp.customer_id, cp.tenant_id, cp.received_at, 'PAYMENT',
         COALESCE(cp.reference, cp.method), NULL, NULL,
         0::numeric, cp.amount
    FROM credit_payment cp
) rows;

-- A depot credit load over the limit is RECORDED and FLAGGED, as at the pump:
-- by the time it is recorded the truck is loaded, and refusing the record
-- would lose the debt, not prevent it. Prevention is headroom shown BEFORE
-- loading (the depot screen). fn_customer_headroom locks the customer row, so
-- two loads at once cannot both pass under the limit unflagged.
CREATE OR REPLACE FUNCTION trg_bulk_credit_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_name text; v_headroom numeric; v_balance numeric;
BEGIN
  IF NEW.payment_terms IS DISTINCT FROM 'CREDIT' THEN
    RETURN NEW;
  END IF;
  SELECT h.name, h.headroom, h.balance INTO v_name, v_headroom, v_balance
    FROM fn_customer_headroom(NEW.customer_id) h;
  IF NEW.amount > v_headroom THEN
    PERFORM fn_raise_flag(NEW.tenant_id, NEW.site_id, NULL, 'bulk_sale', NEW.id::text,
                          'CREDIT_LIMIT_EXCEEDED', 'WARN',
                          jsonb_build_object('customer', v_name, 'balance', v_balance,
                                             'headroom', v_headroom, 'this_load', NEW.amount));
  END IF;
  RETURN NEW;
END $$;

-- Named to run AFTER credit_allowed (triggers fire alphabetically): if credit
-- is switched off, that refuses first and this never flags.
DROP TRIGGER IF EXISTS credit_limit_flag ON bulk_sale;
CREATE TRIGGER credit_limit_flag BEFORE INSERT ON bulk_sale
  FOR EACH ROW EXECUTE FUNCTION trg_bulk_credit_limit();
