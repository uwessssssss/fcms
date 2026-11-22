-- =============================================================================
-- 680 A customer's balance counts what the depot sold them on credit
--     (audit November 2026, found by the end-to-end value test)
--
-- v_credit_ageing (060) billed credit_sale only: forecourt credit. Depot bulk
-- sales on CREDIT terms (bulk_sale, later) never reached it, though payments
-- for them did. The Credit Customers screen reads its balance and headroom
-- from this view, so on the demo a wholesaler who owed 112,640,000 showed 0,
-- and one who owed 49,910,000 showed -40,000,000 -- and the headroom said they
-- could be sold that much more on credit. The books (fn_customer_headroom,
-- v_credit_sale_settlement, the ageing buckets) were right all along.
--
-- Same columns, same order: CREATE OR REPLACE keeps every caller working.
-- =============================================================================
CREATE OR REPLACE VIEW v_credit_ageing AS
WITH charges AS (
  SELECT tenant_id, customer_id, amount, recorded_at AS at FROM credit_sale
  UNION ALL
  SELECT tenant_id, customer_id, amount, loaded_at FROM bulk_sale WHERE payment_terms = 'CREDIT'
), billed AS (
  SELECT tenant_id, customer_id, SUM(amount) AS billed, min(at) AS oldest
    FROM charges GROUP BY tenant_id, customer_id
), paid AS (
  SELECT tenant_id, customer_id, SUM(amount) AS paid
    FROM credit_payment GROUP BY tenant_id, customer_id
)
SELECT c.id AS customer_id,
       c.tenant_id,
       c.code,
       c.name,
       c.credit_limit,
       COALESCE(b.billed, 0::numeric) AS billed,
       COALESCE(p.paid, 0::numeric)   AS paid,
       COALESCE(b.billed, 0::numeric) - COALESCE(p.paid, 0::numeric) AS balance,
       c.credit_limit - (COALESCE(b.billed, 0::numeric) - COALESCE(p.paid, 0::numeric)) AS headroom,
       b.oldest AS oldest_invoice
  FROM credit_customer c
  LEFT JOIN billed b ON b.customer_id = c.id
  LEFT JOIN paid p   ON p.customer_id = c.id;
