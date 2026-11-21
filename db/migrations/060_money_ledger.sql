-- =============================================================================
-- FCMS v2 -- 060_money_ledger.sql
--
-- "Every transaction should reconcile."
--
-- The v1 cash-up computed `expected_cash`, `short_over` and `unallocated` as
-- stored columns from a formula that was rewritten three times (010 -> 019 ->
-- 025) and was still wrong. Own use was subtracted twice, then not at all;
-- declared shortage was folded into short_over so that declaring a shortage
-- made the sheet read as balanced.
--
-- Here the cash-up is a LEDGER THAT MUST SUM TO ZERO.
--
--   + the value of fuel the attendant dispensed        (they owe this)
--   - cash handed in                                   (settled)
--   - mobile money / card / voucher                    (settled)
--   - credit billed to a named customer account        (settled)
--   - discount granted at the pump                     (settled, authorised)
--   - shortage raised against the attendant            (settled, receivable)
--   + overage handed in beyond sales                   (settled, payable)
--   ------------------------------------------------------
--   = 0, or the shift does not close.
--
-- There is nothing to get wrong in a formula, because there is no formula.
-- An unexplained gap is not a number in a column -- it is a missing row, and
-- the system can say exactly how big it is and refuse to move on.
-- =============================================================================

CREATE TABLE payment_channel (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  code         text NOT NULL,          -- MTN_MOMO, AIRTEL, VISA, TOTAL_CARD, VOUCHER
  name         text NOT NULL,
  kind         settlement_kind NOT NULL,
  till_number  text,
  requires_reference boolean NOT NULL DEFAULT TRUE,
  requires_evidence  boolean NOT NULL DEFAULT FALSE,
  is_active    boolean NOT NULL DEFAULT TRUE,
  UNIQUE (site_id, code),
  -- Cash, credit, discount and shortage are not "channels a supervisor picks
  -- from a dropdown"; each has its own dedicated capture path with its own
  -- authorisation. Only genuine electronic tenders live here.
  CONSTRAINT channel_is_a_tender CHECK (kind IN ('MOBILE_MONEY','CARD','VOUCHER'))
);

-- ---------------------------------------------------------------------------
-- The cash-up header. Deliberately thin: it holds WHO and WHEN and the
-- approval state. It holds no arithmetic, because arithmetic in a column is
-- arithmetic that can be stale.
-- ---------------------------------------------------------------------------
CREATE TABLE cash_up (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  site_id     uuid NOT NULL REFERENCES site(id),
  shift_id    uuid NOT NULL REFERENCES shift(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  currency    char(3) NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','DECLARED','APPROVED','QUERIED')),
  declared_by uuid REFERENCES staff(id),
  declared_at timestamptz,
  approved_by uuid REFERENCES staff(id),
  approved_at timestamptz,
  query_note  text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, staff_id),
  -- Whoever counts it cannot be the one who signs it off.
  CONSTRAINT segregation_of_duty CHECK (approved_by IS NULL OR approved_by <> staff_id),
  CONSTRAINT approval_needs_declaration CHECK (status <> 'APPROVED' OR declared_at IS NOT NULL)
);
CREATE INDEX ON cash_up (shift_id);
CREATE INDEX ON cash_up (staff_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- THE MONEY LEDGER
-- ---------------------------------------------------------------------------
CREATE TABLE money_movement (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  site_id      uuid NOT NULL REFERENCES site(id),
  shift_id     uuid NOT NULL REFERENCES shift(id),
  cash_up_id   uuid NOT NULL REFERENCES cash_up(id) ON DELETE CASCADE,
  staff_id     uuid NOT NULL REFERENCES staff(id),

  -- 'SALE' is the charge; every settlement_kind is a credit against it.
  entry        text NOT NULL CHECK (entry IN ('SALE','SETTLEMENT')),
  settlement   settlement_kind,
  channel_id   uuid REFERENCES payment_channel(id),

  -- Positive = the attendant owes it. Negative = it has been settled.
  amount       numeric(16,2) NOT NULL CHECK (amount <> 0),
  currency     char(3) NOT NULL,

  -- Provenance. A settlement without its document is not a settlement.
  meter_event_id   bigint REFERENCES meter_event(id),
  credit_sale_id   uuid,
  discount_id      uuid,
  shortage_id      uuid,
  reference        text,
  evidence_url     text,

  recorded_by  uuid NOT NULL REFERENCES staff(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sale_is_positive       CHECK (entry <> 'SALE' OR amount > 0),
  CONSTRAINT sale_has_meter_event   CHECK (entry <> 'SALE' OR meter_event_id IS NOT NULL),
  CONSTRAINT sale_has_no_settlement CHECK (entry <> 'SALE' OR settlement IS NULL),
  CONSTRAINT settlement_has_kind    CHECK (entry <> 'SETTLEMENT' OR settlement IS NOT NULL),
  -- An overage is money the station owes the attendant back, so it is the one
  -- settlement that is positive. Everything else reduces what is owed.
  CONSTRAINT settlement_sign CHECK (
    entry <> 'SETTLEMENT'
    OR (settlement = 'OVERAGE' AND amount > 0)
    OR (settlement <> 'OVERAGE' AND amount < 0)
  ),
  CONSTRAINT credit_names_a_sale   CHECK (settlement IS DISTINCT FROM 'CREDIT'   OR credit_sale_id IS NOT NULL),
  CONSTRAINT discount_names_a_grant CHECK (settlement IS DISTINCT FROM 'DISCOUNT' OR discount_id IS NOT NULL),
  CONSTRAINT shortage_names_a_row  CHECK (settlement IS DISTINCT FROM 'SHORTAGE' OR shortage_id IS NOT NULL),
  CONSTRAINT tender_names_a_channel CHECK (
    settlement IS NULL OR settlement NOT IN ('MOBILE_MONEY','CARD','VOUCHER')
    OR channel_id IS NOT NULL
  )
);
CREATE INDEX ON money_movement (cash_up_id);
CREATE INDEX ON money_movement (shift_id);
CREATE INDEX ON money_movement (staff_id, recorded_at DESC);

CREATE RULE money_movement_no_update AS ON UPDATE TO money_movement DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- THE RULE. Checked at commit, so the parts can arrive in any order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_cash_up_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid := COALESCE(NEW.cash_up_id, OLD.cash_up_id);
  v_gap   numeric(16,2);
  v_state text;
  v_who   text;
BEGIN
  SELECT status INTO v_state FROM cash_up WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- A draft is allowed to be mid-entry. The rule bites at DECLARED and beyond,
  -- which is the moment the supervisor says "this is what happened".
  IF v_state = 'DRAFT' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_gap
    FROM money_movement WHERE cash_up_id = v_id;

  IF v_gap <> 0 THEN
    SELECT s.full_name INTO v_who
      FROM cash_up c JOIN staff s ON s.id = c.staff_id WHERE c.id = v_id;
    RAISE EXCEPTION
      'CASH_UP_UNBALANCED: % has % unallocated. Sales must equal cash + mobile '
      'money + card + credit + discounts + a declared shortage. Record the '
      'missing item or raise the shortage -- do not close over it.',
      COALESCE(v_who, v_id::text), v_gap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER cash_up_must_balance
  AFTER INSERT OR UPDATE OR DELETE ON money_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_cash_up_balances();

-- Moving a cash-up to DECLARED re-checks the same rule, so you cannot balance
-- a draft, add nothing, and promote it.
CREATE OR REPLACE FUNCTION trg_cash_up_state_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_gap numeric(16,2);
BEGIN
  IF NEW.status = 'DRAFT' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_gap
    FROM money_movement WHERE cash_up_id = NEW.id;
  IF v_gap <> 0 THEN
    RAISE EXCEPTION 'CASH_UP_UNBALANCED: % unallocated on cash-up %', v_gap, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER cash_up_state_must_balance
  AFTER INSERT OR UPDATE OF status ON cash_up
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_cash_up_state_balances();

-- The readable answer, derived. This is what the close screen shows and what
-- the certificate prints -- one query, no stored copy to disagree with.
CREATE OR REPLACE VIEW v_cash_up_position AS
SELECT
  c.id AS cash_up_id, c.tenant_id, c.site_id, c.shift_id, c.staff_id,
  s.full_name, c.currency, c.status,
  COALESCE(SUM(m.amount) FILTER (WHERE m.entry = 'SALE'), 0)                        AS sales_value,
  -COALESCE(SUM(m.amount) FILTER (WHERE m.settlement = 'CASH'), 0)                  AS cash_declared,
  -COALESCE(SUM(m.amount) FILTER (WHERE m.settlement IN ('MOBILE_MONEY','CARD','VOUCHER')), 0) AS electronic_declared,
  -COALESCE(SUM(m.amount) FILTER (WHERE m.settlement = 'CREDIT'), 0)                AS credit_total,
  -COALESCE(SUM(m.amount) FILTER (WHERE m.settlement = 'DISCOUNT'), 0)              AS discount_total,
  -COALESCE(SUM(m.amount) FILTER (WHERE m.settlement = 'SHORTAGE'), 0)              AS shortage_raised,
  COALESCE(SUM(m.amount) FILTER (WHERE m.settlement = 'OVERAGE'), 0)                AS overage_raised,
  COALESCE(SUM(m.amount), 0)                                                        AS unallocated,
  COALESCE(SUM(m.amount), 0) = 0                                                    AS is_balanced
FROM cash_up c
JOIN staff s ON s.id = c.staff_id
LEFT JOIN money_movement m ON m.cash_up_id = c.id
GROUP BY c.id, c.tenant_id, c.site_id, c.shift_id, c.staff_id, s.full_name,
         c.currency, c.status;

-- ---------------------------------------------------------------------------
-- Credit book. A credit sale is fuel that went through the meter and was
-- billed to an account -- so it settles the attendant and opens a receivable.
--
-- v1 had these tables and an API endpoint, and NO USER INTERFACE ANYWHERE that
-- called it. Every station selling on credit therefore had an attendant short
-- by exactly the credit value, every shift, unable to balance. That is audit
-- finding H1 and it is the single biggest reason the system "does not work".
-- ---------------------------------------------------------------------------
CREATE TABLE credit_customer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid REFERENCES site(id),          -- NULL = valid at any site
  code          text NOT NULL,
  name          text NOT NULL,
  contact_phone text,
  credit_limit  numeric(16,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_terms_days int NOT NULL DEFAULT 30,
  is_active     boolean NOT NULL DEFAULT TRUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE credit_vehicle (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  customer_id uuid NOT NULL REFERENCES credit_customer(id) ON DELETE CASCADE,
  plate_no    text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, plate_no)
);

CREATE TABLE credit_sale (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  shift_id      uuid NOT NULL REFERENCES shift(id),
  customer_id   uuid NOT NULL REFERENCES credit_customer(id),
  vehicle_id    uuid REFERENCES credit_vehicle(id),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  nozzle_id     uuid NOT NULL REFERENCES nozzle(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  litres        numeric(12,3) NOT NULL CHECK (litres > 0),
  unit_price    numeric(12,4) NOT NULL CHECK (unit_price > 0),
  amount        numeric(16,2) NOT NULL CHECK (amount > 0),
  voucher_no    text,
  odometer      int,
  signed_by     text,
  evidence_url  text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_amount_matches CHECK (abs(amount - litres * unit_price) < 1.00)
);
CREATE INDEX ON credit_sale (shift_id, staff_id);
CREATE INDEX ON credit_sale (customer_id, recorded_at DESC);

CREATE TABLE credit_payment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  customer_id uuid NOT NULL REFERENCES credit_customer(id),
  amount      numeric(16,2) NOT NULL CHECK (amount > 0),
  method      text NOT NULL CHECK (method IN ('CASH','BANK','MOBILE_MONEY','CHEQUE','CONTRA')),
  reference   text,
  evidence_url text,
  received_by uuid NOT NULL REFERENCES staff(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_payment (customer_id, received_at DESC);

CREATE TABLE discount_grant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  shift_id      uuid NOT NULL REFERENCES shift(id),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  customer_ref  text,
  litres        numeric(12,3),
  amount        numeric(16,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL,
  -- A discount is money given away. It needs a name against it, always.
  authorised_by uuid NOT NULL REFERENCES staff(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discount_not_self_authorised CHECK (authorised_by <> staff_id)
);
CREATE INDEX ON discount_grant (shift_id, staff_id);

ALTER TABLE money_movement
  ADD CONSTRAINT fk_money_credit_sale FOREIGN KEY (credit_sale_id) REFERENCES credit_sale(id),
  ADD CONSTRAINT fk_money_discount    FOREIGN KEY (discount_id)    REFERENCES discount_grant(id);

CREATE OR REPLACE VIEW v_credit_ageing AS
WITH billed AS (
  SELECT tenant_id, customer_id, SUM(amount) AS billed,
         MIN(recorded_at) AS oldest
    FROM credit_sale GROUP BY tenant_id, customer_id
), paid AS (
  SELECT tenant_id, customer_id, SUM(amount) AS paid
    FROM credit_payment GROUP BY tenant_id, customer_id
)
SELECT c.id AS customer_id, c.tenant_id, c.code, c.name, c.credit_limit,
       COALESCE(b.billed,0) AS billed, COALESCE(p.paid,0) AS paid,
       COALESCE(b.billed,0) - COALESCE(p.paid,0) AS balance,
       c.credit_limit - (COALESCE(b.billed,0) - COALESCE(p.paid,0)) AS headroom,
       b.oldest AS oldest_invoice
  FROM credit_customer c
  LEFT JOIN billed b ON b.customer_id = c.id
  LEFT JOIN paid   p ON p.customer_id = c.id;

-- ---------------------------------------------------------------------------
-- Shortage receivable against a person.
--
-- v1's bug (audit C3) was that re-running a cash-up INSERTed the shortage
-- again, because only the cash_up row was an upsert. Here the shortage row is
-- keyed on the cash-up, one per cash-up, so a recompute updates rather than
-- duplicates. The balance is DERIVED from the ledger, never carried in a
-- balance_after column that can compound.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_shortage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  staff_id       uuid NOT NULL REFERENCES staff(id),
  shift_id       uuid NOT NULL REFERENCES shift(id),
  cash_up_id     uuid NOT NULL REFERENCES cash_up(id) ON DELETE CASCADE,
  amount         numeric(16,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,
  reason         text NOT NULL,
  acknowledged   boolean NOT NULL DEFAULT FALSE,
  acknowledgement_url text,
  approved_by    uuid REFERENCES staff(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cash_up_id)                     -- <- the fix for C3
);
CREATE INDEX ON staff_shortage (staff_id, created_at DESC);

CREATE TABLE shortage_recovery (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  staff_id     uuid NOT NULL REFERENCES staff(id),
  shortage_id  uuid REFERENCES staff_shortage(id),
  amount       numeric(16,2) NOT NULL CHECK (amount > 0),
  method       text NOT NULL CHECK (method IN ('SALARY_DEDUCTION','CASH','WRITE_OFF','NEXT_SHIFT_OFFSET')),
  acknowledged boolean NOT NULL DEFAULT FALSE,
  evidence_url text,
  approved_by  uuid NOT NULL REFERENCES staff(id),
  recovered_at timestamptz NOT NULL DEFAULT now(),
  -- Deducting from someone's wages without a signed acknowledgement is an
  -- exposure for the dealer as much as an injustice to the attendant.
  CONSTRAINT salary_needs_acknowledgement
    CHECK (method <> 'SALARY_DEDUCTION' OR (acknowledged AND evidence_url IS NOT NULL))
);

ALTER TABLE money_movement
  ADD CONSTRAINT fk_money_shortage FOREIGN KEY (shortage_id) REFERENCES staff_shortage(id);

CREATE OR REPLACE VIEW v_staff_shortage_balance AS
SELECT s.id AS staff_id, s.tenant_id, s.site_id, s.full_name, s.employee_no,
       COALESCE(sh.raised, 0)    AS raised,
       COALESCE(rec.recovered,0) AS recovered,
       COALESCE(sh.raised,0) - COALESCE(rec.recovered,0) AS outstanding,
       sh.last_raised
  FROM staff s
  LEFT JOIN (SELECT staff_id, SUM(amount) raised, MAX(created_at) last_raised
               FROM staff_shortage GROUP BY staff_id) sh ON sh.staff_id = s.id
  LEFT JOIN (SELECT staff_id, SUM(amount) recovered
               FROM shortage_recovery GROUP BY staff_id) rec ON rec.staff_id = s.id;

-- ---------------------------------------------------------------------------
-- Banking. The cash trail must not end in a supervisor's drawer -- v1 had the
-- endpoint and no caller, so it always did.
-- ---------------------------------------------------------------------------
CREATE TABLE banking (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  site_id       uuid NOT NULL REFERENCES site(id),
  business_date date NOT NULL,
  amount        numeric(16,2) NOT NULL CHECK (amount > 0),
  currency      char(3) NOT NULL,
  bank_name     text NOT NULL,
  account_ref   text,
  slip_no       text NOT NULL,
  slip_url      text,
  banked_by     uuid NOT NULL REFERENCES staff(id),
  verified_by   uuid REFERENCES staff(id),
  verified_at   timestamptz,
  banked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slip_no)
);
CREATE INDEX ON banking (site_id, business_date DESC);

-- Cash counted vs cash banked, per day. The gap is the float on hand, and if
-- it grows without explanation that is the finding.
CREATE OR REPLACE VIEW v_cash_position AS
WITH collected AS (
  SELECT sh.site_id, sh.business_date,
         -SUM(m.amount) FILTER (WHERE m.settlement = 'CASH') AS cash_collected
    FROM money_movement m
    JOIN shift sh ON sh.id = m.shift_id
   GROUP BY sh.site_id, sh.business_date
), deposited AS (
  SELECT site_id, business_date, SUM(amount) AS cash_banked
    FROM banking GROUP BY site_id, business_date
)
SELECT COALESCE(c.site_id, d.site_id)             AS site_id,
       COALESCE(c.business_date, d.business_date) AS business_date,
       COALESCE(c.cash_collected, 0)              AS cash_collected,
       COALESCE(d.cash_banked, 0)                 AS cash_banked,
       COALESCE(c.cash_collected,0) - COALESCE(d.cash_banked,0) AS on_hand
  FROM collected c FULL OUTER JOIN deposited d
    ON d.site_id = c.site_id AND d.business_date = c.business_date;
