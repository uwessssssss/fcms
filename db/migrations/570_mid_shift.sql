-- =============================================================================
-- FCMS v2 -- 570_mid_shift.sql
--
-- Kiboga runs THREE shifts -- DAY, MID and NIGHT -- and its shift receipts are
-- labelled that way. The schema allowed only DAY and NIGHT, so a real Kiboga
-- day could not be recorded at all. Found by checking FCMS against the real
-- station's records before replaying them. No logic depends on the label: the
-- business date comes from the clock (fn_business_date), not the shift's name.
-- =============================================================================
ALTER TABLE shift           DROP CONSTRAINT shift_label_check,
  ADD CONSTRAINT shift_label_check CHECK (label IN ('DAY', 'MID', 'NIGHT'));
ALTER TABLE shift_pattern   DROP CONSTRAINT shift_pattern_label_check,
  ADD CONSTRAINT shift_pattern_label_check CHECK (label IN ('DAY', 'MID', 'NIGHT'));
ALTER TABLE roster_template DROP CONSTRAINT roster_template_label_check,
  ADD CONSTRAINT roster_template_label_check CHECK (label IS NULL OR label IN ('DAY', 'MID', 'NIGHT'));
