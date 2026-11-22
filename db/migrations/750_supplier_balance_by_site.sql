-- 750: supplier balances, one row per supplier per site, billed against paid
-- AT THE SAME SITE.
--
-- The view grouped invoices and payments by supplier and site, then joined
-- both to the supplier on supplier_id alone. A supplier that billed two sites
-- paired each site's invoices with every site's payments: the rows multiplied
-- and every balance was wrong. It held only because no supplier yet traded
-- with more than one site.
--
-- Same columns, same order, so dependants keep working.
CREATE OR REPLACE VIEW v_supplier_balance AS
WITH billed AS (
  SELECT supplier_id, site_id,
         SUM(amount)       AS billed,
         MIN(invoice_date) AS oldest,
         MIN(due_date) FILTER (WHERE due_date IS NOT NULL) AS earliest_due
    FROM supplier_invoice
   GROUP BY supplier_id, site_id
), paid AS (
  SELECT supplier_id, site_id, SUM(amount) AS paid
    FROM supplier_payment
   GROUP BY supplier_id, site_id
), pair AS (
  SELECT COALESCE(b.supplier_id, p.supplier_id) AS supplier_id,
         COALESCE(b.site_id, p.site_id)         AS site_id,
         b.billed, p.paid, b.oldest, b.earliest_due
    FROM billed b
    FULL JOIN paid p ON p.supplier_id = b.supplier_id AND p.site_id = b.site_id
)
SELECT s.id AS supplier_id,
       s.tenant_id,
       x.site_id,
       s.code,
       s.name,
       COALESCE(x.billed, 0) AS billed,
       COALESCE(x.paid, 0)   AS paid,
       COALESCE(x.billed, 0) - COALESCE(x.paid, 0) AS balance,
       x.oldest AS oldest_invoice,
       x.earliest_due,
       (x.earliest_due IS NOT NULL AND x.earliest_due < CURRENT_DATE
        AND COALESCE(x.billed, 0) > COALESCE(x.paid, 0)) AS overdue
  FROM supplier s
  LEFT JOIN pair x ON x.supplier_id = s.id;
