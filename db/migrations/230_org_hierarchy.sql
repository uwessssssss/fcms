-- =============================================================================
-- FCMS v2 -- 230_org_hierarchy.sql
--
-- WHO MAY CREATE WHOM, AND WHO MAY APPROVE WHOSE WORK.
--
-- The system had one flat idea of an organisation: a tenant with sites under
-- it, and staff attached to sites. That was enough while one dealer ran one
-- station. It is not enough now, and the gap is not cosmetic -- it is the
-- difference between a control that holds and one that merely looks like it
-- does.
--
-- THE SHAPE
--
--   COMPANY        a legal entity. Owns sites, holds the trading policy.
--     |
--     +-- HEAD OFFICE   one per company. Not a trading site: no tanks, no
--     |                 pumps, no shifts. It exists so that "who runs this
--     |                 company" is a row rather than a convention.
--     |
--     +-- SITE          a station or a depot. Trades.
--           |
--           +-- STAFF   attached to exactly one site
--
-- WHO CREATES WHOM
--
--   SYSTEM_ADMIN   creates companies, head offices and sites. Belongs to no
--                  company -- they are the person who sets one up, and a row
--                  that belongs to the thing it creates cannot create it.
--   HEAD_OFFICE    creates managers within its own company, and nothing
--                  outside it.
--   MANAGER        runs a site. Cannot create another manager: a control that
--                  lets the controlled party appoint their own reviewer is not
--                  a control.
--
-- THE RULE THIS FILE EXISTS FOR
--
-- A shift is closed by one manager and approved by ANOTHER MANAGER AT THE SAME
-- SITE. The old schema enforced only that the two people differed, which a
-- supervisor and a manager satisfy -- and a supervisor approving their own
-- supervisor's cash-up is the arrangement the rule was written to prevent.
--
-- So a site with one manager cannot approve its own shifts, and the database
-- says so at the point of approval rather than letting it through and leaving
-- an auditor to find it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. COMPANY
--
-- `tenant` already holds a company's identity and its trading policy, and
-- renaming it would touch every policy, every function and every test for no
-- gain. It IS the company; this makes that legible and adds what a company
-- needs that a tenant did not.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS legal_name      text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS registration_no text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS tax_id          text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS head_office_id  uuid;

COMMENT ON TABLE tenant IS
  'A company. One legal entity, one set of books, one trading policy. Every '
  'row in this database belongs to exactly one, and row-level security makes '
  'that a boundary rather than a filter.';

COMMENT ON COLUMN tenant.registration_no IS
  'Company registration number. Appears on statements a company must be able '
  'to hand to an auditor or a revenue authority.';

-- ---------------------------------------------------------------------------
-- 2. SITE KIND: a head office is not a station
--
-- Modelling head office as a site is the pragmatic choice -- staff attach to
-- sites, permissions scope to sites, and a separate org-unit table would mean
-- two paths for every one of those. But a head office must never be mistaken
-- for a trading site, so it is a KIND, and the constraints below make the
-- difference real rather than nominal.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'site_kind' AND e.enumlabel = 'HEAD_OFFICE'
  ) THEN
    ALTER TYPE site_kind ADD VALUE 'HEAD_OFFICE';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. ROLES: system administrator and head office
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'staff_role' AND e.enumlabel = 'HEAD_OFFICE'
  ) THEN
    ALTER TYPE staff_role ADD VALUE 'HEAD_OFFICE';
  END IF;
END $$;
