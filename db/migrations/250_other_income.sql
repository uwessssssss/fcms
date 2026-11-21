-- =============================================================================
-- FCMS v2 -- 250_other_income.sql
--
-- Money a station makes that is not fuel and not shop stock.
--
-- Car washes, tyre inflation, a rented kiosk, a parking bay, the phone
-- charging a rural station does at the counter. Small individually, and on a
-- station running on a four-shilling fuel margin they are frequently the
-- difference between a month that pays and one that does not.
--
-- NOT DRY STOCK, and the distinction matters. Dry stock is a physical thing
-- counted in and out, with a cost price and a quantity that can go negative
-- and be caught. A car wash has no stock: nothing is counted, nothing runs out,
-- and forcing it through a stock ledger would invent an inventory of washes.
--
-- NOT FUEL REVENUE either. It carries no litres and no margin calculation, so
-- it is kept out of every fuel figure -- otherwise a busy car wash would make
-- the forecourt look more profitable per litre than it is.
-- =============================================================================

CREATE TABLE IF NOT EXISTS income_category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

COMMENT ON TABLE income_category IS
  'The kinds of non-fuel income a company takes: car wash, kiosk rent, '
  'tyre service. A list the company controls, not a fixed enum -- a station '
  'in Kiboga and one in Kampala do not earn the same things.';

CREATE TABLE IF NOT EXISTS other_income (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  shift_id       uuid REFERENCES shift(id),
  category_id    uuid NOT NULL REFERENCES income_category(id),
  business_date  date NOT NULL,
  description    text NOT NULL,
  quantity       numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price     numeric(14,2) NOT NULL CHECK (unit_price >= 0),

  -- Stored, not computed on read. A total that someone typed and a total the
  -- database worked out can disagree, and when they do the typed one is the
  -- evidence -- so both are kept and the check below says they must agree.
  amount         numeric(16,2) NOT NULL CHECK (amount >= 0),

  -- How it was paid, because non-fuel income is exactly where cash goes
  -- missing: nothing is metered, so nothing reconciles it except this.
  settlement     text NOT NULL DEFAULT 'CASH'
                 CHECK (settlement IN ('CASH', 'MOBILE_MONEY', 'CARD', 'ACCOUNT')),
  reference      text,

  recorded_by    uuid NOT NULL REFERENCES staff(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT income_total_matches
    CHECK (amount = round(quantity * unit_price, 2))
);

COMMENT ON COLUMN other_income.amount IS
  'Quantity times unit price, stored and checked. Kept rather than derived '
  'because a receipt is a record of what was agreed, and a figure recomputed '
  'at read time cannot be shown to match the paper.';

COMMENT ON COLUMN other_income.settlement IS
  'How it was paid. Non-fuel income is where cash most often goes missing -- '
  'nothing meters a car wash -- so this is the only reconciliation it gets.';

CREATE INDEX IF NOT EXISTS other_income_site_date
  ON other_income (site_id, business_date DESC);

-- Tenant isolation, the same way every other table gets it.
SELECT fn_apply_tenant_rls('public', 'income_category');
SELECT fn_apply_tenant_rls('public', 'other_income');

GRANT SELECT, INSERT, UPDATE ON income_category TO fcms_app;
GRANT SELECT, INSERT ON other_income TO fcms_app;

-- Income is recorded, never edited. A correction is a new row with a note,
-- so the original stays visible -- which is the whole point of a ledger.
CREATE OR REPLACE RULE other_income_no_update AS
  ON UPDATE TO other_income DO INSTEAD NOTHING;

-- The common categories, so a new company has somewhere to start.
INSERT INTO income_category (tenant_id, code, name)
SELECT t.id, c.code, c.name
  FROM tenant t
 CROSS JOIN (VALUES
   ('CARWASH', 'Car wash'),
   ('TYRES',   'Tyre service'),
   ('RENT',    'Rent received'),
   ('PARKING', 'Parking'),
   ('OTHER',   'Other income')
 ) AS c(code, name)
ON CONFLICT (tenant_id, code) DO NOTHING;
