-- =============================================================================
-- FCMS v2 -- test/supplier_balance.sql
--
-- One supplier, two sites: each site's balance is its own invoices less its
-- own payments (750). Run after the seeds. Rolls back.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SELECT set_config('app.tenant_id', '0a000000-0000-4000-8000-000000000001', true) \gset

INSERT INTO supplier (tenant_id, code, name)
VALUES ('0a000000-0000-4000-8000-000000000001', 'TST-SB', 'Two-site supplier');

INSERT INTO supplier_invoice (tenant_id, site_id, supplier_id, invoice_no, invoice_date, amount, currency, recorded_by)
SELECT '0a000000-0000-4000-8000-000000000001', x.site, s.id, x.no, current_date, x.amount, 'UGX',
       '10000000-0000-4000-8000-000000000003'
  FROM supplier s, (VALUES ('0b000000-0000-4000-8000-000000000001'::uuid, 'SB-1', 1000::numeric),
                           ('0b000000-0000-4000-8000-000000000002'::uuid, 'SB-2', 5000)) x(site, no, amount)
 WHERE s.code = 'TST-SB';

INSERT INTO supplier_payment (tenant_id, site_id, supplier_id, amount, currency, method, paid_on, recorded_by)
SELECT '0a000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000001', id, 400, 'UGX',
       'BANK', current_date, '10000000-0000-4000-8000-000000000003'
  FROM supplier WHERE code = 'TST-SB';

DO $$
DECLARE n int; st numeric; dp numeric;
BEGIN
  SELECT count(*),
         SUM(balance) FILTER (WHERE site_id = '0b000000-0000-4000-8000-000000000001'),
         SUM(balance) FILTER (WHERE site_id = '0b000000-0000-4000-8000-000000000002')
    INTO n, st, dp
    FROM v_supplier_balance WHERE code = 'TST-SB';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL supplier balance: % rows for two sites', n; END IF;
  IF st <> 600 THEN RAISE EXCEPTION 'FAIL supplier balance: station owes %, not 600', st; END IF;
  IF dp <> 5000 THEN RAISE EXCEPTION 'FAIL supplier balance: depot owes %, not 5000', dp; END IF;
  RAISE NOTICE 'PASS  supplier balance: each site billed against its own payments';
END $$;
ROLLBACK;
