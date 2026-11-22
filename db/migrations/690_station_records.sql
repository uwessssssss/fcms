-- 690: FCMS is the record of stations and depots: shifts, stock, cash, credit.
-- (Nov 2026, at the owner's instruction.)
--
-- 1. No Director user. Anyone holding the role is signed out for good and
--    loses its permissions; the role can no longer be given. The enum value
--    stays (Postgres cannot drop one in use by history), dormant: the role
--    checks in the older functions that still name it can never match a
--    signed-in user, because no active staff can hold it.
-- 2. No trial balance. The ledger stays as the thing the shift controls are
--    checked against; its first control is renamed for what it proves.

-- 1 -------------------------------------------------------------------------
UPDATE staff SET is_active = FALSE WHERE role = 'DIRECTOR' AND is_active;
DELETE FROM role_permission WHERE role = 'DIRECTOR';

CREATE OR REPLACE FUNCTION fn_staff_no_director()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'DIRECTOR' THEN
    RAISE EXCEPTION 'There is no Director user in FCMS. Use HEAD_OFFICE for company-wide reading and approval.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS staff_no_director ON staff;
CREATE TRIGGER staff_no_director
  BEFORE INSERT OR UPDATE OF role ON staff
  FOR EACH ROW EXECUTE FUNCTION fn_staff_no_director();

CREATE OR REPLACE FUNCTION fn_role_permission_no_director()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'DIRECTOR' THEN
    RAISE EXCEPTION 'The Director role is retired and takes no permissions.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS role_permission_no_director ON role_permission;
CREATE TRIGGER role_permission_no_director
  BEFORE INSERT OR UPDATE ON role_permission
  FOR EACH ROW EXECUTE FUNCTION fn_role_permission_no_director();

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_controls_checked(p_as_of date)
RETURNS TABLE (control text, detail text, ledger numeric, record numeric, difference numeric, unit text, ok boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE c.control WHEN 'Trial balance' THEN 'Journals balance' ELSE c.control END,
         CASE c.control WHEN 'Trial balance' THEN 'every journal: debits equal credits' ELSE c.detail END,
         c.ledger, c.record,
         COALESCE(c.difference, CASE WHEN c.record IS NOT NULL THEN c.ledger - c.record END),
         c.unit,
         CASE WHEN c.record IS NULL AND c.difference IS NULL THEN NULL
              ELSE abs(COALESCE(c.difference, c.ledger - c.record)) < 0.005 END
    FROM fn_gl_controls(p_as_of) c
  UNION ALL
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
ALTER FUNCTION fn_gl_controls_checked(date) OWNER TO fcms_ledger;
