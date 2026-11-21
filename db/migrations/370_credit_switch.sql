-- =============================================================================
-- FCMS v2 -- 370_credit_switch.sql
--
-- "Allow credit sales" was a switch on the administration screen that nothing
-- read. Turned off, fuel still went out on account -- at the pump and at the
-- depot. Seven other policy settings are in the same state (see HANDOVER);
-- this one has an unambiguous meaning, so it is enforced here.
--
-- BEFORE INSERT, so the refusal comes first and says why -- ahead of any
-- other check the row would meet.
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_credit_allowed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A depot load on cash or prepaid terms is not credit.
  IF TG_TABLE_NAME = 'bulk_sale' AND NEW.payment_terms IS DISTINCT FROM 'CREDIT' THEN
    RETURN NEW;
  END IF;
  -- A company with no policy row keeps the default: credit allowed.
  IF NOT COALESCE((SELECT allow_credit_sales FROM tenant_policy
                    WHERE tenant_id = NEW.tenant_id), TRUE) THEN
    RAISE EXCEPTION
      'CREDIT_SALES_OFF: this company''s policy does not allow sales on account. '
      'Take payment now, or change the policy first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS credit_allowed ON credit_sale;
CREATE TRIGGER credit_allowed BEFORE INSERT ON credit_sale
  FOR EACH ROW EXECUTE FUNCTION trg_credit_allowed();

DROP TRIGGER IF EXISTS credit_allowed ON bulk_sale;
CREATE TRIGGER credit_allowed BEFORE INSERT ON bulk_sale
  FOR EACH ROW EXECUTE FUNCTION trg_credit_allowed();
