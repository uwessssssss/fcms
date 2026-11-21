-- =============================================================================
-- FCMS v2 -- 610_general_ledger.sql
--
-- THE BOOKS. A double-entry general ledger, fed by the operations themselves.
--
--   gl_account   the chart of accounts, per company (seeded, extendable)
--   gl_period    months; a closed month takes no more postings
--   gl_journal   one per business event, in the same transaction as the event
--   gl_line      debit +, credit -; every journal sums to zero; tagged with
--                the customer, supplier, staff member, tank, item or channel
--                it concerns, so each control account has its sub-ledger
--
-- Rules:
--   * Nothing posts by hand except a manual journal (fn_gl_manual_journal) by
--     an accountant, manager or head office -- and that is balanced too.
--   * A journal is never edited or deleted. A mistake is reversed and posted
--     again (fn_gl_reverse).
--   * The app role can read the books, not write them: posting functions run
--     as fcms_ledger, which owns the right to insert.
--   * A shift posts when it is DECLARED (closed). Closes happen in order, one
--     per station, so stock and cost are always posted in sequence; approval
--     remains the manager's review.
--   * Fuel and shop stock are valued at MOVING AVERAGE cost, read from the
--     ledger itself (value / quantity of the tank's inventory lines). After
--     every close the ledger's litres for a tank equal its closing dip: the
--     difference posts to stock gains and losses. So the stock reconciliation
--     ties to the litre.
--   * A posting dated in a closed month goes to the first open month after;
--     the journal keeps the date the event happened.
-- =============================================================================

CREATE TYPE gl_account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

CREATE TABLE gl_account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  name       text NOT NULL,
  type       gl_account_type NOT NULL,
  -- A control account keeps a sub-ledger: each line names who or what.
  control    text CHECK (control IN ('CUSTOMER', 'SUPPLIER', 'STAFF', 'TANK', 'ITEM', 'CHANNEL', 'SITE')),
  is_active  boolean NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE gl_period (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  period_start date NOT NULL CHECK (extract(day FROM period_start) = 1),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES staff(id),
  PRIMARY KEY (tenant_id, period_start)
);

CREATE TABLE gl_journal (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid REFERENCES site(id),
  posting_date date NOT NULL,            -- the month it counts in
  event_at     timestamptz NOT NULL,     -- when it happened
  source       text NOT NULL,            -- 'shift', 'banking', 'delivery_line', ... or 'manual'
  source_id    text,
  memo         text NOT NULL,
  reverses_id  uuid REFERENCES gl_journal(id),
  posted_by    uuid REFERENCES staff(id),  -- NULL = posted by the system from the event
  posted_at    timestamptz NOT NULL DEFAULT now()
);
-- One live posting per event; a reversal and a re-post sit beside it.
CREATE UNIQUE INDEX gl_journal_one_per_event ON gl_journal (tenant_id, source, source_id)
  WHERE reverses_id IS NULL AND source <> 'manual';
CREATE INDEX ON gl_journal (tenant_id, posting_date);

CREATE TABLE gl_line (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  journal_id  uuid NOT NULL REFERENCES gl_journal(id),
  account_id  uuid NOT NULL REFERENCES gl_account(id),
  amount      numeric(18,2) NOT NULL,                       -- debit +, credit -
  -- A line moves money, or (on a stock account) a quantity -- an empty gas
  -- cylinder has no cost but must still be counted.
  CONSTRAINT line_moves_something CHECK (amount <> 0 OR COALESCE(qty, 0) <> 0),
  qty         numeric(16,3),                                -- litres or items, on stock accounts
  site_id     uuid REFERENCES site(id),
  customer_id uuid REFERENCES credit_customer(id),
  supplier_id uuid REFERENCES supplier(id),
  staff_id    uuid REFERENCES staff(id),
  tank_id     uuid REFERENCES tank(id),
  item_id     uuid REFERENCES dry_item(id),
  channel_id  uuid REFERENCES payment_channel(id),
  product_id  uuid REFERENCES product(id),
  memo        text
);
CREATE INDEX ON gl_line (journal_id);
CREATE INDEX ON gl_line (account_id, tank_id);
CREATE INDEX ON gl_line (account_id, customer_id);
CREATE INDEX ON gl_line (account_id, item_id, site_id);

-- ---------------------------------------------------------------------------
-- Never edited, never deleted. Every journal balances (checked at commit,
-- once all its lines are in).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_gl_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IS_FIXED: the books are never edited or deleted. Reverse the journal and post it again.'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER gl_journal_fixed BEFORE UPDATE OR DELETE ON gl_journal FOR EACH ROW EXECUTE FUNCTION trg_gl_immutable();
CREATE TRIGGER gl_line_fixed    BEFORE UPDATE OR DELETE ON gl_line    FOR EACH ROW EXECUTE FUNCTION trg_gl_immutable();

CREATE OR REPLACE FUNCTION trg_gl_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v numeric; n int;
BEGIN
  -- Money lines only: a quantity moved at no value (an empty cylinder) is a
  -- line with nothing to balance.
  SELECT COALESCE(SUM(amount), 0), count(*) FILTER (WHERE amount <> 0) INTO v, n
    FROM gl_line WHERE journal_id = NEW.journal_id;
  IF v <> 0 THEN
    RAISE EXCEPTION 'JOURNAL_UNBALANCED: journal % is out by % (debits must equal credits)', NEW.journal_id, v
      USING ERRCODE = 'check_violation';
  END IF;
  IF n = 1 THEN
    RAISE EXCEPTION 'JOURNAL_ONE_SIDED: journal % has one line', NEW.journal_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gl_line_balanced AFTER INSERT ON gl_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_gl_balanced();

-- A control account's line must name its party; a stock line carries a quantity.
CREATE OR REPLACE FUNCTION trg_gl_line_tags() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_control text; v_code text;
BEGIN
  SELECT control, code INTO v_control, v_code FROM gl_account WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_ACCOUNT: %', NEW.account_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (v_control = 'CUSTOMER' AND NEW.customer_id IS NULL) OR (v_control = 'SUPPLIER' AND NEW.supplier_id IS NULL)
     OR (v_control = 'STAFF' AND NEW.staff_id IS NULL) OR (v_control = 'TANK' AND (NEW.tank_id IS NULL OR NEW.qty IS NULL))
     OR (v_control = 'ITEM' AND (NEW.item_id IS NULL OR NEW.qty IS NULL)) OR (v_control = 'CHANNEL' AND NEW.channel_id IS NULL)
     OR (v_control = 'SITE' AND NEW.site_id IS NULL) THEN
    RAISE EXCEPTION 'CONTROL_NEEDS_PARTY: account % keeps a % sub-ledger; the line must name one', v_code, lower(v_control)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gl_line_tags BEFORE INSERT ON gl_line FOR EACH ROW EXECUTE FUNCTION trg_gl_line_tags();

-- ---------------------------------------------------------------------------
-- The chart of accounts. Codes are the company's to extend; these are the
-- ones the postings use, so they are seeded for every company.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_seed_chart(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO gl_account (tenant_id, code, name, type, control)
  SELECT p_tenant, c.code, c.name, c.type::gl_account_type, c.control
    FROM (VALUES
      ('1000', 'Cash on hand (tills and safes)',            'ASSET',     'SITE'),
      ('1010', 'Bank',                                      'ASSET',     NULL),
      ('1020', 'Mobile money -- awaiting withdrawal',       'ASSET',     'CHANNEL'),
      ('1030', 'Card settlements due',                      'ASSET',     'CHANNEL'),
      ('1040', 'Fuel vouchers due',                         'ASSET',     'CHANNEL'),
      ('1100', 'Trade receivables -- credit customers',     'ASSET',     'CUSTOMER'),
      ('1110', 'Staff shortages recoverable',               'ASSET',     'STAFF'),
      ('1190', 'Other receivables',                         'ASSET',     NULL),
      ('1200', 'Fuel stock',                                'ASSET',     'TANK'),
      ('1210', 'Shop stock',                                'ASSET',     'ITEM'),
      ('2000', 'Trade payables -- suppliers',               'LIABILITY', 'SUPPLIER'),
      ('2010', 'Goods received, not yet invoiced',          'LIABILITY', NULL),
      ('2050', 'Contra settlements',                        'LIABILITY', NULL),
      ('2200', 'Inter-site transfers in transit',           'LIABILITY', 'SITE'),
      ('2300', 'Wages payable (deductions)',                'LIABILITY', NULL),
      ('3000', 'Owner''s equity and opening balances',      'EQUITY',    NULL),
      ('3100', 'Retained earnings',                         'EQUITY',    NULL),
      ('4000', 'Fuel sales',                                'INCOME',    NULL),
      ('4010', 'Shop sales',                                'INCOME',    NULL),
      ('4020', 'Other income',                              'INCOME',    NULL),
      ('4090', 'Discounts and agreed-price allowances',     'INCOME',    NULL),
      ('4100', 'Cash overages',                             'INCOME',    NULL),
      ('5000', 'Cost of fuel sold',                         'EXPENSE',   NULL),
      ('5010', 'Cost of shop goods sold',                   'EXPENSE',   NULL),
      ('5100', 'Fuel stock gains and losses',               'EXPENSE',   NULL),
      ('5110', 'Fuel transit gains and losses',             'EXPENSE',   NULL),
      ('5120', 'Shop stock losses and adjustments',         'EXPENSE',   NULL),
      ('6000', 'Wages',                                     'EXPENSE',   NULL),
      ('6010', 'Power',                                     'EXPENSE',   NULL),
      ('6020', 'Water',                                     'EXPENSE',   NULL),
      ('6030', 'Security',                                  'EXPENSE',   NULL),
      ('6040', 'Repairs',                                   'EXPENSE',   NULL),
      ('6050', 'Maintenance',                               'EXPENSE',   NULL),
      ('6060', 'Transport',                                 'EXPENSE',   NULL),
      ('6070', 'Licences',                                  'EXPENSE',   NULL),
      ('6080', 'Rent',                                      'EXPENSE',   NULL),
      ('6090', 'Consumables',                               'EXPENSE',   NULL),
      ('6100', 'Bank charges',                              'EXPENSE',   NULL),
      ('6190', 'Other expenses',                            'EXPENSE',   NULL),
      ('6200', 'Fuel used by the business',                 'EXPENSE',   NULL),
      ('6900', 'Staff shortages written off',               'EXPENSE',   NULL)
    ) AS c(code, name, type, control)
  ON CONFLICT (tenant_id, code) DO NOTHING
$$;

SELECT fn_gl_seed_chart(id) FROM tenant;

CREATE OR REPLACE FUNCTION trg_tenant_chart() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_gl_seed_chart(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_chart AFTER INSERT ON tenant FOR EACH ROW EXECUTE FUNCTION trg_tenant_chart();

-- ---------------------------------------------------------------------------
-- The one way in. Lines: [{code, amount, qty?, site_id?, customer_id?, ...}].
-- Idempotent: an event already posted returns its journal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_post(p_tenant uuid, p_site uuid, p_source text, p_source_id text,
                                      p_event_at timestamptz, p_memo text, p_lines jsonb,
                                      p_posted_by uuid DEFAULT NULL, p_reverses uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_date date; v_tz text; v_l jsonb; v_acct uuid; v_amt numeric;
BEGIN
  IF p_source <> 'manual' AND p_reverses IS NULL THEN
    SELECT id INTO v_id FROM gl_journal
     WHERE tenant_id = p_tenant AND source = p_source AND source_id = p_source_id AND reverses_id IS NULL;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  -- Nothing to post (every line zero) is not a journal.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
                  WHERE round((l->>'amount')::numeric, 2) <> 0 OR COALESCE((l->>'qty')::numeric, 0) <> 0) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(s.timezone, t.default_tz) INTO v_tz
    FROM tenant t LEFT JOIN site s ON s.id = p_site WHERE t.id = p_tenant;
  v_date := (p_event_at AT TIME ZONE COALESCE(v_tz, 'Africa/Kampala'))::date;
  -- A closed month takes nothing more: the first open month after it does.
  WHILE EXISTS (SELECT 1 FROM gl_period WHERE tenant_id = p_tenant AND closed_at IS NOT NULL
                   AND period_start = date_trunc('month', v_date)::date) LOOP
    v_date := (date_trunc('month', v_date) + interval '1 month')::date;
  END LOOP;

  INSERT INTO gl_journal (tenant_id, site_id, posting_date, event_at, source, source_id, memo, reverses_id, posted_by)
  VALUES (p_tenant, p_site, v_date, p_event_at, p_source, p_source_id, p_memo, p_reverses, p_posted_by)
  RETURNING id INTO v_id;

  FOR v_l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_amt := round((v_l->>'amount')::numeric, 2);
    CONTINUE WHEN v_amt = 0 AND COALESCE((v_l->>'qty')::numeric, 0) = 0;
    SELECT id INTO v_acct FROM gl_account WHERE tenant_id = p_tenant AND code = v_l->>'code';
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'UNKNOWN_ACCOUNT: no account % in this company''s chart', v_l->>'code'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    INSERT INTO gl_line (tenant_id, journal_id, account_id, amount, qty, site_id, customer_id, supplier_id,
                         staff_id, tank_id, item_id, channel_id, product_id, memo)
    VALUES (p_tenant, v_id, v_acct, v_amt, (v_l->>'qty')::numeric,
            COALESCE((v_l->>'site_id')::uuid, p_site), (v_l->>'customer_id')::uuid, (v_l->>'supplier_id')::uuid,
            (v_l->>'staff_id')::uuid, (v_l->>'tank_id')::uuid, (v_l->>'item_id')::uuid,
            (v_l->>'channel_id')::uuid, (v_l->>'product_id')::uuid, v_l->>'memo');
  END LOOP;
  RETURN v_id;
END $$;

-- A journal undone: every line negated, same accounts and parties.
CREATE OR REPLACE FUNCTION fn_gl_reverse(p_journal uuid, p_reason text, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v gl_journal%ROWTYPE;
BEGIN
  SELECT * INTO v FROM gl_journal WHERE id = p_journal;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_JOURNAL: %', p_journal USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM gl_journal WHERE reverses_id = p_journal) THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: journal % is reversed already', p_journal USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: say why the journal is reversed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN fn_gl_post(v.tenant_id, v.site_id, v.source, v.source_id, now(), 'Reversal: ' || trim(p_reason) || ' -- ' || v.memo,
    (SELECT jsonb_agg(jsonb_build_object('code', a.code, 'amount', -l.amount, 'qty', -l.qty, 'site_id', l.site_id,
              'customer_id', l.customer_id, 'supplier_id', l.supplier_id, 'staff_id', l.staff_id, 'tank_id', l.tank_id,
              'item_id', l.item_id, 'channel_id', l.channel_id, 'product_id', l.product_id, 'memo', l.memo))
       FROM gl_line l JOIN gl_account a ON a.id = l.account_id WHERE l.journal_id = p_journal),
    p_actor, p_journal);
END $$;

-- ---------------------------------------------------------------------------
-- Moving average cost, from the ledger. When the tank is empty or negative in
-- the books, the last purchase cost stands in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_tank_avg(p_tank uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN SUM(l.qty) > 0.5 THEN SUM(l.amount) / SUM(l.qty) END
       FROM gl_line l JOIN gl_account a ON a.id = l.account_id
      WHERE a.code = '1200' AND l.tank_id = p_tank),
    fn_weighted_avg_cost(p_tank), 0)
$$;
CREATE OR REPLACE FUNCTION fn_gl_tank_qty(p_tank uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(l.qty), 0) FROM gl_line l JOIN gl_account a ON a.id = l.account_id
   WHERE a.code = '1200' AND l.tank_id = p_tank
$$;
CREATE OR REPLACE FUNCTION fn_gl_item_avg(p_item uuid, p_site uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN SUM(l.qty) > 0 THEN SUM(l.amount) / SUM(l.qty) END
       FROM gl_line l JOIN gl_account a ON a.id = l.account_id
      WHERE a.code = '1210' AND l.item_id = p_item AND l.site_id = p_site),
    fn_dry_avg_cost(p_item, p_site), 0)
$$;

-- ---------------------------------------------------------------------------
-- A SHIFT, when it is declared:
--   money   every line of its cash-ups, by how it was settled
--   fuel    litres out of each tank at average cost, to cost of sales (sold)
--           or fuel used by the business (own use); then the tank brought to
--           its closing dip -- the gain or loss
--   shop    goods sold at average cost
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_post_shift(p_shift uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  s shift%ROWTYPE; v_lines jsonb := '[]'; r record; v_avg numeric; v_val numeric; v_sold numeric;
  v_own numeric; v_net numeric; v_dip numeric; v_var numeric;
BEGIN
  SELECT * INTO s FROM shift WHERE id = p_shift;

  -- Money: -amount of each money line, so sales credit and settlements debit.
  FOR r IN
    SELECT mm.*, COALESCE(cs.customer_id, NULL) AS customer_id, pc.id AS channel
      FROM money_movement mm
      LEFT JOIN credit_sale cs ON cs.id = mm.credit_sale_id
      LEFT JOIN payment_channel pc ON pc.id = mm.channel_id
     WHERE mm.shift_id = p_shift
  LOOP
    v_lines := v_lines || jsonb_build_object(
      'code', CASE
        WHEN r.entry = 'SALE' AND r.dry_sale_id IS NOT NULL THEN '4010'
        WHEN r.entry = 'SALE' THEN '4000'
        WHEN r.settlement = 'CASH' THEN '1000'
        WHEN r.settlement = 'MOBILE_MONEY' THEN '1020'
        WHEN r.settlement = 'CARD' THEN '1030'
        WHEN r.settlement = 'VOUCHER' THEN '1040'
        WHEN r.settlement = 'CREDIT' THEN '1100'
        WHEN r.settlement IN ('DISCOUNT', 'PRICE_AGREEMENT') THEN '4090'
        WHEN r.settlement = 'SHORTAGE' THEN '1110'
        WHEN r.settlement = 'OVERAGE' THEN '4100'
      END,
      'amount', -r.amount, 'customer_id', r.customer_id, 'channel_id', r.channel,
      'staff_id', CASE WHEN r.settlement = 'SHORTAGE' THEN r.staff_id END,
      'memo', COALESCE(r.reference, r.entry || COALESCE(' ' || r.settlement::text, '')));
  END LOOP;

  -- Fuel, tank by tank.
  FOR r IN SELECT t.id, t.product_id FROM tank t WHERE t.site_id = s.site_id LOOP
    -- Out of the tank this shift: metered, less what went back (tests, returns).
    SELECT -COALESCE(SUM(signed_litres), 0) INTO v_net FROM fuel_movement
     WHERE shift_id = p_shift AND tank_id = r.id AND kind IN ('METER_OUT', 'TEST_RETURN_IN', 'RTT_IN');
    SELECT COALESCE(SUM(md.litres) FILTER (WHERE md.kind = 'SALE'), 0),
           COALESCE(SUM(md.litres) FILTER (WHERE md.kind = 'OWN_USE'), 0)
      INTO v_sold, v_own
      FROM metered_disposition md JOIN meter_event me ON me.id = md.meter_event_id
     WHERE me.shift_id = p_shift AND me.tank_id = r.id;
    v_avg := fn_gl_tank_avg(r.id);
    IF v_net <> 0 THEN
      v_lines := v_lines
        || jsonb_build_object('code', '1200', 'amount', -round(v_net * v_avg, 2), 'qty', -v_net,
                              'tank_id', r.id, 'product_id', r.product_id, 'memo', 'Fuel out of the tank')
        || jsonb_build_object('code', '5000', 'amount', round(v_sold * v_avg, 2), 'product_id', r.product_id,
                              'memo', round(v_sold, 3) || ' L sold')
        || jsonb_build_object('code', '6200', 'amount', round(v_own * v_avg, 2), 'product_id', r.product_id,
                              'memo', round(v_own, 3) || ' L used by the business')
        -- Rounding, and any litres neither sold nor own use, stay in stock losses.
        || jsonb_build_object('code', '5100', 'amount',
              round(v_net * v_avg, 2) - round(v_sold * v_avg, 2) - round(v_own * v_avg, 2),
              'product_id', r.product_id, 'memo', 'Out of the tank, neither sold nor own use');
    END IF;
    -- The tank brought to its closing dip.
    SELECT product_litres INTO v_dip FROM dip_reading
     WHERE shift_id = p_shift AND tank_id = r.id AND context = 'SHIFT_CLOSE' ORDER BY id DESC LIMIT 1;
    IF v_dip IS NOT NULL THEN
      v_var := round(v_dip - (fn_gl_tank_qty(r.id) - v_net), 3);
      IF v_var <> 0 THEN
        v_val := round(v_var * v_avg, 2);
        v_lines := v_lines
          || jsonb_build_object('code', '1200', 'amount', v_val, 'qty', v_var, 'tank_id', r.id,
                                'product_id', r.product_id, 'memo', 'To the closing dip: ' || v_var || ' L')
          || jsonb_build_object('code', '5100', 'amount', -v_val, 'product_id', r.product_id,
                                'memo', CASE WHEN v_var > 0 THEN 'Stock gain ' ELSE 'Stock loss ' END || abs(v_var) || ' L');
      END IF;
    END IF;
  END LOOP;

  -- Shop goods sold, at average cost.
  FOR r IN SELECT dm.item_id, SUM(-dm.signed_qty) AS qty FROM dry_movement dm
            WHERE dm.shift_id = p_shift AND dm.kind = 'SALE_OUT' GROUP BY dm.item_id LOOP
    v_val := round(r.qty * fn_gl_item_avg(r.item_id, s.site_id), 2);
    v_lines := v_lines
      || jsonb_build_object('code', '1210', 'amount', -v_val, 'qty', -r.qty, 'item_id', r.item_id)
      || jsonb_build_object('code', '5010', 'amount', v_val, 'memo', 'Shop goods sold');
  END LOOP;

  RETURN fn_gl_post(s.tenant_id, s.site_id, 'shift', p_shift::text, COALESCE(s.closed_at, now()),
                    s.label || ' shift ' || s.business_date || ': sales, settlements, cost of sales, stock', v_lines);
END $$;

-- ---------------------------------------------------------------------------
-- FUEL MOVEMENTS outside a shift: opening stock, deliveries, transfers, depot
-- sales, water drawn, stock-take adjustments, corrections.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_post_fuel_movement(p_id bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE m fuel_movement%ROWTYPE; dl delivery_line%ROWTYPE; d delivery%ROWTYPE; st stock_transfer%ROWTYPE;
        v_avg numeric; v_val numeric; v_lines jsonb; v_memo text;
BEGIN
  SELECT * INTO m FROM fuel_movement WHERE id = p_id;
  -- In-shift litres post with their shift.
  IF m.kind IN ('METER_OUT', 'TEST_RETURN_IN', 'RTT_IN') THEN RETURN NULL; END IF;

  IF m.kind = 'OPENING_BALANCE' THEN
    v_val := round(m.litres * COALESCE(m.unit_cost, 0), 2);
    v_lines := jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount', v_val, 'qty', m.signed_litres, 'tank_id', m.tank_id, 'product_id', m.product_id),
      jsonb_build_object('code', '3000', 'amount', -v_val, 'memo', 'Opening fuel stock'));
    v_memo := 'Opening fuel stock, ' || m.litres || ' L';

  ELSIF m.kind = 'DELIVERY_IN' THEN
    SELECT * INTO dl FROM delivery_line WHERE id = m.delivery_line_id;
    SELECT * INTO d FROM delivery WHERE id = dl.delivery_id;
    -- In at what arrived; owed for what was loaded; the difference is transit.
    v_lines := jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount', round(m.litres * m.unit_cost, 2), 'qty', m.signed_litres,
                         'tank_id', m.tank_id, 'product_id', m.product_id),
      jsonb_build_object('code', '2010', 'amount', -round(COALESCE(dl.loaded_litres, m.litres) * m.unit_cost, 2),
                         'supplier_id', d.supplier_id, 'memo', 'Delivery ' || d.delivery_note_no),
      jsonb_build_object('code', '5110', 'amount',
                         round(COALESCE(dl.loaded_litres, m.litres) * m.unit_cost, 2) - round(m.litres * m.unit_cost, 2),
                         'product_id', m.product_id,
                         'memo', 'Loaded ' || COALESCE(dl.loaded_litres, m.litres) || ' L, received ' || m.litres || ' L'));
    v_memo := 'Delivery ' || d.delivery_note_no || ' received';

  ELSIF m.stock_transfer_id IS NOT NULL THEN
    SELECT * INTO st FROM stock_transfer WHERE id = m.stock_transfer_id;
    v_val := round(m.litres * COALESCE(st.unit_cost, fn_gl_tank_avg(m.tank_id)), 2) * sign(m.signed_litres);
    -- Each site's books balance: the sending site holds a claim in transit,
    -- the receiving site owes it; across the company 2200 nets to zero.
    v_lines := jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount', v_val, 'qty', m.signed_litres, 'tank_id', m.tank_id, 'product_id', m.product_id),
      jsonb_build_object('code', '2200', 'amount', -v_val, 'site_id', m.site_id, 'memo', 'Transfer ' || COALESCE(st.reference, '')));
    v_memo := 'Transfer ' || COALESCE(st.reference, '') || CASE WHEN m.signed_litres > 0 THEN ' in' ELSE ' out' END;

  ELSIF m.bulk_sale_id IS NOT NULL THEN
    v_avg := fn_gl_tank_avg(m.tank_id);
    v_val := round(m.litres * v_avg, 2);
    v_lines := jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount', -v_val, 'qty', m.signed_litres, 'tank_id', m.tank_id, 'product_id', m.product_id),
      jsonb_build_object('code', '5000', 'amount', v_val, 'product_id', m.product_id, 'memo', 'Depot bulk sale'));
    v_memo := 'Depot bulk sale: cost of sales';

  ELSE
    -- Water drawn, stock-take adjustments, corrections, own-use draws: at
    -- average cost, to stock gains and losses (own use to its own account).
    v_avg := fn_gl_tank_avg(m.tank_id);
    v_val := round(m.signed_litres * v_avg, 2);
    v_lines := jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount', v_val, 'qty', m.signed_litres, 'tank_id', m.tank_id, 'product_id', m.product_id),
      jsonb_build_object('code', CASE WHEN m.bulk_draw_id IS NOT NULL THEN '6200' ELSE '5100' END,
                         'amount', -v_val, 'product_id', m.product_id, 'memo', m.kind::text));
    v_memo := initcap(replace(m.kind::text, '_', ' '));
  END IF;
  RETURN fn_gl_post(m.tenant_id, m.site_id, 'fuel_movement', p_id::text, m.occurred_at, v_memo, v_lines);
END $$;

-- ---------------------------------------------------------------------------
-- SHOP STOCK outside a sale: purchases, opening, counts, damage, transfers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_post_dry_movement(p_id bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE m dry_movement%ROWTYPE; v_val numeric; v_other text;
BEGIN
  SELECT * INTO m FROM dry_movement WHERE id = p_id;
  IF m.kind = 'SALE_OUT' THEN RETURN NULL; END IF;   -- with its shift
  IF m.kind IN ('PURCHASE_IN', 'OPENING_BALANCE') THEN
    v_val := round(m.qty * COALESCE(m.unit_cost, 0), 2);
    v_other := CASE m.kind WHEN 'PURCHASE_IN' THEN '2010' ELSE '3000' END;
  ELSE
    v_val := round(m.signed_qty * fn_gl_item_avg(m.item_id, m.site_id), 2);
    v_other := CASE WHEN m.kind IN ('EXCHANGE_IN', 'CUSTOMER_RETURN_IN') THEN '5010'
                    WHEN m.kind IN ('TRANSFER_IN', 'TRANSFER_OUT') THEN '2200' ELSE '5120' END;
  END IF;
  RETURN fn_gl_post(m.tenant_id, m.site_id, 'dry_movement', p_id::text, m.occurred_at,
    'Shop stock: ' || lower(replace(m.kind::text, '_', ' ')),
    jsonb_build_array(
      jsonb_build_object('code', '1210', 'amount', v_val, 'qty', m.signed_qty, 'item_id', m.item_id),
      jsonb_build_object('code', v_other, 'amount', -v_val, 'site_id', m.site_id, 'memo', COALESCE(m.note, m.kind::text))));
END $$;

-- ---------------------------------------------------------------------------
-- MONEY OUTSIDE A SHIFT.
-- ---------------------------------------------------------------------------
-- Where money is held, by method.
CREATE OR REPLACE FUNCTION fn_gl_money_account(p_method text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_method WHEN 'CASH' THEN '1000' WHEN 'TILL_CASH' THEN '1000' WHEN 'MOBILE_MONEY' THEN '1010'
                       WHEN 'CONTRA' THEN '2050' ELSE '1010' END
$$;

CREATE OR REPLACE FUNCTION fn_gl_post_banking(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b banking%ROWTYPE;
BEGIN
  SELECT * INTO b FROM banking WHERE id = p_id;
  RETURN fn_gl_post(b.tenant_id, b.site_id, 'banking', p_id::text, b.banked_at,
    'Banked ' || b.bank_name || ' slip ' || b.slip_no,
    jsonb_build_array(
      jsonb_build_object('code', '1010', 'amount', b.amount, 'memo', b.bank_name || ' ' || COALESCE(b.account_ref, '') || ' ' || b.slip_no),
      jsonb_build_object('code', '1000', 'amount', -b.amount, 'memo', 'Takings of ' || b.business_date)));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_credit_payment(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p credit_payment%ROWTYPE; v_site uuid; v_name text;
BEGIN
  SELECT * INTO p FROM credit_payment WHERE id = p_id;
  SELECT site_id, name INTO v_site, v_name FROM credit_customer WHERE id = p.customer_id;
  RETURN fn_gl_post(p.tenant_id, v_site, 'credit_payment', p_id::text, p.received_at,
    'Payment from ' || v_name || COALESCE(' ' || p.reference, ''),
    jsonb_build_array(
      jsonb_build_object('code', fn_gl_money_account(p.method), 'amount', p.amount, 'memo', p.method || ' ' || COALESCE(p.reference, '')),
      jsonb_build_object('code', '1100', 'amount', -p.amount, 'customer_id', p.customer_id)));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_expense(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e expense%ROWTYPE; v_code text;
BEGIN
  SELECT * INTO e FROM expense WHERE id = p_id;
  v_code := CASE e.category::text WHEN 'WAGES' THEN '6000' WHEN 'POWER' THEN '6010' WHEN 'WATER' THEN '6020'
              WHEN 'SECURITY' THEN '6030' WHEN 'REPAIRS' THEN '6040' WHEN 'MAINTENANCE' THEN '6050'
              WHEN 'TRANSPORT' THEN '6060' WHEN 'LICENCES' THEN '6070' WHEN 'RENT' THEN '6080'
              WHEN 'CONSUMABLES' THEN '6090' WHEN 'BANK_CHARGES' THEN '6100' ELSE '6190' END;
  RETURN fn_gl_post(e.tenant_id, e.site_id, 'expense', p_id::text, e.recorded_at,
    initcap(e.category::text) || ': ' || e.description,
    jsonb_build_array(
      jsonb_build_object('code', v_code, 'amount', e.amount, 'memo', e.description),
      CASE WHEN e.paid_from = 'CREDIT' AND e.supplier_id IS NOT NULL
           THEN jsonb_build_object('code', '2000', 'amount', -e.amount, 'supplier_id', e.supplier_id)
           WHEN e.paid_from = 'CREDIT'
           THEN jsonb_build_object('code', '2010', 'amount', -e.amount, 'memo', 'On credit, no supplier named')
           ELSE jsonb_build_object('code', fn_gl_money_account(e.paid_from), 'amount', -e.amount, 'memo', e.paid_from) END));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_other_income(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE o other_income%ROWTYPE;
BEGIN
  SELECT * INTO o FROM other_income WHERE id = p_id;
  RETURN fn_gl_post(o.tenant_id, o.site_id, 'other_income', p_id::text, o.recorded_at, 'Other income: ' || o.description,
    jsonb_build_array(
      jsonb_build_object('code', CASE o.settlement WHEN 'CASH' THEN '1000' WHEN 'MOBILE_MONEY' THEN '1010'
                                   WHEN 'CARD' THEN '1010' ELSE '1190' END, 'amount', o.amount),
      jsonb_build_object('code', '4020', 'amount', -o.amount, 'memo', o.description)));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_shortage_recovery(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r shortage_recovery%ROWTYPE; v_site uuid;
BEGIN
  SELECT * INTO r FROM shortage_recovery WHERE id = p_id;
  SELECT site_id INTO v_site FROM staff WHERE id = r.staff_id;
  RETURN fn_gl_post(r.tenant_id, v_site, 'shortage_recovery', p_id::text, r.recovered_at,
    'Shortage recovered: ' || lower(replace(r.method, '_', ' ')),
    jsonb_build_array(
      jsonb_build_object('code', CASE r.method WHEN 'CASH' THEN '1000' WHEN 'SALARY_DEDUCTION' THEN '2300'
                                   WHEN 'WRITE_OFF' THEN '6900' ELSE '4100' END, 'amount', r.amount),
      jsonb_build_object('code', '1110', 'amount', -r.amount, 'staff_id', r.staff_id)));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_supplier_invoice(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE i supplier_invoice%ROWTYPE;
BEGIN
  SELECT * INTO i FROM supplier_invoice WHERE id = p_id;
  -- The invoice turns "received, not invoiced" into what the supplier is owed.
  RETURN fn_gl_post(i.tenant_id, i.site_id, 'supplier_invoice', p_id::text, i.recorded_at,
    'Supplier invoice ' || i.invoice_no,
    jsonb_build_array(
      jsonb_build_object('code', '2010', 'amount', i.amount, 'supplier_id', i.supplier_id, 'memo', 'Invoice ' || i.invoice_no),
      jsonb_build_object('code', '2000', 'amount', -i.amount, 'supplier_id', i.supplier_id, 'memo', 'Invoice ' || i.invoice_no)));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_supplier_payment(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p supplier_payment%ROWTYPE;
BEGIN
  SELECT * INTO p FROM supplier_payment WHERE id = p_id;
  RETURN fn_gl_post(p.tenant_id, p.site_id, 'supplier_payment', p_id::text, p.recorded_at,
    'Paid supplier ' || COALESCE(p.reference, ''),
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'amount', p.amount, 'supplier_id', p.supplier_id),
      jsonb_build_object('code', fn_gl_money_account(p.method), 'amount', -p.amount, 'memo', p.method || ' ' || COALESCE(p.reference, ''))));
END $$;

CREATE OR REPLACE FUNCTION fn_gl_post_bulk_sale(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b bulk_sale%ROWTYPE;
BEGIN
  SELECT * INTO b FROM bulk_sale WHERE id = p_id;
  RETURN fn_gl_post(b.tenant_id, b.site_id, 'bulk_sale', p_id::text, b.loaded_at,
    'Depot bulk sale ' || COALESCE(b.invoice_no, ''),
    jsonb_build_array(
      CASE WHEN b.payment_terms = 'CREDIT'
           THEN jsonb_build_object('code', '1100', 'amount', b.amount, 'customer_id', b.customer_id)
           ELSE jsonb_build_object('code', '1000', 'amount', b.amount) END,
      jsonb_build_object('code', '4000', 'amount', -b.amount, 'product_id', b.product_id,
                         'memo', b.litres || ' L at ' || b.unit_price)));
END $$;

-- ---------------------------------------------------------------------------
-- The triggers that post as things happen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_gl_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF    TG_TABLE_NAME = 'fuel_movement'     THEN PERFORM fn_gl_post_fuel_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'dry_movement'      THEN PERFORM fn_gl_post_dry_movement(NEW.id);
  ELSIF TG_TABLE_NAME = 'banking'           THEN PERFORM fn_gl_post_banking(NEW.id);
  ELSIF TG_TABLE_NAME = 'credit_payment'    THEN PERFORM fn_gl_post_credit_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'expense'           THEN PERFORM fn_gl_post_expense(NEW.id);
  ELSIF TG_TABLE_NAME = 'other_income'      THEN PERFORM fn_gl_post_other_income(NEW.id);
  ELSIF TG_TABLE_NAME = 'shortage_recovery' THEN PERFORM fn_gl_post_shortage_recovery(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_invoice'  THEN PERFORM fn_gl_post_supplier_invoice(NEW.id);
  ELSIF TG_TABLE_NAME = 'supplier_payment'  THEN PERFORM fn_gl_post_supplier_payment(NEW.id);
  ELSIF TG_TABLE_NAME = 'bulk_sale'         THEN PERFORM fn_gl_post_bulk_sale(NEW.id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER gl_post AFTER INSERT ON fuel_movement     FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON dry_movement      FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON banking           FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON credit_payment    FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON expense           FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON other_income      FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON shortage_recovery FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON supplier_invoice  FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON supplier_payment  FOR EACH ROW EXECUTE FUNCTION trg_gl_post();
CREATE TRIGGER gl_post AFTER INSERT ON bulk_sale         FOR EACH ROW EXECUTE FUNCTION trg_gl_post();

CREATE OR REPLACE FUNCTION trg_gl_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_j uuid;
BEGIN
  IF NEW.state = 'DECLARED' AND OLD.state IS DISTINCT FROM 'DECLARED' THEN
    PERFORM fn_gl_post_shift(NEW.id);
  ELSIF NEW.state = 'VOID' AND OLD.state IN ('DECLARED', 'APPROVED', 'POSTED') THEN
    SELECT id INTO v_j FROM gl_journal WHERE source = 'shift' AND source_id = NEW.id::text AND reverses_id IS NULL;
    IF v_j IS NOT NULL THEN PERFORM fn_gl_reverse(v_j, 'shift voided', NULL); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER gl_shift AFTER UPDATE OF state ON shift FOR EACH ROW EXECUTE FUNCTION trg_gl_shift();

-- ---------------------------------------------------------------------------
-- A manual journal: opening balances, accruals, corrections. Balanced like
-- every other, by an accountant, manager or head office, with a reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_manual_journal(p_site uuid, p_date date, p_memo text, p_lines jsonb, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_role staff_role; v_tenant uuid;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM staff WHERE id = p_actor AND is_active;
  IF v_role IS NULL OR v_role NOT IN ('ACCOUNTANT', 'MANAGER', 'HEAD_OFFICE', 'DIRECTOR') THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: a manual journal is posted by an accountant, manager or head office'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_memo IS NULL OR length(trim(p_memo)) < 5 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: say what the journal is for' USING ERRCODE = 'check_violation';
  END IF;
  RETURN fn_gl_post(v_tenant, p_site, 'manual', gen_random_uuid()::text,
                    (p_date + time '12:00') AT TIME ZONE 'Africa/Kampala', trim(p_memo), p_lines, p_actor);
END $$;

-- ---------------------------------------------------------------------------
-- Who may write: only the posting functions, as fcms_ledger. The app reads.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcms_ledger') THEN
    CREATE ROLE fcms_ledger NOLOGIN BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO fcms_ledger;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fcms_ledger;
GRANT INSERT ON gl_journal, gl_line, gl_account TO fcms_ledger;
GRANT USAGE ON SEQUENCE gl_line_id_seq TO fcms_ledger;
REVOKE INSERT, UPDATE, DELETE ON gl_journal, gl_line FROM fcms_app;
GRANT SELECT ON gl_account, gl_period, gl_journal, gl_line TO fcms_app;
GRANT INSERT ON gl_account TO fcms_app;            -- a company extends its chart
GRANT INSERT, UPDATE ON gl_period TO fcms_app;     -- closing a month (checked by fn_gl_close_period)

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid)', 'fn_gl_reverse(uuid,text,uuid)',
    'fn_gl_post_shift(uuid)', 'fn_gl_post_fuel_movement(bigint)', 'fn_gl_post_dry_movement(bigint)',
    'fn_gl_post_banking(uuid)', 'fn_gl_post_credit_payment(uuid)', 'fn_gl_post_expense(uuid)',
    'fn_gl_post_other_income(uuid)', 'fn_gl_post_shortage_recovery(uuid)', 'fn_gl_post_supplier_invoice(uuid)',
    'fn_gl_post_supplier_payment(uuid)', 'fn_gl_post_bulk_sale(uuid)', 'fn_gl_manual_journal(uuid,date,text,jsonb,uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO fcms_ledger', f);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f);
  END LOOP;
END $$;
-- Only the posters call fn_gl_post; the app calls the manual journal and reversal.
REVOKE EXECUTE ON FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_gl_post(uuid,uuid,text,text,timestamptz,text,jsonb,uuid,uuid) TO fcms_ledger;

-- ---------------------------------------------------------------------------
-- History: everything that happened before the books existed, posted in the
-- order it happened, so average costs come out as they would have.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_gl_backfill() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r record; n bigint := 0;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT occurred_at AS at, 1 AS ord, 'fuel' AS k, id::text AS id FROM fuel_movement
       WHERE kind NOT IN ('METER_OUT', 'TEST_RETURN_IN', 'RTT_IN')
      UNION ALL SELECT occurred_at, 1, 'dry', id::text FROM dry_movement WHERE kind <> 'SALE_OUT'
      UNION ALL SELECT closed_at, 2, 'shift', id::text FROM shift WHERE state IN ('DECLARED', 'APPROVED', 'POSTED')
      UNION ALL SELECT banked_at, 3, 'banking', id::text FROM banking
      UNION ALL SELECT received_at, 3, 'payment', id::text FROM credit_payment
      UNION ALL SELECT recorded_at, 3, 'expense', id::text FROM expense
      UNION ALL SELECT recorded_at, 3, 'income', id::text FROM other_income
      UNION ALL SELECT recovered_at, 3, 'recovery', id::text FROM shortage_recovery
      UNION ALL SELECT recorded_at, 3, 'sinv', id::text FROM supplier_invoice
      UNION ALL SELECT recorded_at, 3, 'spay', id::text FROM supplier_payment
      UNION ALL SELECT loaded_at, 1, 'bulk', id::text FROM bulk_sale
    ) x ORDER BY at, ord
  LOOP
    CASE r.k
      WHEN 'fuel' THEN PERFORM fn_gl_post_fuel_movement(r.id::bigint);
      WHEN 'dry' THEN PERFORM fn_gl_post_dry_movement(r.id::bigint);
      WHEN 'shift' THEN PERFORM fn_gl_post_shift(r.id::uuid);
      WHEN 'banking' THEN PERFORM fn_gl_post_banking(r.id::uuid);
      WHEN 'payment' THEN PERFORM fn_gl_post_credit_payment(r.id::uuid);
      WHEN 'expense' THEN PERFORM fn_gl_post_expense(r.id::uuid);
      WHEN 'income' THEN PERFORM fn_gl_post_other_income(r.id::uuid);
      WHEN 'recovery' THEN PERFORM fn_gl_post_shortage_recovery(r.id::uuid);
      WHEN 'sinv' THEN PERFORM fn_gl_post_supplier_invoice(r.id::uuid);
      WHEN 'spay' THEN PERFORM fn_gl_post_supplier_payment(r.id::uuid);
      WHEN 'bulk' THEN PERFORM fn_gl_post_bulk_sale(r.id::uuid);
    END CASE;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
-- A new company gets its chart whoever creates it (a system administrator
-- works as fcms_platform, which writes no accounts).
ALTER FUNCTION fn_gl_seed_chart(uuid) OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_seed_chart(uuid) SECURITY DEFINER;
ALTER FUNCTION fn_gl_seed_chart(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION fn_gl_backfill() OWNER TO fcms_ledger;
ALTER FUNCTION fn_gl_backfill() SECURITY DEFINER;
SELECT fn_gl_backfill();
