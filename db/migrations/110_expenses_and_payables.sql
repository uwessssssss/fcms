-- =============================================================================
-- FCMS v2 -- 110_expenses_and_payables.sql
--
-- What the station SPENDS.
--
-- Until now the system knew what fuel sold for and what it cost, and stopped
-- there. That gives gross margin, which is a useful number and not a profit --
-- a station with a healthy margin and an unpaid electricity bill is not doing
-- well, it just has not been told yet.
--
-- Two additions:
--
--   EXPENSES     running costs. Wages, power, security, repairs, transport.
--                Small, frequent, and the thing that quietly eats a forecourt.
--
--   PAYABLES     what is owed to fuel suppliers. A delivery creates a debt;
--                a payment settles it. Without this, a month with two big
--                deliveries and no payments looks like the best month of the
--                year.
--
-- Both are deliberately simple. This is a station system, not a general
-- ledger, and pretending otherwise produces a chart of accounts nobody
-- maintains and reports nobody trusts.
-- =============================================================================

CREATE TYPE expense_category AS ENUM (
  'WAGES',
  'POWER',
  'WATER',
  'SECURITY',
  'REPAIRS',
  'MAINTENANCE',
  'TRANSPORT',
  'LICENCES',
  'RENT',
  'CONSUMABLES',
  'BANK_CHARGES',
  'OTHER'
);

CREATE TABLE expense (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  business_date  date NOT NULL,
  category       expense_category NOT NULL,
  description    text NOT NULL,
  amount         numeric(16,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,

  -- How it was paid. Cash out of the till is the one that matters most: it
  -- reduces what should be banked, and a station that pays the security guard
  -- from the drawer without recording it shows a cash shortage nobody can
  -- explain.
  paid_from      text NOT NULL CHECK (paid_from IN ('TILL_CASH','BANK','MOBILE_MONEY','CREDIT')),
  reference      text,
  supplier_id    uuid REFERENCES supplier(id),
  receipt_url    text,

  recorded_by    uuid NOT NULL REFERENCES staff(id),
  approved_by    uuid REFERENCES staff(id),
  approved_at    timestamptz,
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expense_needs_description
    CHECK (length(trim(description)) >= 3),
  -- Money leaving the business needs a second name on it above a threshold.
  -- The threshold itself lives in tenant_policy; this only enforces that an
  -- approver, when named, is not the person who recorded it.
  CONSTRAINT expense_two_pairs_of_eyes
    CHECK (approved_by IS NULL OR approved_by <> recorded_by)
);

CREATE INDEX ON expense (site_id, business_date DESC);
CREATE INDEX ON expense (category, business_date DESC);
CREATE INDEX ON expense (supplier_id) WHERE supplier_id IS NOT NULL;

DO $$
BEGIN
  PERFORM fn_require_operator_author('expense', 'recorded_by');
  PERFORM fn_require_operator_author('expense', 'approved_by');
END $$;

-- ---------------------------------------------------------------------------
-- SUPPLIER INVOICES
--
-- A delivery arrives with a note; an invoice follows, sometimes days later,
-- sometimes covering several loads. Modelling the invoice separately from the
-- delivery is what lets those two facts disagree without either being wrong --
-- and they disagree constantly, because the depot bills what it loaded and the
-- station received what reached the ground.
-- ---------------------------------------------------------------------------
CREATE TABLE supplier_invoice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  supplier_id    uuid NOT NULL REFERENCES supplier(id),
  invoice_no     text NOT NULL,
  invoice_date   date NOT NULL,
  due_date       date,
  amount         numeric(16,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,
  notes          text,
  recorded_by    uuid NOT NULL REFERENCES staff(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, supplier_id, invoice_no)
);
CREATE INDEX ON supplier_invoice (site_id, invoice_date DESC);

DO $$ BEGIN PERFORM fn_require_operator_author('supplier_invoice', 'recorded_by'); END $$;

-- Which deliveries an invoice covers. Many-to-many on purpose: one invoice can
-- cover several loads, and one load can be split across invoices.
CREATE TABLE supplier_invoice_delivery (
  invoice_id   uuid NOT NULL REFERENCES supplier_invoice(id) ON DELETE CASCADE,
  delivery_id  uuid NOT NULL REFERENCES delivery(id),
  PRIMARY KEY (invoice_id, delivery_id)
);

CREATE TABLE supplier_payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  site_id        uuid NOT NULL REFERENCES site(id),
  supplier_id    uuid NOT NULL REFERENCES supplier(id),
  invoice_id     uuid REFERENCES supplier_invoice(id),
  amount         numeric(16,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,
  method         text NOT NULL CHECK (method IN ('BANK','CASH','MOBILE_MONEY','CHEQUE','CONTRA')),
  reference      text,
  slip_url       text,
  paid_on        date NOT NULL,
  recorded_by    uuid NOT NULL REFERENCES staff(id),
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON supplier_payment (supplier_id, paid_on DESC);
CREATE INDEX ON supplier_payment (invoice_id) WHERE invoice_id IS NOT NULL;

DO $$ BEGIN PERFORM fn_require_operator_author('supplier_payment', 'recorded_by'); END $$;

-- ---------------------------------------------------------------------------
-- What is owed, and to whom.
--
-- Derived, like every other balance in this schema. An unallocated payment --
-- one with no invoice against it -- still reduces the supplier balance, which
-- is how it works in practice: money goes out on account and gets matched
-- later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_supplier_balance AS
WITH billed AS (
  SELECT supplier_id, site_id, SUM(amount) AS billed, MIN(invoice_date) AS oldest,
         MIN(due_date) FILTER (WHERE due_date IS NOT NULL) AS earliest_due
    FROM supplier_invoice GROUP BY supplier_id, site_id
), paid AS (
  SELECT supplier_id, site_id, SUM(amount) AS paid
    FROM supplier_payment GROUP BY supplier_id, site_id
)
SELECT
  s.id                                   AS supplier_id,
  s.tenant_id,
  COALESCE(b.site_id, p.site_id)         AS site_id,
  s.code,
  s.name,
  COALESCE(b.billed, 0)                  AS billed,
  COALESCE(p.paid, 0)                    AS paid,
  COALESCE(b.billed, 0) - COALESCE(p.paid, 0) AS balance,
  b.oldest                               AS oldest_invoice,
  b.earliest_due                         AS earliest_due,
  (b.earliest_due IS NOT NULL AND b.earliest_due < current_date
   AND COALESCE(b.billed,0) > COALESCE(p.paid,0)) AS overdue
FROM supplier s
LEFT JOIN billed b ON b.supplier_id = s.id
LEFT JOIN paid   p ON p.supplier_id = s.id;

-- ---------------------------------------------------------------------------
-- Expenses per day per category, for the trading summary.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_expense AS
SELECT site_id, business_date, category::text AS category,
       SUM(amount) AS amount,
       SUM(amount) FILTER (WHERE paid_from = 'TILL_CASH') AS from_till,
       count(*) AS entries
  FROM expense
 GROUP BY site_id, business_date, category;

COMMENT ON VIEW v_daily_expense IS
  'from_till matters on its own: cash paid out of the drawer reduces what '
  'should be banked, and an unrecorded one becomes a shortage nobody can '
  'explain.';
