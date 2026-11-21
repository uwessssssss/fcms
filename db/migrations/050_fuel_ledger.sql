-- =============================================================================
-- FCMS v2 -- 050_fuel_ledger.sql
--
--                    *** THE CORE OF THE REDESIGN ***
--
-- "Every drop of fuel should be accounted for."
--
-- In v1 that was an aspiration enforced by a formula written out longhand in
-- three different stored procedures, each of which got it slightly differently.
-- Here it is a property of the schema.
--
-- TWO INVARIANTS, both enforced by the database:
--
--   I1  TANK CONSERVATION
--       Book stock in a tank is the SUM of signed movements. Nothing else.
--       There is no `book_closing` column to drift out of step, because there
--       is no stored book closing at all -- it is a running total.
--
--   I2  METERED DISPOSITION
--       Fuel that left through a meter must be classified, to the litre, as
--       SALE, PUMP_TEST or OWN_USE. sum(dispositions) = the metered volume,
--       enforced by a deferred constraint trigger. An unclassified litre
--       cannot be committed.
--
-- Together: fuel enters the ledger once, leaves once, and every litre that
-- leaves has a named reason. A discrepancy is then never "somewhere in the
-- arithmetic" -- it is a specific row you can point at.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Sign convention. Declared once, in one function, so no caller can disagree
-- about whether a delivery is positive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_movement_sign(p_kind movement_kind)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind
    WHEN 'OPENING_BALANCE'   THEN  1
    WHEN 'DELIVERY_IN'       THEN  1
    WHEN 'TEST_RETURN_IN'    THEN  1
    WHEN 'BULK_IN'           THEN  1
    WHEN 'METER_OUT'         THEN -1
    WHEN 'BULK_OUT'          THEN -1
    WHEN 'WATER_DRAW_OUT'    THEN -1
    WHEN 'STOCK_TAKE_ADJUST' THEN  0   -- signed_litres carries its own sign
    WHEN 'CORRECTION'        THEN  0   -- ditto
  END;
$$;

-- ---------------------------------------------------------------------------
-- THE LEDGER
--
-- Append-only. A mistake is corrected by a CORRECTION row that points at the
-- row it reverses -- never by an UPDATE, never by a DELETE. The history of what
-- the station believed at each moment is therefore recoverable, which is the
-- whole point of an audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE fuel_movement (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  site_id         uuid NOT NULL REFERENCES site(id),
  tank_id         uuid NOT NULL REFERENCES tank(id),
  product_id      uuid NOT NULL REFERENCES product(id),
  shift_id        uuid REFERENCES shift(id),

  kind            movement_kind NOT NULL,

  -- Always positive. The sign lives in signed_litres, generated, so it can
  -- never be entered inconsistently by hand.
  litres          numeric(12,3) NOT NULL CHECK (litres > 0),
  signed_litres   numeric(12,3) NOT NULL,

  -- Valuation at the moment of movement, for stock value and COGS. Captured,
  -- not looked up later: v1's fn_price_at() re-priced closed shifts whenever
  -- anyone backdated a price row.
  unit_cost       numeric(12,4),
  unit_price      numeric(12,4),

  -- What caused this. Exactly one must be set -- see the check below. This is
  -- a discriminated union, not a nullable free-for-all: every litre traces to
  -- a document you can print.
  meter_event_id  bigint,
  delivery_line_id uuid,
  stock_count_id  uuid,
  bulk_draw_id    uuid,
  corrects_id     bigint REFERENCES fuel_movement(id),
  correction_note text,

  occurred_at     timestamptz NOT NULL,
  recorded_by     uuid NOT NULL REFERENCES staff(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,

  CONSTRAINT movement_sign_correct CHECK (
    CASE WHEN fn_movement_sign(kind) <> 0
         THEN signed_litres = litres * fn_movement_sign(kind)
         ELSE abs(signed_litres) = litres
    END
  ),

  CONSTRAINT movement_has_exactly_one_source CHECK (
    (meter_event_id  IS NOT NULL)::int
  + (delivery_line_id IS NOT NULL)::int
  + (stock_count_id  IS NOT NULL)::int
  + (bulk_draw_id    IS NOT NULL)::int
  + (corrects_id     IS NOT NULL)::int
  + (kind = 'OPENING_BALANCE')::int = 1
  ),

  CONSTRAINT correction_needs_note CHECK (corrects_id IS NULL OR correction_note IS NOT NULL)
);

-- The running-balance query is the hottest path in the system.
CREATE INDEX ON fuel_movement (tank_id, occurred_at, id);
CREATE INDEX ON fuel_movement (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX ON fuel_movement (tenant_id, occurred_at DESC);
CREATE UNIQUE INDEX ON fuel_movement (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Append-only, at the table level. Not a policy, not a convention -- a rule.
CREATE RULE fuel_movement_no_update AS ON UPDATE TO fuel_movement DO INSTEAD NOTHING;
CREATE RULE fuel_movement_no_delete AS ON DELETE TO fuel_movement DO INSTEAD NOTHING;

COMMENT ON TABLE fuel_movement IS
  'Signed litre ledger, one row per physical fuel movement. Book stock is '
  'SUM(signed_litres). Append-only: corrections are new rows.';

-- ---------------------------------------------------------------------------
-- METER EVENT -- one nozzle, one open->close pair, one volume.
--
-- This is what a meter reading MEANS, as opposed to what it says. Keeping the
-- raw readings and the derived volume in separate tables is what lets the
-- rollover arithmetic be checked independently of the ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE meter_reading (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  site_id          uuid NOT NULL REFERENCES site(id),
  nozzle_id        uuid NOT NULL REFERENCES nozzle(id),
  shift_id         uuid NOT NULL REFERENCES shift(id),
  assignment_id    uuid NOT NULL REFERENCES nozzle_assignment(id),

  is_opening       boolean NOT NULL,
  source           reading_source NOT NULL DEFAULT 'MANUAL',
  volume_totalizer numeric(14,3) NOT NULL CHECK (volume_totalizer >= 0),
  amount_totalizer numeric(16,2) CHECK (amount_totalizer IS NULL OR amount_totalizer >= 0),
  -- The electronic head reading, when the pump has one. Its ABSOLUTE value
  -- legitimately differs from the mechanical totalizer; only the DELTAS are
  -- comparable. v1 documented this and then still compared absolutes in one
  -- of the two report paths.
  electronic_totalizer numeric(14,3),

  photo_url        text,
  evidence         evidence_state NOT NULL DEFAULT 'PENDING',
  evidence_reason  text,
  gps_lat          numeric(9,6),
  gps_lng          numeric(9,6),

  recorded_by      uuid NOT NULL REFERENCES staff(id),
  -- The clock on the device that captured it. Plausibility checks use THIS,
  -- not recorded_at: an offline reading synced six hours later is not a
  -- six-hour shift. v1 failed valid offline captures as "implausible".
  captured_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  idempotency_key  text,

  CONSTRAINT reading_evidence_consistent CHECK (
    (evidence = 'PRESENT' AND photo_url IS NOT NULL)
    OR (evidence = 'PENDING' AND photo_url IS NULL)
    OR (evidence = 'WAIVED'  AND evidence_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_opening_per_assignment
  ON meter_reading (assignment_id) WHERE is_opening;
CREATE UNIQUE INDEX one_closing_per_assignment
  ON meter_reading (assignment_id) WHERE NOT is_opening;
CREATE UNIQUE INDEX ON meter_reading (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON meter_reading (shift_id);

CREATE RULE meter_reading_no_delete AS ON DELETE TO meter_reading DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- The derived volume for an assignment. One row per closed assignment.
-- ---------------------------------------------------------------------------
CREATE TABLE meter_event (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  site_id         uuid NOT NULL REFERENCES site(id),
  shift_id        uuid NOT NULL REFERENCES shift(id),
  assignment_id   uuid NOT NULL UNIQUE REFERENCES nozzle_assignment(id),
  nozzle_id       uuid NOT NULL REFERENCES nozzle(id),
  tank_id         uuid NOT NULL REFERENCES tank(id),

  opening_reading_id bigint NOT NULL REFERENCES meter_reading(id),
  closing_reading_id bigint NOT NULL REFERENCES meter_reading(id),

  rolled_over     boolean NOT NULL DEFAULT FALSE,
  gross_litres    numeric(12,3) NOT NULL CHECK (gross_litres >= 0),

  -- Electronic delta, when both ends have one. NULL means "no comparison
  -- available", which is not the same as "they agreed" -- v1 reported zero.
  electronic_litres numeric(12,3),
  divergence_litres numeric(12,3)
    GENERATED ALWAYS AS (electronic_litres - gross_litres) STORED,

  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON meter_event (shift_id);
CREATE INDEX ON meter_event (tank_id);

ALTER TABLE fuel_movement
  ADD CONSTRAINT fk_movement_meter_event
  FOREIGN KEY (meter_event_id) REFERENCES meter_event(id);

-- ---------------------------------------------------------------------------
-- I2 -- METERED DISPOSITION
--
-- Every litre through the meter is one of three things. The sum must equal the
-- meter event exactly, and that is checked at COMMIT (deferred), so a close can
-- insert the parts in any order and still be refused if they do not add up.
--
-- This is the single structure that makes "every drop is accounted for" true
-- rather than aspirational. In v1 the same fact was three separate subtractions
-- in a formula, and C5/C6 in the audit are both cases of that formula being
-- wrong in a way nothing could detect.
-- ---------------------------------------------------------------------------
CREATE TABLE metered_disposition (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  meter_event_id bigint NOT NULL REFERENCES meter_event(id) ON DELETE CASCADE,
  kind           disposition_kind NOT NULL,
  litres         numeric(12,3) NOT NULL CHECK (litres >= 0),

  -- SALE: priced at the price captured on the shift, not looked up later.
  unit_price     numeric(12,4),
  -- PUMP_TEST: the can, and whether the fuel went back in the ground.
  pump_test_id   uuid,
  -- OWN_USE: who authorised it and what for.
  own_use_id     uuid,

  UNIQUE (meter_event_id, kind),
  CONSTRAINT sale_needs_price CHECK (kind <> 'SALE' OR unit_price IS NOT NULL),
  CONSTRAINT test_needs_ref   CHECK (kind <> 'PUMP_TEST' OR pump_test_id IS NOT NULL),
  CONSTRAINT ownuse_needs_ref CHECK (kind <> 'OWN_USE' OR own_use_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION trg_disposition_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_event   bigint := COALESCE(NEW.meter_event_id, OLD.meter_event_id);
  v_gross   numeric(12,3);
  v_alloc   numeric(12,3);
BEGIN
  SELECT gross_litres INTO v_gross FROM meter_event WHERE id = v_event;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- event was deleted; cascade handled it

  SELECT COALESCE(SUM(litres), 0) INTO v_alloc
    FROM metered_disposition WHERE meter_event_id = v_event;

  -- Tolerance of one millilitre absorbs decimal rounding on a three-way split
  -- and nothing else. It is deliberately not a business tolerance.
  IF abs(v_alloc - v_gross) > 0.001 THEN
    RAISE EXCEPTION
      'UNACCOUNTED_FUEL: meter event % dispensed % L but only % L is classified '
      '(difference % L). Every litre through a meter must be a sale, a pump '
      'test or an authorised own-use draw.',
      v_event, v_gross, v_alloc, round(v_gross - v_alloc, 3)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER disposition_must_balance
  AFTER INSERT OR UPDATE OR DELETE ON metered_disposition
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_disposition_balances();

-- A meter event with no dispositions at all is equally unaccounted for. This
-- catches the case where the close writes the event and then fails before
-- classifying it.
CREATE OR REPLACE FUNCTION trg_meter_event_classified() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gross_litres > 0 AND NOT EXISTS (
       SELECT 1 FROM metered_disposition WHERE meter_event_id = NEW.id) THEN
    RAISE EXCEPTION
      'UNACCOUNTED_FUEL: meter event % dispensed % L with no disposition at all',
      NEW.id, NEW.gross_litres USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER meter_event_must_be_classified
  AFTER INSERT ON meter_event
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_meter_event_classified();

-- ---------------------------------------------------------------------------
-- Supporting documents for the non-sale dispositions.
-- ---------------------------------------------------------------------------
CREATE TABLE pump_test (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  site_id          uuid NOT NULL REFERENCES site(id),
  shift_id         uuid NOT NULL REFERENCES shift(id),
  nozzle_id        uuid NOT NULL REFERENCES nozzle(id),
  can_size_litres  numeric(6,2) NOT NULL CHECK (can_size_litres > 0),
  -- What actually came out. THIS is what moved through the meter; the can size
  -- is the target. v1 used can_size everywhere, which pushed the deviation of
  -- every test into stock variance as a phantom loss.
  measured_litres  numeric(8,3) NOT NULL CHECK (measured_litres >= 0),
  deviation_ml     numeric(9,2) GENERATED ALWAYS AS
                     ((measured_litres - can_size_litres) * 1000) STORED,
  returned_to_tank boolean NOT NULL,
  tested_by        uuid NOT NULL REFERENCES staff(id),
  witnessed_by     uuid REFERENCES staff(id),
  photo_url        text,
  tested_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pump_test (shift_id);

CREATE TABLE own_use (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  shift_id      uuid NOT NULL REFERENCES shift(id),
  tank_id       uuid NOT NULL REFERENCES tank(id),
  -- NULL nozzle means it never passed a meter: it is a BULK_OUT movement and
  -- has no disposition row. Non-NULL means it is inside a meter event and is
  -- classified there. The two paths are structurally distinct, so the v1 bug
  -- of subtracting bulk draws from metered throughput cannot recur.
  nozzle_id     uuid REFERENCES nozzle(id),
  litres        numeric(12,3) NOT NULL CHECK (litres > 0),
  purpose       text NOT NULL CHECK (purpose IN
                  ('GENERATOR','COMPANY_VEHICLE','TRANSFER_OUT','SAMPLE','CLEANING')),
  reference     text,
  authorised_by uuid NOT NULL REFERENCES staff(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON own_use (shift_id);

CREATE TABLE bulk_draw (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  shift_id      uuid REFERENCES shift(id),
  tank_id       uuid NOT NULL REFERENCES tank(id),
  own_use_id    uuid REFERENCES own_use(id),
  litres        numeric(12,3) NOT NULL CHECK (litres > 0),
  reason        text NOT NULL,
  authorised_by uuid NOT NULL REFERENCES staff(id),
  drawn_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fuel_movement
  ADD CONSTRAINT fk_movement_bulk_draw
  FOREIGN KEY (bulk_draw_id) REFERENCES bulk_draw(id);

ALTER TABLE metered_disposition
  ADD CONSTRAINT fk_disposition_pump_test FOREIGN KEY (pump_test_id) REFERENCES pump_test(id),
  ADD CONSTRAINT fk_disposition_own_use   FOREIGN KEY (own_use_id)   REFERENCES own_use(id);

-- ---------------------------------------------------------------------------
-- Physical truth: dips and ATG.
-- ---------------------------------------------------------------------------
CREATE TABLE dip_reading (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  tank_id        uuid NOT NULL REFERENCES tank(id),
  shift_id       uuid REFERENCES shift(id),
  context        dip_context NOT NULL,
  dip_mm         numeric(7,1) NOT NULL CHECK (dip_mm >= 0),
  water_dip_mm   numeric(7,1) NOT NULL DEFAULT 0 CHECK (water_dip_mm >= 0),
  gross_litres   numeric(12,3) NOT NULL,
  water_litres   numeric(12,3) NOT NULL DEFAULT 0,
  product_litres numeric(12,3) NOT NULL CHECK (product_litres >= 0),
  temperature_c  numeric(5,2),
  photo_url      text,
  evidence       evidence_state NOT NULL DEFAULT 'PENDING',
  evidence_reason text,
  recorded_by    uuid NOT NULL REFERENCES staff(id),
  captured_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  CHECK (water_dip_mm <= dip_mm),
  CHECK (product_litres = gross_litres - water_litres)
);
CREATE INDEX ON dip_reading (tank_id, captured_at DESC);
CREATE INDEX ON dip_reading (shift_id);
CREATE UNIQUE INDEX ON dip_reading (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE RULE dip_reading_no_delete AS ON DELETE TO dip_reading DO INSTEAD NOTHING;

CREATE TABLE atg_reading (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),   -- v1 omitted this
  tank_id        uuid NOT NULL REFERENCES tank(id),
  product_litres numeric(12,3) NOT NULL,
  tc_litres      numeric(12,3),
  water_litres   numeric(12,3),
  ullage_litres  numeric(12,3),
  temperature_c  numeric(5,2),
  polled_at      timestamptz NOT NULL,
  UNIQUE (tank_id, polled_at)
);
CREATE INDEX ON atg_reading (tank_id, polled_at DESC);

-- ---------------------------------------------------------------------------
-- I1 -- BOOK STOCK, DERIVED.
--
-- No stored balance. Ask the ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_book_stock(p_tank_id uuid, p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(signed_litres), 0)::numeric(12,3)
    FROM fuel_movement
   WHERE tank_id = p_tank_id AND occurred_at <= p_at;
$$;

COMMENT ON FUNCTION fn_book_stock IS
  'Book stock = the ledger. There is no cached column to fall out of step.';

-- Running position per tank per movement -- the printable stock card an
-- auditor asks for, and the thing that lets you find exactly WHERE the books
-- and the dipstick parted company rather than only THAT they did.
CREATE OR REPLACE VIEW v_tank_stock_card AS
SELECT
  fm.tenant_id, fm.site_id, fm.tank_id, t.code AS tank_code,
  p.code AS product_code, fm.shift_id, fm.id AS movement_id,
  fm.occurred_at, fm.kind, fm.signed_litres,
  SUM(fm.signed_litres) OVER (
    PARTITION BY fm.tank_id ORDER BY fm.occurred_at, fm.id
  )::numeric(12,3) AS running_litres
FROM fuel_movement fm
JOIN tank t    ON t.id = fm.tank_id
JOIN product p ON p.id = fm.product_id;

-- ---------------------------------------------------------------------------
-- Dip -> litres. Refuses to extrapolate. v1 clamped anything within 2% of the
-- top of the chart to the ceiling volume and prorated from the origin below
-- the bottom -- both invent stock that is not there.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_dip_to_litres(p_tank_id uuid, p_dip_mm numeric)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE d_lo numeric; l_lo numeric; d_hi numeric; l_hi numeric; v_exact numeric;
BEGIN
  IF p_dip_mm IS NULL OR p_dip_mm < 0 THEN
    RAISE EXCEPTION 'INVALID_DIP: % mm', p_dip_mm USING ERRCODE = 'check_violation';
  END IF;

  SELECT litres INTO v_exact FROM tank_calibration
   WHERE tank_id = p_tank_id AND dip_mm = p_dip_mm;
  IF FOUND THEN RETURN v_exact; END IF;

  SELECT dip_mm, litres INTO d_lo, l_lo FROM tank_calibration
   WHERE tank_id = p_tank_id AND dip_mm < p_dip_mm ORDER BY dip_mm DESC LIMIT 1;
  SELECT dip_mm, litres INTO d_hi, l_hi FROM tank_calibration
   WHERE tank_id = p_tank_id AND dip_mm > p_dip_mm ORDER BY dip_mm ASC LIMIT 1;

  IF d_lo IS NULL AND d_hi IS NULL THEN
    RAISE EXCEPTION 'NO_CALIBRATION_CHART: tank % has no calibration rows', p_tank_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF d_lo IS NULL THEN
    RAISE EXCEPTION
      'DIP_BELOW_CHART: % mm on tank % (chart starts at % mm). Recalibrate or '
      'record a spot check, but do not guess the volume.', p_dip_mm, p_tank_id, d_hi
      USING ERRCODE = 'check_violation';
  END IF;

  IF d_hi IS NULL THEN
    RAISE EXCEPTION
      'DIP_ABOVE_CHART: % mm on tank % (chart ends at % mm). This is an overfill '
      'or a misread -- both need a person, not an extrapolation.', p_dip_mm, p_tank_id, d_lo
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN round(l_lo + (l_hi - l_lo) * (p_dip_mm - d_lo) / (d_hi - d_lo), 3);
END $$;

-- ---------------------------------------------------------------------------
-- Rollover-safe meter delta. Rollover point is 10^integer_digits, taken from
-- the nozzle. Plausibility is checked against elapsed CAPTURE time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_meter_delta(
  p_nozzle_id uuid, p_opening numeric, p_closing numeric,
  p_rolled boolean DEFAULT FALSE, p_hours numeric DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v_digits int; v_flow numeric; v_wrap numeric; v_delta numeric; v_max numeric;
BEGIN
  SELECT integer_digits, max_flow_lpm INTO v_digits, v_flow
    FROM nozzle WHERE id = p_nozzle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_NOZZLE: %', p_nozzle_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_closing >= p_opening THEN
    v_delta := p_closing - p_opening;
  ELSIF p_rolled THEN
    v_wrap  := power(10::numeric, v_digits);
    IF p_opening >= v_wrap THEN
      RAISE EXCEPTION
        'ROLLOVER_IMPOSSIBLE: opening % already exceeds the %-digit wrap point %',
        p_opening, v_digits, v_wrap USING ERRCODE = 'check_violation';
    END IF;
    v_delta := (v_wrap - p_opening) + p_closing;
  ELSE
    RAISE EXCEPTION
      'METER_ROLLBACK: nozzle % closed at % below its opening of %. Either the '
      'meter wrapped (tick the rollover box) or a reading is wrong.',
      p_nozzle_id, p_closing, p_opening USING ERRCODE = 'check_violation';
  END IF;

  IF p_hours IS NOT NULL AND p_hours > 0 THEN
    v_max := v_flow * 60 * p_hours * 1.15;   -- 15% headroom for clock skew
    IF v_delta > v_max THEN
      RAISE EXCEPTION
        'METER_IMPLAUSIBLE: nozzle % shows % L in %h; the pump cannot exceed ~% L',
        p_nozzle_id, round(v_delta,2), round(p_hours,2), round(v_max,0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN round(v_delta, 3);
END $$;

-- ---------------------------------------------------------------------------
-- Weighted average cost, for stock valuation and margin. Derived from the
-- delivery ledger, so it cannot drift from what was actually bought.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_weighted_avg_cost(p_tank_id uuid,
                                                p_at timestamptz DEFAULT now())
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN SUM(litres) > 0
              THEN round(SUM(litres * unit_cost) / SUM(litres), 4) END
    FROM fuel_movement
   WHERE tank_id = p_tank_id AND kind IN ('DELIVERY_IN','BULK_IN')
     AND unit_cost IS NOT NULL AND occurred_at <= p_at;
$$;
