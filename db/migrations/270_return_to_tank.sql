-- =============================================================================
-- FCMS v2 -- 270_return_to_tank.sql
--
-- RETURN TO TANK (RTT).
--
-- Litres the meter counted that went back into the tank: a line flushed after
-- a repair, a jerrycan filled and poured back, an overfill drawn off. Every
-- East African daily sales sheet has the column, and this system did not.
--
-- WHAT FORGETTING IT COST, and it was not small. The close computed what an
-- attendant owes as
--
--     sale = gross - pump tests - own use
--
-- so twenty litres poured back were charged to the attendant as twenty litres
-- sold. Meanwhile the ledger took those litres off the tank and never put them
-- back, so the next dip found twenty litres the books did not expect.
--
-- The same twenty litres, reported twice: A CASH SHORTAGE AGAINST A NAMED
-- PERSON, and a STOCK GAIN nobody could explain. That is the arrangement that
-- gets an honest attendant's wages docked.
--
-- WHY IT NEEDS A DOCUMENT AND NOT JUST A NUMBER
--
-- RTT is the easiest lever there is for hiding theft: sell twenty litres for
-- cash, pocket it, and declare the twenty "returned". So an RTT is a row with a
-- REASON and a RECORDER who is not the attendant, and every RTT litre in a
-- disposition must point at it -- the same rule tests and own use already
-- follow.
--
-- A false RTT is not invisible either. Claim a return that did not happen and
-- the ledger puts litres back that are not there; the next dip then shows a
-- LOSS of exactly that amount. A lie moves the discrepancy from the cash-up to
-- the tank. It does not make it disappear.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The document.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS return_to_tank (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  shift_id     uuid NOT NULL REFERENCES shift(id),
  nozzle_id    uuid NOT NULL REFERENCES nozzle(id),
  litres       numeric(12,3) NOT NULL CHECK (litres > 0),

  -- Why. Not optional, and not a single character: "RTT" as a reason for an
  -- RTT is how a return nobody can explain gets past a tired reviewer.
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 5),

  recorded_by  uuid NOT NULL REFERENCES staff(id),
  witnessed_by uuid REFERENCES staff(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rtt_witness_is_someone_else
    CHECK (witnessed_by IS NULL OR witnessed_by <> recorded_by)
);

COMMENT ON TABLE return_to_tank IS
  'Fuel the meter counted that went back into the tank. Excluded from what the '
  'attendant owes, and put back into the tank book. Requires a reason and a '
  'recorder who is not an attendant: RTT is the easiest place to hide theft.';

CREATE INDEX IF NOT EXISTS return_to_tank_shift_nozzle
  ON return_to_tank (shift_id, nozzle_id, recorded_at);

SELECT fn_apply_tenant_rls('public', 'return_to_tank');
GRANT SELECT, INSERT ON return_to_tank TO fcms_app;

-- Recorded, never edited. A correction is a new row, so the original stays.
CREATE OR REPLACE RULE return_to_tank_no_update AS
  ON UPDATE TO return_to_tank DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- 2. An attendant cannot record their own return.
--
-- The person who holds the nozzle is the person an RTT relieves of a
-- liability. Letting them declare it is letting them write off their own
-- shortage.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_rtt_not_by_attendant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_role staff_role;
BEGIN
  SELECT role INTO v_role FROM staff WHERE id = NEW.recorded_by;
  IF v_role = 'ATTENDANT' THEN
    RAISE EXCEPTION
      'RTT_BY_ATTENDANT: an attendant cannot record a return to tank. It '
      'relieves them of the liability for those litres, so a supervisor '
      'records it.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The shift must be open. A return recorded after the close would change
  -- what an attendant owed on a sheet that has already been signed.
  IF NOT EXISTS (SELECT 1 FROM shift WHERE id = NEW.shift_id AND state = 'OPEN') THEN
    RAISE EXCEPTION
      'RTT_ON_CLOSED_SHIFT: that shift is no longer open. A return to tank is '
      'recorded before the close, because it changes what the attendant owes.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rtt_not_by_attendant ON return_to_tank;
CREATE TRIGGER rtt_not_by_attendant
  BEFORE INSERT ON return_to_tank
  FOR EACH ROW EXECUTE FUNCTION trg_rtt_not_by_attendant();

-- ---------------------------------------------------------------------------
-- 3. Every RTT litre points at its document, like tests and own use.
-- ---------------------------------------------------------------------------
ALTER TABLE metered_disposition ADD COLUMN IF NOT EXISTS rtt_id uuid
  REFERENCES return_to_tank(id);

ALTER TABLE metered_disposition DROP CONSTRAINT IF EXISTS rtt_needs_ref;
ALTER TABLE metered_disposition ADD CONSTRAINT rtt_needs_ref
  CHECK (kind <> 'RTT' OR rtt_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. The sign.
--
-- NOT OPTIONAL. movement_sign_correct only checks the sign when
-- fn_movement_sign(kind) <> 0 -- and an unregistered kind returns NULL, which
-- is not <> 0, so the check falls through to comparing magnitudes only. An
-- RTT_IN posted NEGATIVE would pass, and would double the loss it was meant to
-- cancel.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_movement_sign(p_kind movement_kind)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind
    WHEN 'OPENING_BALANCE'   THEN  1
    WHEN 'DELIVERY_IN'       THEN  1
    WHEN 'TEST_RETURN_IN'    THEN  1
    WHEN 'RTT_IN'            THEN  1
    WHEN 'BULK_IN'           THEN  1
    WHEN 'METER_OUT'         THEN -1
    WHEN 'BULK_OUT'          THEN -1
    WHEN 'WATER_DRAW_OUT'    THEN -1
    WHEN 'STOCK_TAKE_ADJUST' THEN  0   -- signed_litres carries its own sign
    WHEN 'CORRECTION'        THEN  0   -- ditto
  END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The close, with RTT in it.
--
-- Generated from 070's definition with five marked changes rather than
-- retyped: the declaration, the RTT read, the sale formula, the refusal text,
-- the RTT disposition, and the RTT_IN ledger row. Retyping four hundred lines
-- to change twenty is how a close function quietly loses a rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_close_shift(
  p_shift_id uuid,
  p_actor    uuid,
  p_reason   close_reason,
  p_readings jsonb,          -- [{assignment_id, volume_totalizer, electronic_totalizer, is_rollover, photo_url}]
  p_dips     jsonb,          -- [{tank_id, dip_mm, water_dip_mm, temperature_c, photo_url}]
  p_cashups  jsonb           -- [{attendant_id, cash, tenders:[{channel_code,amount,reference}], shortage, shortage_reason}]
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_s shift%ROWTYPE; v_pol tenant_policy%ROWTYPE; v_cur char(3);
  v_missing text[]; v_row jsonb; v_pay jsonb;
  v_assign nozzle_assignment%ROWTYPE;
  v_open meter_reading%ROWTYPE; v_close_id bigint; v_event_id bigint;
  v_gross numeric; v_elec numeric; v_hours numeric; v_tank uuid; v_product uuid;
  v_tests numeric; v_own_metered numeric; v_rtt numeric; v_sale numeric; v_price numeric;
  v_gr numeric; v_wt numeric; v_actual numeric; v_book numeric;
  v_var numeric; v_var_pct numeric; v_ok boolean;
  v_att uuid; v_cashup uuid; v_amount numeric; v_channel uuid; v_kind settlement_kind;
  v_short numeric; v_shortage_id uuid; v_sale_value numeric;
  v_events int := 0; v_tanks int := 0; v_cashups int := 0;
BEGIN
  SELECT * INTO v_s FROM shift WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_SHIFT: %', p_shift_id USING ERRCODE='no_data_found';
  END IF;
  IF v_s.state NOT IN ('OPEN','COUNTING') THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN: shift is %', v_s.state USING ERRCODE='check_violation';
  END IF;

  SELECT * INTO v_pol FROM tenant_policy WHERE tenant_id = v_s.tenant_id;
  SELECT base_currency INTO v_cur FROM tenant WHERE id = v_s.tenant_id;

  -- === 1. Coverage. Refuse early, before anything is written. ===
  SELECT array_agg(n.code ORDER BY n.code) INTO v_missing
    FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
   WHERE na.shift_id = p_shift_id AND na.state = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_readings) r
                      WHERE (r->>'assignment_id')::uuid = na.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'MISSING_CLOSING_READINGS: nozzle(s) %',
      array_to_string(v_missing, ', ') USING ERRCODE='check_violation';
  END IF;

  SELECT array_agg(t.code ORDER BY t.code) INTO v_missing
    FROM tank t WHERE t.site_id = v_s.site_id AND t.is_active
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_dips) d
                      WHERE (d->>'tank_id')::uuid = t.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'MISSING_CLOSING_DIPS: tank(s) %',
      array_to_string(v_missing, ', ') USING ERRCODE='check_violation';
  END IF;

  UPDATE shift SET state = 'COUNTING' WHERE id = p_shift_id;

  -- === 2. Closing readings -> meter events -> dispositions -> fuel ledger ===
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_readings)
  LOOP
    SELECT * INTO v_assign FROM nozzle_assignment
     WHERE id = (v_row->>'assignment_id')::uuid AND shift_id = p_shift_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'UNKNOWN_ASSIGNMENT: % is not on this shift', v_row->>'assignment_id'
        USING ERRCODE='check_violation';
    END IF;

    SELECT * INTO v_open FROM meter_reading
     WHERE assignment_id = v_assign.id AND is_opening;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPENING_READING: assignment % never had one', v_assign.id
        USING ERRCODE='check_violation';
    END IF;

    SELECT n.tank_id, t.product_id INTO v_tank, v_product
      FROM nozzle n JOIN tank t ON t.id = n.tank_id WHERE n.id = v_assign.nozzle_id;

    INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, assignment_id,
      is_opening, source, volume_totalizer, amount_totalizer, electronic_totalizer,
      photo_url, evidence, evidence_reason, gps_lat, gps_lng,
      recorded_by, captured_at, idempotency_key)
    VALUES (v_s.tenant_id, v_s.site_id, v_assign.nozzle_id, p_shift_id, v_assign.id,
      FALSE, COALESCE((v_row->>'source')::reading_source,'MANUAL'),
      (v_row->>'volume_totalizer')::numeric,
      (v_row->>'amount_totalizer')::numeric,
      (v_row->>'electronic_totalizer')::numeric,
      NULLIF(v_row->>'photo_url',''),
      CASE WHEN COALESCE(v_row->>'photo_url','') <> '' THEN 'PRESENT'
           WHEN COALESCE(v_row->>'evidence_reason','') <> '' THEN 'WAIVED'
           ELSE 'PENDING' END::evidence_state,
      NULLIF(v_row->>'evidence_reason',''),
      (v_row->>'gps_lat')::numeric, (v_row->>'gps_lng')::numeric,
      p_actor, COALESCE((v_row->>'captured_at')::timestamptz, now()),
      v_row->>'idempotency_key')
    RETURNING id INTO v_close_id;

    -- Elapsed CAPTURE time, not wall-clock sync time: an offline reading
    -- uploaded six hours later is not a six-hour shift.
    v_hours := GREATEST(EXTRACT(EPOCH FROM (
                 COALESCE((v_row->>'captured_at')::timestamptz, now()) - v_open.captured_at
               )) / 3600.0, 0.01);

    v_gross := fn_meter_delta(v_assign.nozzle_id, v_open.volume_totalizer,
                 (v_row->>'volume_totalizer')::numeric,
                 COALESCE((v_row->>'is_rollover')::boolean, FALSE), v_hours);

    v_elec := CASE WHEN v_open.electronic_totalizer IS NOT NULL
                    AND (v_row->>'electronic_totalizer') IS NOT NULL
                   THEN (v_row->>'electronic_totalizer')::numeric - v_open.electronic_totalizer
              END;

    INSERT INTO meter_event (tenant_id, site_id, shift_id, assignment_id, nozzle_id,
      tank_id, opening_reading_id, closing_reading_id, rolled_over, gross_litres,
      electronic_litres)
    VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_assign.id, v_assign.nozzle_id,
      v_tank, v_open.id, v_close_id,
      COALESCE((v_row->>'is_rollover')::boolean, FALSE), v_gross, v_elec)
    RETURNING id INTO v_event_id;

    -- --- classify every litre ---
    -- Tests use MEASURED litres, not the nominal can size. v1 used can size, so
    -- every test pushed its deviation into stock variance as a phantom loss.
    SELECT COALESCE(SUM(pt.measured_litres),0) INTO v_tests
      FROM pump_test pt
     WHERE pt.shift_id = p_shift_id AND pt.nozzle_id = v_assign.nozzle_id
       AND pt.tested_at BETWEEN v_assign.assigned_at AND COALESCE(v_assign.released_at, now());

    -- Only METERED own-use. A bulk draw never passed this meter, so subtracting
    -- it here would understate what the attendant owes -- v1's C5.
    SELECT COALESCE(SUM(ou.litres),0) INTO v_own_metered
      FROM own_use ou
     WHERE ou.shift_id = p_shift_id AND ou.nozzle_id = v_assign.nozzle_id
       AND ou.recorded_at BETWEEN v_assign.assigned_at AND COALESCE(v_assign.released_at, now());

    -- RETURN TO TANK: litres the meter counted that went back into the tank.
    -- Same window as tests and own use -- this attendant's holding of this
    -- nozzle -- so a return recorded after a handover is not charged to the
    -- wrong person.
    SELECT COALESCE(SUM(r.litres),0) INTO v_rtt
      FROM return_to_tank r
     WHERE r.shift_id = p_shift_id AND r.nozzle_id = v_assign.nozzle_id
       AND r.recorded_at BETWEEN v_assign.assigned_at AND COALESCE(v_assign.released_at, now());

    -- What the attendant owes for. Without the RTT term, every litre poured
    -- back was charged to them as a sale: a cash shortage against a named
    -- person for fuel that never left the tank.
    v_sale := round(v_gross - v_tests - v_own_metered - v_rtt, 3);
    IF v_sale < 0 THEN
      RAISE EXCEPTION
        'DISPOSITION_EXCEEDS_METER: nozzle held by assignment % dispensed % L but '
        '% L of tests, own-use and return-to-tank are recorded against it. More '
        'fuel cannot come back than went out.',
        v_assign.id, v_gross, v_tests + v_own_metered + v_rtt USING ERRCODE='check_violation';
    END IF;

    v_price := fn_shift_price(p_shift_id, v_product);

    IF v_sale > 0 THEN
      INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, unit_price)
      VALUES (v_s.tenant_id, v_event_id, 'SALE', v_sale, v_price);
    END IF;
    IF v_tests > 0 THEN
      INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, pump_test_id)
      SELECT v_s.tenant_id, v_event_id, 'PUMP_TEST', v_tests, pt.id
        FROM pump_test pt WHERE pt.shift_id = p_shift_id
         AND pt.nozzle_id = v_assign.nozzle_id ORDER BY pt.tested_at LIMIT 1;
    END IF;
    IF v_own_metered > 0 THEN
      INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, own_use_id)
      SELECT v_s.tenant_id, v_event_id, 'OWN_USE', v_own_metered, ou.id
        FROM own_use ou WHERE ou.shift_id = p_shift_id
         AND ou.nozzle_id = v_assign.nozzle_id ORDER BY ou.recorded_at LIMIT 1;
    END IF;
    IF v_rtt > 0 THEN
      INSERT INTO metered_disposition (tenant_id, meter_event_id, kind, litres, rtt_id)
      SELECT v_s.tenant_id, v_event_id, 'RTT', v_rtt, r.id
        FROM return_to_tank r WHERE r.shift_id = p_shift_id
         AND r.nozzle_id = v_assign.nozzle_id ORDER BY r.recorded_at LIMIT 1;
    END IF;
    -- The deferred trigger on metered_disposition now guarantees these sum to
    -- v_gross at COMMIT. Nothing else needs to check it.

    -- --- fuel out of the tank ---
    IF v_gross > 0 THEN
      INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id,
        kind, litres, signed_litres, unit_price, meter_event_id, occurred_at, recorded_by)
      VALUES (v_s.tenant_id, v_s.site_id, v_tank, v_product, p_shift_id,
        'METER_OUT', v_gross, -v_gross, v_price, v_event_id, now(), p_actor);
    END IF;

    UPDATE nozzle_assignment
       SET state='CLOSED', released_at=now(), released_by=p_actor
     WHERE id = v_assign.id;

    -- Meter divergence: compare DELTAS. Absolute totalizer values legitimately
    -- differ between the mechanical and electronic heads.
    IF v_elec IS NOT NULL AND v_gross > 0
       AND abs(v_elec - v_gross) / v_gross * 100 > v_pol.meter_divergence_pct THEN
      PERFORM fn_raise_flag(v_s.tenant_id, v_s.site_id, p_shift_id,
        'meter_event', v_event_id::text, 'METER_DIVERGENCE', 'WARN',
        jsonb_build_object('mechanical', v_gross, 'electronic', v_elec,
                           'divergence', round(v_elec - v_gross, 3)));
    END IF;

    v_events := v_events + 1;
  END LOOP;

  -- Test fuel physically returned, and bulk draws that bypassed every meter.
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id,
    kind, litres, signed_litres, meter_event_id, occurred_at, recorded_by)
  SELECT v_s.tenant_id, v_s.site_id, n.tank_id, t.product_id, p_shift_id,
         'TEST_RETURN_IN', pt.measured_litres, pt.measured_litres, me.id,
         pt.tested_at, p_actor
    FROM pump_test pt
    JOIN nozzle n ON n.id = pt.nozzle_id
    JOIN tank t   ON t.id = n.tank_id
    JOIN meter_event me ON me.nozzle_id = pt.nozzle_id AND me.shift_id = p_shift_id
   WHERE pt.shift_id = p_shift_id AND pt.returned_to_tank AND pt.measured_litres > 0;

  -- Return-to-tank fuel, back into the book. Without this the meter's
  -- METER_OUT takes the litres off the tank and nothing puts them back, so the
  -- books show less fuel than is in the ground -- and the next dip reports a
  -- GAIN of exactly the returned amount. A cash shortage on one screen and a
  -- stock gain on another, for the same twenty litres.
  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id,
    kind, litres, signed_litres, meter_event_id, occurred_at, recorded_by)
  SELECT v_s.tenant_id, v_s.site_id, n.tank_id, t.product_id, p_shift_id,
         'RTT_IN', r.litres, r.litres, me.id, r.recorded_at, p_actor
    FROM return_to_tank r
    JOIN nozzle n ON n.id = r.nozzle_id
    JOIN tank t   ON t.id = n.tank_id
    JOIN meter_event me ON me.nozzle_id = r.nozzle_id AND me.shift_id = p_shift_id
   WHERE r.shift_id = p_shift_id AND r.litres > 0;

  INSERT INTO fuel_movement (tenant_id, site_id, tank_id, product_id, shift_id,
    kind, litres, signed_litres, bulk_draw_id, occurred_at, recorded_by)
  SELECT v_s.tenant_id, v_s.site_id, bd.tank_id, t.product_id, p_shift_id,
         'BULK_OUT', bd.litres, -bd.litres, bd.id, bd.drawn_at, p_actor
    FROM bulk_draw bd JOIN tank t ON t.id = bd.tank_id
   WHERE bd.shift_id = p_shift_id;

  -- === 3. Closing dips and wet-stock variance ===
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_dips)
  LOOP
    v_tank  := (v_row->>'tank_id')::uuid;
    v_gr    := fn_dip_litres(v_tank, v_row);
    v_wt    := fn_water_litres(v_tank, v_row);
    v_actual := v_gr - v_wt;

    INSERT INTO dip_reading (tenant_id, site_id, tank_id, shift_id, context,
      dip_mm, water_dip_mm, gross_litres, water_litres, product_litres,
      temperature_c, photo_url, evidence, recorded_by, captured_at, idempotency_key)
    VALUES (v_s.tenant_id, v_s.site_id, v_tank, p_shift_id, 'SHIFT_CLOSE',
      NULLIF(v_row->>'dip_mm','')::numeric,
      NULLIF(v_row->>'water_dip_mm','')::numeric,
      v_gr, v_wt, v_actual, (v_row->>'temperature_c')::numeric,
      NULLIF(v_row->>'photo_url',''),
      CASE WHEN COALESCE(v_row->>'photo_url','') <> '' THEN 'PRESENT' ELSE 'PENDING' END::evidence_state,
      p_actor, COALESCE((v_row->>'captured_at')::timestamptz, now()),
      v_row->>'idempotency_key');

    IF COALESCE((v_row->>'water_dip_mm')::numeric,0) > v_pol.water_alarm_mm THEN
      PERFORM fn_raise_flag(v_s.tenant_id, v_s.site_id, p_shift_id,
        'tank', v_tank::text, 'WATER_HIGH', 'CRITICAL',
        jsonb_build_object('water_dip_mm', v_row->>'water_dip_mm'));
    END IF;

    -- Book stock IS the ledger. No stored book_closing to disagree with.
    v_book := fn_book_stock(v_tank);
    v_var  := round(v_actual - v_book, 3);

    SELECT COALESCE(SUM(md.litres),0) INTO v_sale_value
      FROM metered_disposition md
      JOIN meter_event me ON me.id = md.meter_event_id
     WHERE me.shift_id = p_shift_id AND me.tank_id = v_tank AND md.kind='SALE';

    v_var_pct := CASE WHEN v_sale_value > 0 THEN round(v_var / v_sale_value * 100, 4) END;

    -- BOTH tests must pass. v1 checked percentage only, so a 400-litre loss on
    -- a tank with no throughput came back "within tolerance" -- a leaking tank
    -- on a quiet night sailed through.
    v_ok := abs(v_var) <= v_pol.shift_variance_litres
            AND (v_var_pct IS NULL OR abs(v_var_pct) <= v_pol.shift_variance_pct);

    IF NOT v_ok THEN
      PERFORM fn_raise_flag(v_s.tenant_id, v_s.site_id, p_shift_id,
        'tank', v_tank::text, 'STOCK_VARIANCE', 'CRITICAL',
        jsonb_build_object('book', v_book, 'actual', v_actual,
          'variance_litres', v_var, 'variance_pct', v_var_pct,
          'tolerance_litres', v_pol.shift_variance_litres,
          'tolerance_pct', v_pol.shift_variance_pct));
    END IF;

    v_tanks := v_tanks + 1;
  END LOOP;

  -- === 4. Cash-up: one balancing ledger per attendant ===
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_cashups)
  LOOP
    v_att := (v_row->>'attendant_id')::uuid;

    INSERT INTO cash_up (tenant_id, site_id, shift_id, staff_id, currency,
                         status, declared_by, declared_at, notes)
    VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_att, v_cur,
            'DRAFT', p_actor, now(), v_row->>'notes')
    ON CONFLICT (shift_id, staff_id) DO UPDATE
      SET declared_by = EXCLUDED.declared_by, declared_at = EXCLUDED.declared_at,
          status = 'DRAFT'
    RETURNING id INTO v_cashup;

    -- Rebuild from scratch. Deleting and re-inserting is safe here because
    -- money_movement rows for a DRAFT cash-up have not been relied on yet, and
    -- it makes a recompute idempotent instead of additive -- the fault that made
    -- v1 charge an attendant the same shortage twice.
    DELETE FROM money_movement WHERE cash_up_id = v_cashup;
    DELETE FROM staff_shortage WHERE cash_up_id = v_cashup;

    -- (a) the charge: fuel they dispensed, at this shift's captured price
    INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
      entry, amount, currency, meter_event_id, recorded_by)
    SELECT v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
           'SALE', round(md.litres * md.unit_price, 2), v_cur, me.id, p_actor
      FROM meter_event me
      JOIN nozzle_assignment na ON na.id = me.assignment_id
      JOIN metered_disposition md ON md.meter_event_id = me.id AND md.kind='SALE'
     WHERE me.shift_id = p_shift_id AND na.attendant_id = v_att
       AND round(md.litres * md.unit_price, 2) > 0;

    -- (b) the charge: shop and lubricant sales they made
    INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
      entry, amount, currency, dry_sale_id, recorded_by)
    SELECT v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
           'SALE', ds.total_amount, v_cur, ds.id, p_actor
      FROM dry_sale ds
     WHERE ds.shift_id = p_shift_id AND ds.seller_id = v_att;

    -- (c) settlement: cash
    v_amount := COALESCE((v_row->>'cash')::numeric, 0);
    IF v_amount > 0 THEN
      INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
        entry, settlement, amount, currency, recorded_by)
      VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
        'SETTLEMENT', 'CASH', -v_amount, v_cur, p_actor);
    END IF;

    -- (d) settlement: electronic tenders
    FOR v_pay IN SELECT * FROM jsonb_array_elements(COALESCE(v_row->'tenders','[]'::jsonb))
    LOOP
      v_amount := COALESCE((v_pay->>'amount')::numeric, 0);
      CONTINUE WHEN v_amount = 0;
      SELECT pc.id, pc.kind INTO v_channel, v_kind FROM payment_channel pc
       WHERE pc.site_id = v_s.site_id AND pc.code = v_pay->>'channel_code' AND pc.is_active;
      IF v_channel IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_CHANNEL: % is not an active tender at this station',
          v_pay->>'channel_code' USING ERRCODE='check_violation';
      END IF;
      INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
        entry, settlement, channel_id, amount, currency, reference, evidence_url, recorded_by)
      VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
        'SETTLEMENT', v_kind, v_channel, -v_amount, v_cur,
        v_pay->>'reference', v_pay->>'evidence_url', p_actor);
    END LOOP;

    -- (e) settlement: credit sales they booked. DERIVED from named customer
    -- records, never typed as a lump sum -- that is what makes the receivable
    -- collectable.
    INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
      entry, settlement, amount, currency, credit_sale_id, reference, recorded_by)
    SELECT v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
           'SETTLEMENT', 'CREDIT', -cs.amount, v_cur, cs.id, cs.voucher_no, p_actor
      FROM credit_sale cs
     WHERE cs.shift_id = p_shift_id AND cs.staff_id = v_att;

    -- (f) settlement: authorised discounts
    INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
      entry, settlement, amount, currency, discount_id, reference, recorded_by)
    SELECT v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
           'SETTLEMENT', 'DISCOUNT', -dg.amount, v_cur, dg.id, dg.reason, p_actor
      FROM discount_grant dg
     WHERE dg.shift_id = p_shift_id AND dg.staff_id = v_att;

    -- (g) whatever is left is a shortage or an overage. Nothing is written off
    -- silently: the gap becomes a named receivable against a named person.
    SELECT COALESCE(SUM(amount),0) INTO v_short
      FROM money_movement WHERE cash_up_id = v_cashup;

    IF v_short > 0 THEN
      INSERT INTO staff_shortage (tenant_id, site_id, staff_id, shift_id, cash_up_id,
        amount, currency, reason)
      VALUES (v_s.tenant_id, v_s.site_id, v_att, p_shift_id, v_cashup,
        round(v_short,2), v_cur,
        COALESCE(v_row->>'shortage_reason', 'Unallocated at cash-up'))
      RETURNING id INTO v_shortage_id;

      INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
        entry, settlement, amount, currency, shortage_id, recorded_by)
      VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
        'SETTLEMENT', 'SHORTAGE', -round(v_short,2), v_cur, v_shortage_id, p_actor);

      IF v_short >= v_pol.cash_variance_alert THEN
        PERFORM fn_raise_flag(v_s.tenant_id, v_s.site_id, p_shift_id,
          'cash_up', v_cashup::text, 'CASH_SHORT', 'CRITICAL',
          jsonb_build_object('attendant_id', v_att, 'amount', v_short));
      END IF;

    ELSIF v_short < 0 THEN
      INSERT INTO money_movement (tenant_id, site_id, shift_id, cash_up_id, staff_id,
        entry, settlement, amount, currency, reference, recorded_by)
      VALUES (v_s.tenant_id, v_s.site_id, p_shift_id, v_cashup, v_att,
        'SETTLEMENT', 'OVERAGE', -v_short, v_cur,
        COALESCE(v_row->>'shortage_reason','Declared over'), p_actor);
    END IF;

    -- This flips on the balance rule. If anything above is inconsistent, the
    -- deferred trigger refuses the whole close at COMMIT.
    UPDATE cash_up SET status='DECLARED' WHERE id = v_cashup;
    v_cashups := v_cashups + 1;
  END LOOP;

  -- === 5. Close ===
  UPDATE shift SET state='DECLARED', closed_at=now(), closed_by=p_actor,
                   closed_reason=p_reason
   WHERE id = p_shift_id;

  RETURN jsonb_build_object(
    'shift_id', p_shift_id, 'meter_events', v_events,
    'tanks_reconciled', v_tanks, 'cash_ups', v_cashups,
    'exceptions', (SELECT count(*) FROM exception_flag
                    WHERE shift_id = p_shift_id AND resolved_at IS NULL));
END $$;
