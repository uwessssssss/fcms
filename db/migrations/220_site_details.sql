-- =============================================================================
-- FCMS v2 -- 220_site_details.sql
--
-- A site needs an address and a manager on it.
--
-- The dashboard shows each site as a card: name, where it is, who runs it. The
-- name existed; the other two did not, and the query was returning an empty
-- string for the address and reaching for "any active manager at this site" to
-- find a name.
--
-- That second one is worth spelling out, because it looked like it worked. A
-- site with two managers returned whichever row the planner reached first, so
-- the dashboard could name a different person on each refresh. A card that
-- says who is responsible has to be right, and "responsible" is a fact about
-- the site, not something to be derived from a staff list.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE site ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES staff(id);
ALTER TABLE site ADD COLUMN IF NOT EXISTS revenue_target numeric(16,2);

COMMENT ON COLUMN site.address IS
  'Where the site is, as a person would write it on an envelope. Shown on the '
  'dashboard card and on printed statements.';

COMMENT ON COLUMN site.manager_id IS
  'Who is responsible for this site. Set deliberately, not inferred from who '
  'happens to hold a MANAGER role here -- a site with two managers would '
  'otherwise name a different person on each refresh.';

COMMENT ON COLUMN site.revenue_target IS
  'A daily revenue target, if the dealer sets one. NULL means no target, and '
  'the dashboard shows the figure without a progress bar rather than inventing '
  'a denominator.';

-- ---------------------------------------------------------------------------
-- A manager of a site must actually work there.
--
-- Nothing else would stop a site pointing at somebody from another station,
-- which is the kind of wrong that survives a long time because it reads
-- plausibly on the screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_site_manager_belongs_here() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_site uuid; v_role staff_role;
BEGIN
  IF NEW.manager_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT site_id, role INTO v_site, v_role FROM staff WHERE id = NEW.manager_id;

  IF v_site IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION
      'MANAGER_ELSEWHERE: that person is not on strength at this site.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_role NOT IN ('MANAGER', 'SYSTEM_ADMIN') THEN
    RAISE EXCEPTION
      'NOT_A_MANAGER: % holds the % role, so they cannot be named as the '
      'manager of a site.',
      NEW.manager_id, v_role
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS site_manager_belongs_here ON site;
CREATE TRIGGER site_manager_belongs_here
  BEFORE INSERT OR UPDATE OF manager_id ON site
  FOR EACH ROW EXECUTE FUNCTION trg_site_manager_belongs_here();

-- ---------------------------------------------------------------------------
-- Fill in what the seed already knows.
-- ---------------------------------------------------------------------------
UPDATE site SET address = 'Kampala Road, Kiboga, Uganda'
 WHERE code = 'KIB' AND address IS NULL;

UPDATE site SET address = 'Depot Yard, Kiboga, Uganda'
 WHERE kind = 'DEPOT' AND address IS NULL;

UPDATE site s
   SET manager_id = m.id
  FROM staff m
 WHERE m.site_id = s.id
   AND m.role = 'MANAGER'
   AND m.is_active
   AND s.manager_id IS NULL
   AND (SELECT count(*) FROM staff x
         WHERE x.site_id = s.id AND x.role = 'MANAGER' AND x.is_active) = 1;
