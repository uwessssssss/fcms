-- =============================================================================
-- FCMS v2 -- 120_credit_ageing.sql
--
-- WHICH money is old, not just how much is owed.
--
-- The system already knows a customer's balance. That is the least useful thing
-- you can know about a receivable: a haulier owing 4 million from last week and
-- one owing 4 million since March are the same number and completely different
-- problems, and only one of them is about to become a bad debt.
--
-- Proper ageing needs payments matched against sales. Two ways to do that:
--
--   SPECIFIC ALLOCATION -- every payment names the sales it settles. Correct,
--   and it does not survive contact with a forecourt, where a transporter
--   sends a round number on account and nobody reconciles it until month end.
--
--   FIFO -- the oldest debt is settled first. That is what a station actually
--   does, what the customer assumes, and what a court would assume absent an
--   agreement to the contrary.
--
-- FIFO it is, computed rather than stored, so a late-recorded payment
-- re-ages everything correctly instead of leaving a stale bucket behind.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Running totals per sale, so each one can be told whether the money that has
-- come in reaches it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_credit_sale_settlement AS
WITH sales AS (
  SELECT cs.id,
         cs.tenant_id,
         cs.site_id,
         cs.customer_id,
         cs.recorded_at,
         cs.amount,
         cs.voucher_no,
         -- Everything billed up to and including this sale.
         SUM(cs.amount) OVER (
           PARTITION BY cs.customer_id
           ORDER BY cs.recorded_at, cs.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS billed_through
    FROM credit_sale cs
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
  -- FIFO: money settles the oldest debt first, so a sale is paid to the extent
  -- that total receipts exceed everything billed BEFORE it.
  GREATEST(0, LEAST(s.amount,
    COALESCE(r.paid, 0) - (s.billed_through - s.amount)))          AS settled,
  s.amount - GREATEST(0, LEAST(s.amount,
    COALESCE(r.paid, 0) - (s.billed_through - s.amount)))          AS outstanding,
  (current_date - s.recorded_at::date)                             AS age_days
FROM sales s
LEFT JOIN receipts r ON r.customer_id = s.customer_id;

COMMENT ON VIEW v_credit_sale_settlement IS
  'Per credit sale: how much of it FIFO receipts have settled, and how old the '
  'unsettled part is. Computed, so a late-recorded payment re-ages everything.';

-- ---------------------------------------------------------------------------
-- The ageing summary a dealer actually reads.
--
-- Buckets are 30/60/90 because that is what every counterpart already uses --
-- inventing a house convention here would only make the number harder to argue
-- with a customer over the phone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_credit_ageing_buckets AS
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
  c.credit_limit - COALESCE(SUM(s.outstanding), 0)                  AS headroom,
  c.is_active
FROM credit_customer c
LEFT JOIN v_credit_sale_settlement s
       ON s.customer_id = c.id AND s.outstanding > 0
GROUP BY c.id, c.tenant_id, c.code, c.name, c.credit_limit,
         c.payment_terms_days, c.is_active;

COMMENT ON VIEW v_credit_ageing_buckets IS
  'Standard 30/60/90 ageing plus past_terms, which respects each customers own '
  'agreed days rather than a single house rule.';

-- ---------------------------------------------------------------------------
-- A statement line: every sale and payment in order, with a running balance.
-- This is the document that goes to a customer who disputes their bill, so
-- every line carries the reference that backs it.
-- ---------------------------------------------------------------------------
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
  SELECT cp.customer_id, cp.tenant_id, cp.received_at, 'PAYMENT',
         COALESCE(cp.reference, cp.method), NULL, NULL,
         0::numeric, cp.amount
    FROM credit_payment cp
) rows;
