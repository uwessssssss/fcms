-- =============================================================================
-- FCMS v2 -- 070_operations.sql
--
-- Deliveries, fuel stock counts, and THE CLOSE.
--
-- The close is one function in one transaction. In v1 a close spanned three
-- independent transactions (two Dapper connections plus an EF context), so a
-- failure between them left readings captured, assignments closed, no cash-up,
-- and a shift stuck at READINGS_DONE that could not be retried -- the station
-- was wedged. That is audit finding C9 and it is fixed by construction here:
-- either the whole close commits or none of it did.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Retrofit to 050/060.
--
-- These belong inside those two files; they are separate only because those
-- files were issued before dry stock and the authorship rule were settled.
-- Fold them in before the first run -- do not let the schema accumulate a
-- patch history, which is exactly what went wrong in v1.
-- ---------------------------------------------------------------------------
ALTER TABLE money_movement DROP CONSTRAINT sale_has_meter_event;
ALTER TABLE money_movement ADD COLUMN dry_sale_id uuid REFERENCES dry_sale(id);
ALTER TABLE money_movement ADD CONSTRAINT sale_has_a_source CHECK (
  entry <> 'SALE' OR meter_event_id IS NOT NULL OR dry_sale_id IS NOT NULL);

-- A cash-up is declared by one operator and approved by another. The v1
-- constraint compared the approver to the ATTENDANT, which after the
-- attendants-do-not-sign-in decision is trivially true and enforces nothing.
ALTER TABLE cash_up ADD CONSTRAINT cashup_two_pairs_of_eyes
  CHECK (approved_by IS NULL OR declared_by IS NULL OR approved_by <> declared_by);

DO $$
BEGIN
  PERFORM fn_require_operator_author('meter_reading', 'recorded_by');
  PERFORM fn_require_operator_author('dip_reading', 'recorded_by');
  PERFORM fn_require_operator_author('fuel_movement', 'recorded_by');
END $$;
DO $$
BEGIN
  PERFORM fn_require_operator_author('money_movement', 'recorded_by');
END $$;
DO $$
BEGIN
  PERFORM fn_require_operator_author('cash_up', 'declared_by');
  PERFORM fn_require_operator_author('cash_up', 'approved_by');
  PERFORM fn_require_operator_author('pump_test', 'tested_by');
  PERFORM fn_require_operator_author('own_use', 'authorised_by');
  PERFORM fn_require_operator_author('bulk_draw', 'authorised_by');
  PERFORM fn_require_operator_author('credit_sale', 'staff_id');
END $$;
DO $$
BEGIN
  PERFORM fn_require_operator_author('discount_grant', 'authorised_by');
END $$;
DO $$
BEGIN
  PERFORM fn_require_operator_author('banking', 'banked_by');
END $$;

-- ---------------------------------------------------------------------------
-- Deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE supplier (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  name       text NOT NULL,
  contact    text,
  is_active  boolean NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  supplier_id   uuid REFERENCES supplier(id),
  -- The shift during which the fuel physically went into the ground. NOT the
  -- shift the paperwork arrived in. v1 joined receipts on the header's shift,
  -- so a truck that arrived in one shift and decanted in the next credited the
  -- wrong tank period and stock walked.
  decant_shift_id uuid REFERENCES shift(id),
  delivery_note_no text NOT NULL,
  invoice_no    text,
  depot         text,
  transporter   text,
  truck_reg     text,
  trailer_reg   text,
  driver_name   text,
  driver_id_no  text,
  seal_numbers  text[],
  seals_intact  boolean,
  seal_photo_url text,
  arrived_at    timestamptz,
  decant_started_at timestamptz,
  decant_ended_at   timestamptz,
  settle_until  timestamptz,
  status        text NOT NULL DEFAULT 'IN_TRANSIT'
                  CHECK (status IN ('IN_TRANSIT','ARRIVED','DECANTING','RECEIVED','REJECTED')),
  received_by   uuid REFERENCES staff(id),
  approved_by   uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, delivery_note_no),
  CHECK (decant_ended_at IS NULL OR decant_started_at IS NULL
         OR decant_ended_at >= decant_started_at),
  -- Broken seals are the single loudest signal of transit theft. A received
  -- load must state one way or the other.
  CONSTRAINT received_needs_seal_check
    CHECK (status <> 'RECEIVED' OR seals_intact IS NOT NULL),
  CONSTRAINT received_names_a_shift
    CHECK (status <> 'RECEIVED' OR decant_shift_id IS NOT NULL)
);
CREATE INDEX ON delivery (site_id, arrived_at DESC);
CREATE INDEX ON delivery (decant_shift_id);

DO $$
BEGIN
  PERFORM fn_require_operator_author('delivery', 'received_by');
  PERFORM fn_require_operator_author('delivery', 'approved_by');
END $$;

CREATE TABLE delivery_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  delivery_id   uuid NOT NULL REFERENCES delivery(id) ON DELETE CASCADE,
  tank_id       uuid NOT NULL REFERENCES tank(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  loaded_litres numeric(12,3) NOT NULL CHECK (loaded_litres > 0),
  loaded_temp_c numeric(5,2),
  loaded_density numeric(8,4),
  dip_before_id bigint REFERENCES dip_reading(id),
  dip_after_id  bigint REFERENCES dip_reading(id),
  -- What the dips say actually went in. This, not the delivery note, is what
  -- enters the ledger.
  received_litres numeric(12,3) CHECK (received_litres IS NULL OR received_litres >= 0),
  rejected_litres numeric(12,3) NOT NULL DEFAULT 0 CHECK (rejected_litres >= 0),
  rejection_reason text,
  transit_variance numeric(12,3)
    GENERATED ALWAYS AS (received_litres - loaded_litres) STORED,
  unit_cost     numeric(12,4),
  UNIQUE (delivery_id, tank_id),
  CONSTRAINT rejection_needs_reason
    CHECK (rejected_litres = 0 OR rejection_reason IS NOT NULL)
);
CREATE INDEX ON delivery_line (tank_id);

ALTER TABLE fuel_movement
  ADD CONSTRAINT fk_movement_delivery_line
  FOREIGN KEY (delivery_line_id) REFERENCES delivery_line(id);

-- ---------------------------------------------------------------------------
-- Receiving a delivery writes it into the fuel ledger. Until this runs, the
-- fuel is on paper only and book stock does not know about it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_receive_delivery(
  p_delivery_id uuid, p_shift_id uuid, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_d delivery%ROWTYPE; v_pol tenant_policy%ROWTYPE;
  v_line record; v_n int := 0; v_total numeric := 0; v_pct numeric;
BEGIN
  SELECT * INTO v_d FROM delivery WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_DELIVERY: %', p_delivery_id USING ERRCODE='no_data_found';
  END IF;
  IF v_d.status = 'RECEIVED' THEN
    RAISE EXCEPTION 'ALREADY_RECEIVED: delivery % is already in the ledger', v_d.delivery_note_no
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pol FROM tenant_policy WHERE tenant_id = v_d.tenant_id;

  FOR v_line IN SELECT * FROM delivery_line WHERE delivery_id = p_delivery_id
  LOOP
    IF v_line.received_litres IS NULL THEN
      RAISE EXCEPTION
        'DELIVERY_NOT_DIPPED: a tank on % has no received quantity. Dip before '
        'and after the decant -- the delivery note is a claim, the dip is evidence.',
        v_d.delivery_note_no USING ERRCODE = 'check_violation';
    END IF;

    IF v_line.received_litres - v_line.rejected_litres > 0 THEN
      INSERT INTO fuel_movement (
        tenant_id, site_id, tank_id, product_id, shift_id, kind,
        litres, signed_litres, unit_cost, delivery_line_id, occurred_at, recorded_by)
      VALUES (
        v_d.tenant_id, v_d.site_id, v_line.tank_id, v_line.product_id, p_shift_id,
        'DELIVERY_IN',
        v_line.received_litres - v_line.rejected_litres,
        v_line.received_litres - v_line.rejected_litres,
        v_line.unit_cost,
        v_line.id,
        COALESCE(v_d.decant_ended_at, now()), p_actor);
      v_n := v_n + 1;
      v_total := v_total + (v_line.received_litres - v_line.rejected_litres);
    END IF;

    -- Transit loss: what left the depot vs what reached the ground.
    v_pct := CASE WHEN v_line.loaded_litres > 0
                  THEN abs(v_line.transit_variance) / v_line.loaded_litres * 100 END;
    IF v_pct IS NOT NULL AND v_pct > v_pol.transit_loss_pct THEN
      PERFORM fn_raise_flag(v_d.tenant_id, v_d.site_id, p_shift_id,
        'delivery_line', v_line.id::text, 'TRANSIT_LOSS', 'CRITICAL',
        jsonb_build_object('note', v_d.delivery_note_no, 'truck', v_d.truck_reg,
          'loaded', v_line.loaded_litres, 'received', v_line.received_litres,
          'variance', v_line.transit_variance, 'pct', round(v_pct,4)));
    END IF;
  END LOOP;

  IF NOT COALESCE(v_d.seals_intact, TRUE) THEN
    PERFORM fn_raise_flag(v_d.tenant_id, v_d.site_id, p_shift_id,
      'delivery', p_delivery_id::text, 'SEALS_BROKEN', 'CRITICAL',
      jsonb_build_object('note', v_d.delivery_note_no, 'truck', v_d.truck_reg));
  END IF;

  UPDATE delivery
     SET status = 'RECEIVED', decant_shift_id = p_shift_id, received_by = p_actor,
         settle_until = COALESCE(decant_ended_at, now())
                        + (v_pol.post_decant_settle_min || ' minutes')::interval
   WHERE id = p_delivery_id;

  RETURN jsonb_build_object('delivery_id', p_delivery_id, 'lines', v_n,
                            'litres_received', v_total);
END $$;

-- ---------------------------------------------------------------------------
-- Fuel stock count
-- ---------------------------------------------------------------------------
CREATE TABLE stock_count (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  shift_id     uuid REFERENCES shift(id),
  counted_on   date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('MONTHLY','SURPRISE','HANDOVER','ANNUAL')),
  status       text NOT NULL DEFAULT 'COUNTING'
                 CHECK (status IN ('COUNTING','COUNTED','APPROVED','POSTED')),
  counted_by   uuid NOT NULL REFERENCES staff(id),
  witnessed_by uuid REFERENCES staff(id),
  approved_by  uuid REFERENCES staff(id),
  approved_at  timestamptz,
  posted_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT count_segregation CHECK (approved_by IS NULL OR approved_by <> counted_by)
);

DO $$
BEGIN
  PERFORM fn_require_operator_author('stock_count', 'counted_by');
  PERFORM fn_require_operator_author('stock_count', 'approved_by');
END $$;

CREATE TABLE stock_count_tank (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  count_id     uuid NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
  tank_id      uuid NOT NULL REFERENCES tank(id),
  dip_id       bigint REFERENCES dip_reading(id),
  book_litres  numeric(12,3) NOT NULL,
  counted_litres numeric(12,3) NOT NULL CHECK (counted_litres >= 0),
  variance_litres numeric(12,3) GENERATED ALWAYS AS (counted_litres - book_litres) STORED,
  variance_reason text,
  UNIQUE (count_id, tank_id)
);

ALTER TABLE fuel_movement
  ADD CONSTRAINT fk_movement_stock_count
  FOREIGN KEY (stock_count_id) REFERENCES stock_count(id);

CREATE OR REPLACE FUNCTION fn_post_stock_count(p_count_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_c stock_count%ROWTYPE; v_t record; v_n int := 0;
BEGIN
  SELECT * INTO v_c FROM stock_count WHERE id = p_count_id FOR UPDATE;
  IF v_c.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'COUNT_NOT_APPROVED: %', v_c.status USING ERRCODE='check_violation';
  END IF;

  FOR v_t IN SELECT sct.*, t.product_id FROM stock_count_tank sct
               JOIN tank t ON t.id = sct.tank_id
              WHERE sct.count_id = p_count_id AND sct.counted_litres <> sct.book_litres
  LOOP
    IF v_t.variance_reason IS NULL THEN
      RAISE EXCEPTION
        'COUNT_VARIANCE_UNEXPLAINED: tank variance of % L has no reason recorded',
        v_t.variance_litres USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO fuel_movement (
      tenant_id, site_id, tank_id, product_id, shift_id, kind,
      litres, signed_litres, stock_count_id, correction_note, occurred_at, recorded_by)
    VALUES (
      v_c.tenant_id, v_c.site_id, v_t.tank_id, v_t.product_id, v_c.shift_id,
      'STOCK_TAKE_ADJUST', abs(v_t.variance_litres), v_t.variance_litres,
      p_count_id, v_t.variance_reason, now(), p_actor);
    v_n := v_n + 1;
  END LOOP;

  UPDATE stock_count SET status='POSTED', posted_at=now() WHERE id = p_count_id;
  RETURN jsonb_build_object('count_id', p_count_id, 'adjustments', v_n);
END $$;

-- =============================================================================
-- OPEN
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_open_shift(
  p_site_id uuid, p_label text, p_actor uuid,
  p_opening_dips jsonb DEFAULT '[]'::jsonb,
  p_roster jsonb DEFAULT '[]'::jsonb,
  p_predecessor uuid DEFAULT NULL,
  p_business_date date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid; v_shift uuid; v_date date; v_seg int := 1;
  v_row jsonb; v_dip bigint; v_gross numeric; v_water numeric;
  v_missing text[]; v_prev_reading numeric;
BEGIN
  SELECT tenant_id INTO v_tenant FROM site WHERE id = p_site_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_SITE: %', p_site_id USING ERRCODE='no_data_found';
  END IF;

  PERFORM 1 FROM site WHERE id = p_site_id FOR UPDATE;   -- serialise openers

  v_date := COALESCE(p_business_date, fn_business_date(p_site_id, now()));

  IF p_predecessor IS NOT NULL THEN
    SELECT segment + 1, business_date INTO v_seg, v_date
      FROM shift WHERE id = p_predecessor;
  END IF;

  -- Every active tank needs an opening dip. A shift that starts without knowing
  -- what is in the ground cannot produce a variance worth reading.
  SELECT array_agg(t.code ORDER BY t.code) INTO v_missing
    FROM tank t WHERE t.site_id = p_site_id AND t.is_active
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_opening_dips) d
                      WHERE (d->>'tank_id')::uuid = t.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'MISSING_OPENING_DIPS: tank(s) %', array_to_string(v_missing, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO shift (tenant_id, site_id, business_date, label, segment,
                     predecessor_id, state, opened_at, opened_by)
  VALUES (v_tenant, p_site_id, v_date, p_label, v_seg, p_predecessor,
          'OPEN', now(), p_actor)
  RETURNING id INTO v_shift;

  PERFORM fn_capture_shift_prices(v_shift);

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_opening_dips)
  LOOP
    -- Litres if they were given, converted from millimetres if not.
    v_gross := fn_dip_litres((v_row->>'tank_id')::uuid, v_row);
    v_water := fn_water_litres((v_row->>'tank_id')::uuid, v_row);

    INSERT INTO dip_reading (tenant_id, site_id, tank_id, shift_id, context,
      dip_mm, water_dip_mm, gross_litres, water_litres, product_litres,
      temperature_c, photo_url, evidence, recorded_by, captured_at, idempotency_key)
    VALUES (v_tenant, p_site_id, (v_row->>'tank_id')::uuid, v_shift, 'SHIFT_OPEN',
      NULLIF(v_row->>'dip_mm','')::numeric,
      NULLIF(v_row->>'water_dip_mm','')::numeric,
      v_gross, v_water, v_gross - v_water,
      (v_row->>'temperature_c')::numeric, NULLIF(v_row->>'photo_url',''),
      CASE WHEN COALESCE(v_row->>'photo_url','') <> '' THEN 'PRESENT' ELSE 'PENDING' END::evidence_state,
      p_actor, COALESCE((v_row->>'captured_at')::timestamptz, now()),
      v_row->>'idempotency_key');
  END LOOP;

  -- Roster: assign nozzles, and carry each nozzle's last closing reading
  -- forward as this assignment's opening. Re-keying an opening reading is how
  -- litres get invented; the meter does not reset between shifts.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_roster)
  LOOP
    DECLARE v_assign uuid; v_nozzle uuid := (v_row->>'nozzle_id')::uuid;
    BEGIN
      INSERT INTO nozzle_assignment (tenant_id, site_id, shift_id, nozzle_id,
                                     attendant_id, assigned_by)
      VALUES (v_tenant, p_site_id, v_shift, v_nozzle,
              (v_row->>'attendant_id')::uuid, p_actor)
      RETURNING id INTO v_assign;

      SELECT mr.volume_totalizer INTO v_prev_reading
        FROM meter_reading mr WHERE mr.nozzle_id = v_nozzle AND NOT mr.is_opening
       ORDER BY mr.captured_at DESC, mr.id DESC LIMIT 1;

      INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id,
        assignment_id, is_opening, source, volume_totalizer, electronic_totalizer,
        photo_url, evidence, recorded_by, captured_at)
      VALUES (v_tenant, p_site_id, v_nozzle, v_shift, v_assign, TRUE,
        COALESCE((v_row->>'source')::reading_source,'MANUAL'),
        COALESCE((v_row->>'volume_totalizer')::numeric, v_prev_reading, 0),
        (v_row->>'electronic_totalizer')::numeric,
        NULLIF(v_row->>'photo_url',''),
        CASE WHEN COALESCE(v_row->>'photo_url','') <> '' THEN 'PRESENT' ELSE 'PENDING' END::evidence_state,
        p_actor, COALESCE((v_row->>'captured_at')::timestamptz, now()));
    END;
  END LOOP;

  RETURN v_shift;
END $$;

-- =============================================================================
-- CLOSE -- one transaction, both ledgers, all invariants.
-- =============================================================================
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
  v_tests numeric; v_own_metered numeric; v_sale numeric; v_price numeric;
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

    v_sale := round(v_gross - v_tests - v_own_metered, 3);
    IF v_sale < 0 THEN
      RAISE EXCEPTION
        'DISPOSITION_EXCEEDS_METER: nozzle held by assignment % dispensed % L but '
        '% L of tests and own-use are recorded against it.',
        v_assign.id, v_gross, v_tests + v_own_metered USING ERRCODE='check_violation';
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

COMMENT ON FUNCTION fn_close_shift IS
  'The whole close in one transaction: readings, meter events, dispositions, '
  'fuel ledger, dips, variance, and a balancing cash-up per attendant. Either '
  'all of it commits or none of it did.';

-- =============================================================================
-- PRICE BREAK -- close the segment, move the price, open the successor.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_execute_price_break(
  p_price_change_id uuid, p_actor uuid,
  p_readings jsonb, p_dips jsonb, p_cashups jsonb, p_next_roster jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pc price_change%ROWTYPE; v_live uuid; v_next uuid; v_closed jsonb;
BEGIN
  SELECT * INTO v_pc FROM price_change WHERE id = p_price_change_id FOR UPDATE;
  IF v_pc.status <> 'PENDING' THEN
    RAISE EXCEPTION 'PRICE_NOT_PENDING: change is %', v_pc.status USING ERRCODE='check_violation';
  END IF;

  PERFORM 1 FROM site WHERE id = v_pc.site_id FOR UPDATE;

  SELECT id INTO v_live FROM shift
   WHERE site_id = v_pc.site_id AND state IN ('OPEN','COUNTING');

  IF v_live IS NULL THEN
    -- Station closed: nothing to cut, and the schema says so explicitly rather
    -- than leaving the executed change with dangling shift references.
    UPDATE price_change SET status='EXECUTED', executed_at=now(), no_shift_to_break=TRUE
     WHERE id = p_price_change_id;
    RETURN jsonb_build_object('executed', TRUE, 'broke_shift', FALSE);
  END IF;

  v_closed := fn_close_shift(v_live, p_actor, 'PRICE_CHANGE',
                             p_readings, p_dips, p_cashups);

  UPDATE price_change SET status='EXECUTED', executed_at=now(), shift_closed_id=v_live
   WHERE id = p_price_change_id;

  -- The new price must be executed BEFORE the successor opens, so that
  -- fn_capture_shift_prices stamps the new figure onto it.
  v_next := fn_open_shift(v_pc.site_id,
              (SELECT label FROM shift WHERE id = v_live),
              p_actor,
              (SELECT jsonb_agg(jsonb_build_object('tank_id', d->>'tank_id',
                                                   'dip_mm', d->>'dip_mm',
                                                   'water_dip_mm', d->>'water_dip_mm'))
                 FROM jsonb_array_elements(p_dips) d),
              p_next_roster, v_live);

  UPDATE price_change SET shift_opened_id = v_next WHERE id = p_price_change_id;

  RETURN jsonb_build_object('executed', TRUE, 'broke_shift', TRUE,
    'shift_closed', v_live, 'shift_opened', v_next, 'close', v_closed);
END $$;
