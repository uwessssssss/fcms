-- =============================================================================
-- FCMS v2 -- 180_duty_period_links.sql
--
-- Reports listed every past shift and could not open any of them.
--
-- v_duty_period groups by business date and label, because a duty period is
-- one stretch of trading even when a price change cut it into three shifts.
-- That grouping is right, and it threw away the shift ids on the way -- so the
-- screen had a list of nights and nothing to click.
--
-- Adding the ids at the end, which CREATE OR REPLACE VIEW permits. All of
-- them, not just the first: a night cut by a price change has three
-- certificates and a manager may want the one covering a particular hour.
-- =============================================================================

CREATE OR REPLACE VIEW v_duty_period AS
SELECT tenant_id, site_id, business_date, label,
       count(*)                                  AS segments,
       min(opened_at)                            AS started_at,
       max(closed_at)                            AS ended_at,
       array_agg(closed_reason ORDER BY segment)
         FILTER (WHERE closed_reason IS NOT NULL) AS cut_reasons,
       bool_and(state IN ('APPROVED','POSTED'))   AS fully_signed_off,
       -- New, at the end.
       array_agg(id ORDER BY segment)            AS shift_ids,
       (array_agg(id ORDER BY segment))[1]       AS first_shift_id
  FROM shift
 WHERE state <> 'VOID'
 GROUP BY tenant_id, site_id, business_date, label;

COMMENT ON VIEW v_duty_period IS
  'One stretch of trading, however many shifts it was cut into. shift_ids '
  'carries every segment so a report can be opened; a night broken by a price '
  'change has more than one.';

-- ---------------------------------------------------------------------------
-- What each attendant handed in, split by how it arrived.
--
-- The close collects cash, MTN, Airtel and Visa separately -- the constraint
-- on money_movement refuses a mobile money tender that does not name its
-- channel -- and nothing ever showed it back. So "what did Moses hand in on
-- Tuesday, and how much of it was Airtel" had no answer once the shift closed.
--
-- That is the question a dealer asks when a mobile money statement does not
-- reconcile, which is the whole reason the channel is recorded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_attendant_tender AS
SELECT
  s.id                    AS shift_id,
  s.site_id,
  s.business_date,
  s.label::text           AS shift_label,
  c.id                    AS cash_up_id,
  st.id                   AS attendant_id,
  st.full_name            AS attendant_name,
  st.employee_no,
  m.settlement::text      AS settlement,
  pc.code                 AS channel_code,
  pc.name                 AS channel_name,
  pc.till_number,
  -- Settlements are stored negative, because they reduce what is owed. A
  -- person reading a statement wants the amount handed in.
  abs(m.amount)           AS amount,
  m.reference
FROM money_movement m
JOIN cash_up c  ON c.id = m.cash_up_id
JOIN shift s    ON s.id = c.shift_id
JOIN staff st   ON st.id = c.staff_id
LEFT JOIN payment_channel pc ON pc.id = m.channel_id
WHERE m.entry = 'SETTLEMENT';

COMMENT ON VIEW v_attendant_tender IS
  'Every shilling handed in, by attendant and by channel. Reconciling an '
  'Airtel statement means adding up Airtel across attendants; querying one '
  'attendant means reading down their rows.';
