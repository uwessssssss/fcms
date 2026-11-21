-- =============================================================================
-- FCMS v2 -- 160_system_admin.sql
--
-- A role that can do everything, and the limits on what that means.
--
-- "Can perform everything" is a reasonable thing to want and a dangerous thing
-- to implement literally. In a system whose entire promise is that every litre
-- and every shilling reconciles, an account that can change anything silently
-- makes the audit trail worthless -- and it is worthless precisely on the day
-- somebody needs it, which is the day a figure moved and nobody will say who
-- moved it.
--
-- So the rule here is narrow and deliberate:
--
--   SYSTEM_ADMIN BYPASSES PERMISSIONS. Every action in the system is open to
--   it without a grant.
--
--   SYSTEM_ADMIN DOES NOT BYPASS IMMUTABILITY. The append-only rules on the
--   ledgers, the segregation constraint on shift approval, and the refusal to
--   close on an unexplained variance all still hold. Those are not permissions
--   -- they are the properties that make the numbers mean anything.
--
-- The distinction is enforced structurally rather than by convention: the
-- ledgers carry DO INSTEAD NOTHING rules, which apply to every role including
-- this one. An administrator who needs to change a posted figure writes a
-- reversal with a reason, exactly as anyone else would.
-- =============================================================================

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'SYSTEM_ADMIN';

COMMIT;   -- a new enum label cannot be used in the transaction that adds it
BEGIN;

-- Every permission the system defines, granted in one statement rather than a
-- list. A hand-maintained list is a list that falls behind the day somebody
-- adds a permission and forgets this file.
INSERT INTO role_permission (role, permission)
SELECT 'SYSTEM_ADMIN', permission
  FROM (SELECT DISTINCT permission FROM role_permission) p
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Keeping it complete without maintenance.
--
-- A trigger, so a permission added for any role tomorrow is held by the system
-- administrator the moment it exists. Otherwise "can do everything" silently
-- becomes "could do everything as of the day it was written".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_system_admin_holds_everything() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role <> 'SYSTEM_ADMIN' THEN
    INSERT INTO role_permission (role, permission)
    VALUES ('SYSTEM_ADMIN', NEW.permission)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER system_admin_holds_everything
  AFTER INSERT ON role_permission
  FOR EACH ROW EXECUTE FUNCTION trg_system_admin_holds_everything();

-- ---------------------------------------------------------------------------
-- Everything a system administrator does is recorded.
--
-- This is the other half of the bargain. An account that can do anything is
-- acceptable only if it cannot do anything QUIETLY -- so its actions are
-- written to the audit log whether or not the feature being used bothers to
-- log anything itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_note_admin_action(
  p_entity    text,
  p_entity_id text,
  p_action    text,
  p_detail    jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_role staff_role; v_staff uuid;
BEGIN
  v_staff := NULLIF(current_setting('app.staff_id', TRUE), '')::uuid;
  IF v_staff IS NULL THEN RETURN; END IF;

  SELECT role INTO v_role FROM staff WHERE id = v_staff;
  IF v_role <> 'SYSTEM_ADMIN' THEN RETURN; END IF;

  -- audit_log records a before and an after, not a free-form detail. An admin
  -- action has no "before", so the payload goes in after_data.
  INSERT INTO audit_log (tenant_id, actor_id, entity, entity_id, action,
                         after_data, occurred_at)
  SELECT s.tenant_id, v_staff, p_entity, p_entity_id,
         'ADMIN:' || p_action, p_detail, now()
    FROM staff s WHERE s.id = v_staff;
END $$;

COMMENT ON FUNCTION fn_note_admin_action IS
  'Records what a system administrator did. An account that can do anything is '
  'acceptable only if it cannot do it quietly.';

-- ---------------------------------------------------------------------------
-- What an administrator has been doing lately, for a director to read.
--
-- Deliberately its own view rather than a filter somebody has to remember to
-- apply. The point of an unrestricted role is that its use is visible without
-- anyone going looking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_activity AS
SELECT a.id,
       a.tenant_id,
       s.full_name        AS admin_name,
       s.employee_no,
       a.entity,
       a.entity_id,
       replace(a.action, 'ADMIN:', '') AS action,
       a.after_data AS detail,
       a.occurred_at,
       host(a.ip_address) AS ip_address
  FROM audit_log a
  JOIN staff s ON s.id = a.actor_id
 WHERE s.role = 'SYSTEM_ADMIN'
 ORDER BY a.occurred_at DESC;

COMMENT ON VIEW v_admin_activity IS
  'Every action by an unrestricted account. Its own view rather than a filter '
  'somebody has to remember to apply.';

-- ---------------------------------------------------------------------------
-- A note on the forecourt model, recorded here because it is load-bearing and
-- invisible.
--
-- A PUMP IS A HOUSING. It has no tank and no product. Nozzles carry the tank,
-- and product is read from that tank -- a nozzle labelled petrol wired to the
-- diesel tank is not a reporting inconvenience, it is a wrecked engine and a
-- claim.
--
-- The consequences, which the schema already satisfies and which must keep
-- being true:
--
--   * A pump may have any number of nozzles. One, two, four, six. Nothing
--     stores a count; it is however many nozzle rows point at it.
--
--   * A pump may mix products. Two AGO nozzles and two PMS nozzles on the same
--     housing is ordinary, and works only because product lives on the tank.
--
--   * Nozzles on DIFFERENT pumps may draw from the SAME tank. Therefore wet
--     stock reconciliation groups by TANK and never by pump. Any query that
--     totals throughput per pump will under-report the moment one tank feeds
--     two pumps, and it will do so quietly.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE pump IS
  'A physical housing. Carries no tank and no product -- nozzles carry the '
  'tank, and product is read from it. Any number of nozzles, and they may '
  'serve different products.';

COMMENT ON COLUMN nozzle.tank_id IS
  'Which tank this nozzle draws from. Product comes from here and is never set '
  'separately. Nozzles on different pumps may share a tank, which is why stock '
  'reconciliation groups by tank rather than by pump.';

-- Throughput per tank, across every pump. The shape reconciliation must use.
CREATE OR REPLACE VIEW v_tank_throughput AS
SELECT
  s.id                      AS shift_id,
  s.site_id,
  s.business_date,
  t.id                      AS tank_id,
  t.code                    AS tank_code,
  p.code                    AS product_code,
  count(DISTINCT n.pump_id) AS pumps_served,
  count(DISTINCT n.id)      AS nozzles_served,
  COALESCE(SUM(me.gross_litres), 0) AS gross_litres,
  COALESCE(SUM(md.litres) FILTER (WHERE md.kind = 'SALE'), 0)      AS sold_litres,
  COALESCE(SUM(md.litres) FILTER (WHERE md.kind = 'PUMP_TEST'), 0) AS tested_litres,
  COALESCE(SUM(md.litres) FILTER (WHERE md.kind = 'OWN_USE'), 0)   AS own_use_litres
FROM shift s
JOIN meter_event me ON me.shift_id = s.id
JOIN nozzle n       ON n.id = me.nozzle_id
JOIN tank t         ON t.id = n.tank_id
JOIN product p      ON p.id = t.product_id
LEFT JOIN metered_disposition md ON md.meter_event_id = me.id
GROUP BY s.id, s.site_id, s.business_date, t.id, t.code, p.code;

COMMENT ON VIEW v_tank_throughput IS
  'Litres out of each tank in a shift, summed across every nozzle on every '
  'pump that draws from it. pumps_served > 1 is normal and is exactly the case '
  'a per-pump total would get wrong.';
