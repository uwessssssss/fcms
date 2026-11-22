-- =============================================================================
-- FCMS v2 -- test/close_gates.sql
--
-- A shift closes only when everything is in, and both meters agree (730).
-- Run AFTER the three seeds, on the seeded open night shift. Rolls back.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SELECT set_config('app.tenant_id', '0a000000-0000-4000-8000-000000000001', true),
       set_config('app.staff_id', '10000000-0000-4000-8000-000000000003', true) \gset

-- Close the open shift: every active nozzle sells p_litres on the manual
-- meter; N1's electronic head reads p_n1_apart litres more (NULL: not read).
CREATE FUNCTION pg_temp.close_it(p_n1_apart numeric, p_reason text, p_short_reason text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_shf uuid := (SELECT id FROM shift WHERE state = 'OPEN');
BEGIN
  RETURN fn_close_shift(v_shf, '10000000-0000-4000-8000-000000000003', 'SCHEDULED',
    (SELECT jsonb_agg(jsonb_build_object(
        'assignment_id', na.id, 'is_rollover', false,
        'volume_totalizer', mo.volume_totalizer + 100,
        'electronic_totalizer', CASE WHEN n.code = 'N1' AND p_n1_apart IS NULL THEN NULL
                                     ELSE mo.electronic_totalizer + 100 + CASE WHEN n.code = 'N1' THEN p_n1_apart ELSE 0 END END,
        'difference_reason', CASE WHEN n.code = 'N1' THEN p_reason END))
       FROM nozzle_assignment na JOIN nozzle n ON n.id = na.nozzle_id
       JOIN meter_reading mo ON mo.assignment_id = na.id AND mo.is_opening
      WHERE na.shift_id = v_shf AND na.state = 'ACTIVE'),
    (SELECT jsonb_agg(jsonb_build_object('tank_id', t.id, 'product_litres',
              fn_book_stock(t.id) - 100 * (SELECT count(*) FROM nozzle n2 JOIN nozzle_assignment a2 ON a2.nozzle_id = n2.id
                                            WHERE a2.shift_id = v_shf AND a2.state = 'ACTIVE' AND n2.tank_id = t.id),
              'water_litres', 0))
       FROM tank t WHERE t.site_id = (SELECT site_id FROM shift WHERE id = v_shf) AND t.is_active),
    (SELECT jsonb_agg(jsonb_build_object('attendant_id', w.staff_id, 'cash', 0, 'tenders', '[]'::jsonb,
                                         'shortage_reason', p_short_reason))
       FROM (SELECT DISTINCT attendant_id AS staff_id FROM nozzle_assignment WHERE shift_id = v_shf
             UNION SELECT attendant_id FROM cash_drop WHERE shift_id = v_shf AND voided_at IS NULL) w));
END $$;

CREATE FUNCTION pg_temp.refused(p_sql text, p_code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE p_code || '%' THEN
      RAISE EXCEPTION 'GATE: expected %, refused with: %', p_code, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'GATE: % was not refused', p_code;
END $$;

\echo '  gates: the seeded openings carry both meters'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM meter_reading mr JOIN shift s ON s.id = mr.shift_id
              WHERE s.state = 'OPEN' AND mr.is_opening AND mr.electronic_totalizer IS NULL) THEN
    RAISE EXCEPTION 'GATE: an opening reading without its electronic meter';
  END IF;
END $$;

\echo '  gates: a reading with no electronic meter is refused'
SELECT pg_temp.refused($q$
  INSERT INTO meter_reading (tenant_id, site_id, nozzle_id, shift_id, is_opening, source, volume_totalizer, recorded_by)
  SELECT n.tenant_id, n.site_id, n.id, (SELECT id FROM shift WHERE state = 'OPEN'), FALSE, 'MANUAL', 1, '10000000-0000-4000-8000-000000000003'
    FROM nozzle n WHERE n.code = 'N1' LIMIT 1 $q$, 'ELECTRONIC_READING_REQUIRED') \gset
SELECT pg_temp.refused($q$ SELECT pg_temp.close_it(NULL, NULL, 'Gate test') $q$, 'ELECTRONIC_READING_REQUIRED') \gset

\echo '  gates: 1.5 L between the meters stops the close; 1.0 L does not'
SELECT pg_temp.refused($q$ SELECT pg_temp.close_it(1.5, NULL, 'Gate test') $q$, 'METER_PAIR_DISAGREES') \gset
SELECT pg_temp.refused($q$ SELECT pg_temp.close_it(-1.5, NULL, 'Gate test') $q$, 'METER_PAIR_DISAGREES') \gset
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.close_it(1.0, NULL, 'Gate test');
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback' THEN RAISE; END IF;
  END;
END $$;

\echo '  gates: an unexplained shortage stops the close; the preview still shows it'
SELECT pg_temp.refused($q$ SELECT pg_temp.close_it(0, NULL, NULL) $q$, 'SHORTAGE_NEEDS_REASON') \gset
DO $$ BEGIN
  PERFORM set_config('fcms.close_preview', 'on', true);
  BEGIN
    PERFORM pg_temp.close_it(0, NULL, NULL);
    IF NOT EXISTS (SELECT 1 FROM staff_shortage ss JOIN shift s ON s.id = ss.shift_id WHERE s.state = 'DECLARED') THEN
      RAISE EXCEPTION 'GATE: the preview did not show the shortage';
    END IF;
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback' THEN RAISE; END IF;
  END;
  PERFORM set_config('fcms.close_preview', 'off', true);
END $$;

\echo '  gates: a delivery being decanted stops the close'
DO $$ BEGIN
  BEGIN
    UPDATE delivery SET status = 'DECANTING', decant_started_at = now() - interval '10 minutes', decant_ended_at = NULL
     WHERE delivery_note_no = 'DN-88213';
    PERFORM pg_temp.close_it(0, NULL, 'Gate test');
    RAISE EXCEPTION 'GATE: closed with a delivery decanting';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DELIVERY_NOT_RECEIVED%' THEN RAISE; END IF;
  END;
END $$;

\echo '  gates: the meters 3 L apart close with a reason, flagged CRITICAL'
SELECT pg_temp.close_it(3, 'Electronic head sticking on N1, technician called', 'Gate test') IS NOT NULL AS closed \gset
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM exception_flag WHERE code = 'METER_DIVERGENCE' ORDER BY raised_at DESC LIMIT 1;
  IF f IS NULL OR f.level <> 'CRITICAL' OR (f.detail->>'divergence')::numeric <> 3
     OR f.detail->>'reason' NOT LIKE 'Electronic head sticking%' THEN
    RAISE EXCEPTION 'GATE: the 3 L divergence was not flagged CRITICAL with its reason: %', f.detail;
  END IF;
  IF (SELECT divergence_litres FROM meter_event me JOIN nozzle n ON n.id = me.nozzle_id
       WHERE n.code = 'N1' ORDER BY me.id DESC LIMIT 1) <> 3 THEN
    RAISE EXCEPTION 'GATE: the meter event does not record the 3 L';
  END IF;
END $$;

\echo '  gates: the next opening carries both meters from this close'
DO $$
DECLARE v_new uuid; v_close numeric; v_open numeric;
BEGIN
  v_new := fn_open_shift('0b000000-0000-4000-8000-000000000001', 'DAY', '10000000-0000-4000-8000-000000000003',
    (SELECT jsonb_agg(jsonb_build_object('tank_id', t.id, 'product_litres', fn_book_stock(t.id), 'water_litres', 0))
       FROM tank t WHERE t.site_id = '0b000000-0000-4000-8000-000000000001' AND t.is_active),
    (SELECT jsonb_agg(jsonb_build_object('nozzle_id', n.id, 'attendant_id', '10000000-0000-4000-8000-000000000013'))
       FROM nozzle n WHERE n.code = 'N1' AND n.site_id = '0b000000-0000-4000-8000-000000000001'),
    NULL, (now() AT TIME ZONE 'Africa/Kampala')::date + 1);
  SELECT mr.electronic_totalizer INTO v_close FROM meter_reading mr JOIN nozzle n ON n.id = mr.nozzle_id
   WHERE n.code = 'N1' AND NOT mr.is_opening AND n.site_id = '0b000000-0000-4000-8000-000000000001'
   ORDER BY mr.captured_at DESC, mr.id DESC LIMIT 1;
  SELECT mr.electronic_totalizer INTO v_open FROM meter_reading mr WHERE mr.shift_id = v_new AND mr.is_opening;
  IF v_open IS DISTINCT FROM v_close THEN
    RAISE EXCEPTION 'GATE: the opening electronic % is not the last closing %', v_open, v_close;
  END IF;
END $$;

ROLLBACK;
\echo '  ALL CLOSE GATES HOLD: both meters, 1 L, deliveries received, shortages explained.'
