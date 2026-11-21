-- =============================================================================
-- FCMS v2 -- 350_hot_path_indexes.sql
--
-- PostgreSQL does not index foreign keys on its own. 107 are unindexed and
-- most should stay that way -- "recorded by", "approved by" are never searched
-- on, and an index on each would tax every write for nothing. These four are
-- read on hot paths, on tables that grow every shift:
-- =============================================================================

-- The wiring freeze (340) asks "has this nozzle ever been read?" on every
-- nozzle update. Unindexed, that reads every meter reading ever taken.
CREATE INDEX IF NOT EXISTS meter_reading_nozzle_idx ON meter_reading (nozzle_id);

-- The shift detail joins each assignment to its meter event.
CREATE INDEX IF NOT EXISTS meter_event_assignment_idx ON meter_event (assignment_id);

-- The no-over-recovery rule (280) totals a shortage's recoveries -- under a
-- row lock -- on every repayment. A sequential scan there holds the lock
-- while it reads every recovery in the company.
CREATE INDEX IF NOT EXISTS shortage_recovery_shortage_idx ON shortage_recovery (shortage_id);

-- Book stock is the hottest read in the system: the dashboard, the tank
-- screen and every shift detail call it per tank, and it sums the tank's
-- WHOLE history each time. The existing (tank_id, occurred_at, id) index
-- finds the rows but must visit the table for signed_litres; carrying it IN
-- the index lets the sum be answered from the index alone.
CREATE INDEX IF NOT EXISTS fuel_movement_book_stock_idx
  ON fuel_movement (tank_id, occurred_at) INCLUDE (signed_litres);
