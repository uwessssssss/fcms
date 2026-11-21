-- =============================================================================
-- FCMS v2 -- 480_credit_trigger_per_table.sql
--
-- Found by the first real run. 370's trigger served credit_sale AND bulk_sale,
-- and asked, in ONE expression:
--     TG_TABLE_NAME = 'bulk_sale' AND NEW.payment_terms IS DISTINCT FROM 'CREDIT'
-- expecting the second half to be skipped for credit_sale. PL/pgSQL does not
-- promise that: it resolves NEW.payment_terms, which credit_sale does not
-- have, and fails -- "record new has no field payment_terms". Every credit
-- sale at the pump was refused, and the demo seed with them.
--
-- The field is now read only inside a branch that runs for bulk_sale alone.
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_credit_allowed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bulk_sale' THEN
    -- Reached only for bulk_sale, so payment_terms exists here.
    IF NEW.payment_terms IS DISTINCT FROM 'CREDIT' THEN
      RETURN NEW;                -- a depot load on cash or prepaid terms is not credit
    END IF;
  END IF;
  IF NOT COALESCE((SELECT allow_credit_sales FROM tenant_policy
                    WHERE tenant_id = NEW.tenant_id), TRUE) THEN
    RAISE EXCEPTION
      'CREDIT_SALES_OFF: this company''s policy does not allow sales on account. '
      'Take payment now, or change the policy first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
