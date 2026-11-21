-- =============================================================================
-- FCMS v2 -- 320_role_alignment.sql
--
-- Make each role's permissions match what the rules actually allow.
--
-- Found by computing every role against every screen rather than trying the
-- screens one at a time. Two mismatches were in the grants themselves:
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Head office sets up its own forecourts.
--
-- equipment.manage was held by ADMIN and the system administrator only. A
-- company created through the platform arrives with a head office person --
-- migration 300 -- who then could not add a single tank, pump or nozzle. The
-- company could exist and never trade. Head office runs the company; setting
-- up its equipment is part of that.
--
-- Station managers stay READ-ONLY on equipment. A tank's capacity and a
-- nozzle's digit count shape every figure the ledger produces, so they are a
-- company decision rather than a station one.
-- ---------------------------------------------------------------------------
INSERT INTO role_permission (role, permission)
VALUES ('HEAD_OFFICE', 'equipment.manage')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Only those the approval rule accepts may hold the approval permission.
--
-- ACCOUNTANT and DIRECTOR held shift.approve from before the two-manager rule.
-- Migration 240's trigger accepts only a MANAGER at the same station, or head
-- office, or the system administrator. So the permission said yes, the screen
-- offered the button, and the database then refused -- a promise the system
-- could never keep. The permission now says what the rule says.
--
-- A delete does not reach SYSTEM_ADMIN: its mirror trigger fires on insert,
-- and the system administrator is one of the roles the rule accepts anyway.
-- ---------------------------------------------------------------------------
DELETE FROM role_permission
 WHERE permission = 'shift.approve'
   AND role IN ('ACCOUNTANT', 'DIRECTOR');
