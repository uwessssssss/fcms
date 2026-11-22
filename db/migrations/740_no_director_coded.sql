-- 740: the Director refusal (690) says so in words on screen.
--
-- 690 raised a plain message; without a CODE: prefix the API could only
-- report a generic rule violation. Same rule, coded.
CREATE OR REPLACE FUNCTION fn_staff_no_director()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'DIRECTOR' THEN
    RAISE EXCEPTION 'NO_DIRECTOR: there is no Director user in FCMS. Use HEAD_OFFICE for company-wide reading and approval.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
