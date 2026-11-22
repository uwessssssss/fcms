-- 710: a close's variance is measured from the previous close's MOMENT, not
-- from its dip's capture time.
--
-- Found by tools/audit/shift_math.sql. fn_close_variance (430) took the book
-- at the previous dip's captured_at. A close writes its METER_OUT at the
-- moment it runs; the API accepts an earlier captured_at for each dip (an
-- offline client). With the dip stamped even minutes before the close ran,
-- the previous level was measured before that shift's own sales left the
-- book, and the NEXT close's variance moved by all of them: on the demo seed,
-- -2,529.7 L where the tank had changed by +4.8 L. The web screen sends no
-- capture time, so this had not shown -- an offline client would trip it on
-- every close.
--
-- The previous close's moment: when it wrote its meter movements (as late as
-- its dip if that is later). The stock-take window starts there too.
CREATE OR REPLACE FUNCTION fn_close_variance(p_tank_id uuid, p_actual numeric,
                                             p_at timestamptz, p_shift_id uuid)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_prev  dip_reading%ROWTYPE;
  v_prev_at timestamptz;
  v_prev_level numeric := 0;
  v_adj   numeric := 0;
BEGIN
  SELECT * INTO v_prev FROM dip_reading
   WHERE tank_id = p_tank_id AND context = 'SHIFT_CLOSE'
     AND shift_id IS DISTINCT FROM p_shift_id AND captured_at < p_at
   ORDER BY captured_at DESC, id DESC LIMIT 1;
  IF FOUND THEN
    v_prev_at := GREATEST(v_prev.captured_at,
                          COALESCE((SELECT max(fm.occurred_at) FROM fuel_movement fm
                                     WHERE fm.shift_id = v_prev.shift_id AND fm.kind = 'METER_OUT'),
                                   v_prev.captured_at));
    v_prev_level := v_prev.product_litres - fn_book_stock(p_tank_id, v_prev_at);
    SELECT COALESCE(SUM(signed_litres), 0) INTO v_adj FROM fuel_movement
     WHERE tank_id = p_tank_id AND kind = 'STOCK_TAKE_ADJUST'
       AND occurred_at > v_prev_at AND occurred_at <= p_at;
  END IF;
  RETURN (p_actual - fn_book_stock(p_tank_id, p_at)) - v_prev_level + v_adj;
END $$;
