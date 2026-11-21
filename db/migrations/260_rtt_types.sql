-- =============================================================================
-- FCMS v2 -- 260_rtt_types.sql
--
-- The two enum values RETURN TO TANK needs, and nothing else.
--
-- ON ITS OWN ON PURPOSE. PostgreSQL lets you add an enum value inside a
-- transaction but not USE it in the same one. Migration 270 uses both values
-- -- including inside fn_movement_sign, which is a LANGUAGE sql function and
-- is therefore validated at creation, not at first call. Fold the two files
-- together and 270 fails with "unsafe use of new value of enum type", which
-- reads like a permissions problem and is not one.
--
-- The same lesson as 230/240. It is written down twice because it will be
-- relearned a third time by whoever merges these "to tidy up".
-- =============================================================================

DO $$
BEGIN
  -- A litre that went through the meter and back into the tank. Not a sale:
  -- no money is owed for it. Not stock out: it is still in the ground.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'disposition_kind' AND e.enumlabel = 'RTT'
  ) THEN
    ALTER TYPE disposition_kind ADD VALUE 'RTT';
  END IF;

  -- The matching ledger movement: those litres coming back into the tank.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'movement_kind' AND e.enumlabel = 'RTT_IN'
  ) THEN
    ALTER TYPE movement_kind ADD VALUE 'RTT_IN';
  END IF;
END $$;
