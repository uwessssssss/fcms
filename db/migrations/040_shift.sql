-- =============================================================================
-- FCMS v2 -- 040_shift.sql
--
-- TWO SHIFTS A DAY. SOMETIMES THREE.
--
-- A station runs DAY and NIGHT. But a price change, a delivery, a stock count
-- or an incident can land in the middle of one, and when it does the shift must
-- be cut: the fuel before the event and the fuel after it settle at different
-- prices, against different stock positions, and -- critically -- an attendant
-- must not carry a meter across a price change.
--
-- The wrong model is "sometimes there are three shifts". A supervisor does not
-- think of it that way: they worked ONE day shift, which happened to get cut
-- when the price moved at 2pm.
--
-- So the model is:
--
--   business_date + label   = the DUTY PERIOD a human recognises (DAY / NIGHT)
--   segment                 = which piece of it, after any cuts (1, 2, 3 ...)
--
-- Every report rolls up on (business_date, label), so "Day shift" still reads
-- as one thing on paper. Reconciliation happens per SEGMENT, because that is
-- the unit where one price was in force and one set of meters ran start to end.
--
-- v1 had this insight and got it right. It is kept, with the state machine
-- tightened so a segment cannot be closed without a successor when the reason
-- demands one.
-- =============================================================================

CREATE TABLE shift_pattern (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  label        text NOT NULL CHECK (label IN ('DAY','NIGHT')),
  starts_at    time NOT NULL,
  nominal_hours numeric(4,1) NOT NULL CHECK (nominal_hours > 0 AND nominal_hours <= 24),
  -- A night shift starts on one calendar day and ends on the next, but belongs
  -- to the business date it STARTED on. This flag is what stops a 22:00-06:00
  -- shift being filed under two different days.
  crosses_midnight boolean NOT NULL DEFAULT FALSE,
  is_active    boolean NOT NULL DEFAULT TRUE,
  UNIQUE (site_id, label)
);

-- ---------------------------------------------------------------------------
-- Which business date does a moment belong to? One function, so the API, the
-- reports and any ad-hoc SQL all agree. A night shift closing at 05:30 files
-- under yesterday.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_business_date(p_site_id uuid, p_at timestamptz)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE v_tz text; v_start time; v_local timestamp;
BEGIN
  SELECT timezone, day_starts_at INTO v_tz, v_start FROM site WHERE id = p_site_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_SITE: %', p_site_id USING ERRCODE = 'no_data_found';
  END IF;
  v_local := p_at AT TIME ZONE v_tz;
  RETURN CASE WHEN v_local::time < v_start
              THEN (v_local::date - 1) ELSE v_local::date END;
END $$;

-- ---------------------------------------------------------------------------
-- The shift segment.
-- ---------------------------------------------------------------------------
CREATE TABLE shift (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),

  business_date date NOT NULL,
  label         text NOT NULL CHECK (label IN ('DAY','NIGHT')),
  segment       int  NOT NULL DEFAULT 1 CHECK (segment >= 1),

  -- The segment this one continues from, when a cut happened. Following the
  -- chain reconstructs the whole duty period in order.
  predecessor_id uuid REFERENCES shift(id),

  state         shift_state NOT NULL DEFAULT 'OPEN',
  opened_at     timestamptz NOT NULL,
  closed_at     timestamptz,
  closed_reason close_reason,

  opened_by     uuid NOT NULL REFERENCES staff(id),
  closed_by     uuid REFERENCES staff(id),
  approved_by   uuid REFERENCES staff(id),
  approved_at   timestamptz,
  posted_at     timestamptz,
  void_reason   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (site_id, business_date, label, segment),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CHECK (segment = 1 OR predecessor_id IS NOT NULL),

  -- A closed segment must say why it closed. "SCHEDULED" and "PRICE_CHANGE"
  -- look identical on a shift list and mean completely different things when
  -- a two-hour segment shows up.
  CONSTRAINT closed_needs_reason
    CHECK (state IN ('OPEN','COUNTING','VOID') OR (closed_at IS NOT NULL AND closed_reason IS NOT NULL)),
  CONSTRAINT approved_after_declared
    CHECK (state NOT IN ('APPROVED','POSTED') OR approved_by IS NOT NULL),
  CONSTRAINT void_needs_reason
    CHECK (state <> 'VOID' OR void_reason IS NOT NULL),
  -- Whoever closes it cannot be the one who signs it off.
  CONSTRAINT shift_segregation
    CHECK (approved_by IS NULL OR closed_by IS NULL OR approved_by <> closed_by)
);

-- THE most important invariant in the system: one live shift per station.
-- An index, not application logic, because two supervisors with two phones
-- will race it eventually.
CREATE UNIQUE INDEX one_live_shift_per_site
  ON shift (site_id) WHERE state IN ('OPEN','COUNTING');

CREATE INDEX ON shift (site_id, business_date DESC, label, segment);
CREATE INDEX ON shift (state) WHERE state NOT IN ('POSTED','VOID');
CREATE UNIQUE INDEX ON shift (predecessor_id) WHERE predecessor_id IS NOT NULL;

DO $$
BEGIN
  PERFORM fn_require_operator_author('shift', 'opened_by');
  PERFORM fn_require_operator_author('shift', 'closed_by');
  PERFORM fn_require_operator_author('shift', 'approved_by');
END $$;

-- The duty period as a human sees it: segments folded back into one line.
CREATE OR REPLACE VIEW v_duty_period AS
SELECT tenant_id, site_id, business_date, label,
       count(*)                                  AS segments,
       min(opened_at)                            AS started_at,
       max(closed_at)                            AS ended_at,
       array_agg(closed_reason ORDER BY segment)
         FILTER (WHERE closed_reason IS NOT NULL) AS cut_reasons,
       bool_and(state IN ('APPROVED','POSTED'))   AS fully_signed_off
  FROM shift
 WHERE state <> 'VOID'
 GROUP BY tenant_id, site_id, business_date, label;

-- ---------------------------------------------------------------------------
-- Nozzle assignment. An attendant holds a nozzle for a period.
--
-- Readings hang off the ASSIGNMENT, not the shift, so a nozzle can change hands
-- mid-shift and each holder settles separately for exactly what they pumped.
-- ---------------------------------------------------------------------------
CREATE TABLE nozzle_assignment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  shift_id      uuid NOT NULL REFERENCES shift(id),
  nozzle_id     uuid NOT NULL REFERENCES nozzle(id),

  -- The attendant. Note there is NO operator constraint on this column: this
  -- is the one place a non-signing-in person belongs, because holding a nozzle
  -- is exactly what an attendant does.
  attendant_id  uuid NOT NULL REFERENCES staff(id),

  assigned_by   uuid NOT NULL REFERENCES staff(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  released_by   uuid REFERENCES staff(id),
  state         text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (state IN ('ACTIVE','HANDED_OVER','CLOSED')),
  -- When a nozzle changes hands mid-shift, this points at the assignment that
  -- took over. The outgoing closing reading IS the incoming opening reading.
  handed_to_id  uuid REFERENCES nozzle_assignment(id),

  CHECK (released_at IS NULL OR released_at >= assigned_at),
  CHECK (state = 'ACTIVE' OR released_at IS NOT NULL),
  CHECK (state <> 'HANDED_OVER' OR handed_to_id IS NOT NULL)
);

-- One live holder per nozzle, ever. Two people cannot be responsible for the
-- same meter at the same moment.
CREATE UNIQUE INDEX one_active_holder_per_nozzle
  ON nozzle_assignment (nozzle_id) WHERE state = 'ACTIVE';

CREATE INDEX ON nozzle_assignment (shift_id);
CREATE INDEX ON nozzle_assignment (attendant_id, assigned_at DESC);
CREATE UNIQUE INDEX ON nozzle_assignment (handed_to_id) WHERE handed_to_id IS NOT NULL;

DO $$
BEGIN
  PERFORM fn_require_operator_author('nozzle_assignment', 'assigned_by');
  PERFORM fn_require_operator_author('nozzle_assignment', 'released_by');
END $$;

-- The person holding a nozzle must be an attendant on the strength of their
-- role, not merely someone who happens to be on the payroll.
CREATE OR REPLACE FUNCTION trg_assignment_is_attendant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_role staff_role; v_active boolean;
BEGIN
  SELECT role, is_active INTO v_role, v_active FROM staff WHERE id = NEW.attendant_id;
  IF v_role IS DISTINCT FROM 'ATTENDANT' THEN
    RAISE EXCEPTION
      'NOT_AN_ATTENDANT: only attendants hold nozzles; % is a %',
      NEW.attendant_id, v_role USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'INACTIVE_ATTENDANT: % is not on strength', NEW.attendant_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assignment_is_attendant
  BEFORE INSERT OR UPDATE OF attendant_id ON nozzle_assignment
  FOR EACH ROW EXECUTE FUNCTION trg_assignment_is_attendant();

-- ---------------------------------------------------------------------------
-- Roster template -- assign eight nozzles in one tap at 6am, not eight.
-- ---------------------------------------------------------------------------
CREATE TABLE roster_template (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  site_id   uuid NOT NULL REFERENCES site(id),
  name      text NOT NULL,
  label     text CHECK (label IS NULL OR label IN ('DAY','NIGHT')),
  is_active boolean NOT NULL DEFAULT TRUE,
  UNIQUE (site_id, name)
);

CREATE TABLE roster_template_line (
  template_id  uuid NOT NULL REFERENCES roster_template(id) ON DELETE CASCADE,
  nozzle_id    uuid NOT NULL REFERENCES nozzle(id),
  attendant_id uuid NOT NULL REFERENCES staff(id),
  PRIMARY KEY (template_id, nozzle_id)
);

-- ---------------------------------------------------------------------------
-- Exceptions. Anything the system noticed and a human must answer for.
-- ---------------------------------------------------------------------------
CREATE TABLE exception_flag (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  site_id     uuid NOT NULL REFERENCES site(id),
  shift_id    uuid REFERENCES shift(id),
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  code        text NOT NULL,
  level       severity NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at   timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES staff(id),
  resolved_at timestamptz,
  resolution  text,
  CONSTRAINT resolution_needs_words
    CHECK (resolved_by IS NULL OR (resolution IS NOT NULL AND length(trim(resolution)) >= 10))
);
CREATE INDEX ON exception_flag (site_id, raised_at DESC);
CREATE INDEX ON exception_flag (shift_id);
CREATE INDEX ON exception_flag (tenant_id) WHERE resolved_at IS NULL;

DO $$
BEGIN
  PERFORM fn_require_operator_author('exception_flag', 'resolved_by');
END $$;

CREATE OR REPLACE FUNCTION fn_raise_flag(
  p_tenant uuid, p_site uuid, p_shift uuid, p_entity text, p_entity_id text,
  p_code text, p_level severity, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO exception_flag (tenant_id, site_id, shift_id, entity, entity_id,
                              code, level, detail)
  VALUES (p_tenant, p_site, p_shift, p_entity, p_entity_id, p_code, p_level, p_detail)
  RETURNING id;
$$;

-- ---------------------------------------------------------------------------
-- Idempotency. The forecourt has no signal; the outbox replays. A replayed
-- request must be a no-op, not a second posting.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_record (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  key           text NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  response_body jsonb,
  status_code   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX ON idempotency_record (created_at);
