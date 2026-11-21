using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class StatementColumn
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>text | figure | money | litres | date | pill</summary>
    public string Kind { get; set; } = "text";
}

public record StatementMeta(
    string Key, string Title, string Purpose, string Group, bool NeedsDates);

public record StatementResult(
    string Key, string Title, string Purpose,
    DateOnly? From, DateOnly? To,
    List<StatementColumn> Columns,
    List<Dictionary<string, object?>> Rows,
    Dictionary<string, decimal> Totals);

/// <summary>
/// Every statement in the system, from one place.
///
/// WHY A REGISTRY AND NOT TWENTY ENDPOINTS
///
/// A station needs a lot of statements: what each attendant handed in by
/// channel, every shortage and whether it was recovered, every dip against the
/// books, the discount log, the month's stock adjustments. Each one is a query,
/// a date range, some columns, and a total row. The rest -- permissions, date
/// handling, CSV, printing, empty states, the screen -- is identical.
///
/// Written as twenty endpoints and twenty screens, twenty copies of that
/// identical part drift apart, and the twenty-first statement is a week of
/// work. Written as a registry, a new statement is ITS SQL AND NOTHING ELSE,
/// and every statement gains a feature the moment one does.
///
/// The SQL here is trusted and fixed. Nothing from the request reaches it
/// except the two dates and the site, both as parameters -- the key selects a
/// definition from this dictionary and is never interpolated.
/// </summary>
public sealed class StatementService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public StatementService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    private sealed record Def(
        string Title,
        string Purpose,
        string Group,
        string Sql,
        StatementColumn[] Columns,
        string[] TotalKeys,
        string Permission = "report.view",
        bool NeedsDates = true);

    private static StatementColumn C(string key, string label, string kind = "text")
        => new() { Key = key, Label = label, Kind = kind };

    private static readonly Dictionary<string, Def> Defs = new(StringComparer.OrdinalIgnoreCase)
    {
        // ------------------------------------------------------------------
        // MONEY IN
        // ------------------------------------------------------------------
        ["mobile-money"] = new(
            "Mobile money and card",
            "Every electronic tender, by channel and till. This is the statement "
            + "to sit beside an MTN or Airtel printout when the two disagree.",
            "Money in",
            """
            SELECT t.business_date          AS "date",
                   t.shift_label            AS "shift",
                   t.attendant_name         AS "attendant",
                   COALESCE(t.channel_name, t.settlement) AS "channel",
                   t.till_number            AS "till",
                   t.reference              AS "reference",
                   t.amount                 AS "amount"
              FROM v_attendant_tender t
             WHERE t.site_id = @site
               AND t.business_date BETWEEN @from AND @to
               AND t.settlement IN ('MOBILE_MONEY','CARD','VOUCHER')
             ORDER BY t.business_date DESC, t.attendant_name, t.channel_name
            """,
            [C("date", "Date", "date"), C("shift", "Shift"), C("attendant", "Attendant"),
             C("channel", "Channel"), C("till", "Till", "figure"),
             C("reference", "Reference"), C("amount", "Amount", "money")],
            ["amount"]),

        ["cash-banked"] = new(
            "Cash and banking",
            "Cash taken at the pump against cash that reached the bank. The gap "
            + "is what is still in the safe -- or what is not.",
            "Money in",
            """
            SELECT b.business_date  AS "date",
                   b.slip_no        AS "slip",
                   b.bank_name      AS "bank",
                   s.full_name      AS "banked_by",
                   b.amount         AS "amount"
              FROM banking b
              LEFT JOIN staff s ON s.id = b.banked_by
             WHERE b.site_id = @site AND b.business_date BETWEEN @from AND @to
             ORDER BY b.business_date DESC
            """,
            [C("date", "Date", "date"), C("slip", "Slip", "figure"), C("bank", "Bank"),
             C("banked_by", "Banked by"), C("amount", "Amount", "money")],
            ["amount"],
            "banking.record"),

        ["discounts"] = new(
            "Discounts given",
            "Every shilling the station agreed not to collect, who authorised it "
            + "and why. Revenue is gross of these, so this is real margin given away.",
            "Money in",
            """
            SELECT sh.business_date        AS "date",
                   att.full_name           AS "attendant",
                   auth.full_name          AS "authorised_by",
                   d.amount                AS "amount",
                   d.reason                AS "reason"
              FROM discount_grant d
              JOIN shift sh  ON sh.id = d.shift_id
              JOIN staff att ON att.id = d.staff_id
              LEFT JOIN staff auth ON auth.id = d.authorised_by
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             ORDER BY sh.business_date DESC, d.amount DESC
            """,
            [C("date", "Date", "date"), C("attendant", "Attendant"),
             C("authorised_by", "Authorised by"), C("amount", "Amount", "money"),
             C("reason", "Reason")],
            ["amount"]),

        // ------------------------------------------------------------------
        // PEOPLE
        // ------------------------------------------------------------------
        ["shortages"] = new(
            "Shortages and recoveries",
            "What each person came up short, what has been recovered, and what is "
            + "still owed. A shortage nobody chased is a wage subsidy.",
            "People",
            """
            SELECT sh.business_date   AS "date",
                   -- Carried but not shown: a recovery must name the shortage
                   -- and the person, and a statement without them left the
                   -- recovery screen with nothing to recover against.
                   ss.id              AS "shortage_id",
                   sh.label::text     AS "shift",
                   st.id              AS "staff_id",
                   st.full_name       AS "attendant",
                   st.employee_no     AS "employee_no",
                   ss.amount          AS "raised",
                   COALESCE(rec.recovered, 0) AS "recovered",
                   ss.amount - COALESCE(rec.recovered, 0) AS "outstanding",
                   CASE WHEN ss.approved_by IS NULL THEN 'Waiting'
                        WHEN ss.amount - COALESCE(rec.recovered, 0) <= 0 THEN 'Settled'
                        ELSE 'Owing' END AS "status",
                   ss.reason          AS "reason"
              FROM staff_shortage ss
              JOIN cash_up c ON c.id = ss.cash_up_id
              JOIN shift sh  ON sh.id = c.shift_id
              JOIN staff st  ON st.id = ss.staff_id
              LEFT JOIN (SELECT shortage_id, SUM(amount) AS recovered
                           FROM shortage_recovery GROUP BY shortage_id) rec
                     ON rec.shortage_id = ss.id
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             ORDER BY sh.business_date DESC, ss.amount DESC
            """,
            [C("date", "Date", "date"), C("attendant", "Attendant"),
             C("employee_no", "No.", "figure"), C("raised", "Raised", "money"),
             C("recovered", "Recovered", "money"), C("outstanding", "Still owed", "money"),
             C("status", "Status", "pill"), C("reason", "Reason")],
            ["raised", "recovered", "outstanding"]),

        ["attendant-performance"] = new(
            "Attendant record",
            "Litres pumped, value handed in, and shortages raised, per person. "
            + "One bad night is noise; a name that recurs is not.",
            "People",
            """
            SELECT st.full_name      AS "attendant",
                   st.employee_no    AS "employee_no",
                   count(DISTINCT sh.id)          AS "shifts",
                   COALESCE(SUM(md.litres), 0)    AS "litres",
                   COALESCE(SUM(md.litres * md.unit_price), 0) AS "value",
                   COALESCE(SUM(ss.amount), 0)    AS "shortages"
              FROM staff st
              JOIN nozzle_assignment na ON na.attendant_id = st.id
              JOIN shift sh ON sh.id = na.shift_id
              LEFT JOIN meter_event me ON me.assignment_id = na.id
              LEFT JOIN metered_disposition md
                     ON md.meter_event_id = me.id AND md.kind = 'SALE'
              LEFT JOIN cash_up cu ON cu.shift_id = sh.id AND cu.staff_id = st.id
              LEFT JOIN staff_shortage ss ON ss.cash_up_id = cu.id
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             GROUP BY st.id, st.full_name, st.employee_no
             ORDER BY COALESCE(SUM(ss.amount), 0) DESC, SUM(md.litres) DESC
            """,
            [C("attendant", "Attendant"), C("employee_no", "No.", "figure"),
             C("shifts", "Shifts", "figure"), C("litres", "Litres", "litres"),
             C("value", "Value", "money"), C("shortages", "Shortages", "money")],
            ["litres", "value", "shortages"]),

        // ------------------------------------------------------------------
        // WET STOCK
        // ------------------------------------------------------------------
        ["dips"] = new(
            "Dip register",
            "Every dip taken, by tank, against what the books expected. The raw "
            + "evidence behind every variance figure in the system.",
            "Wet stock",
            """
            SELECT COALESCE(sh.business_date, d.captured_at::date) AS "date",
                   t.code             AS "tank",
                   p.code             AS "product",
                   d.context          AS "context",
                   d.product_litres   AS "dipped",
                   d.water_litres     AS "water",
                   st.full_name       AS "taken_by",
                   d.captured_at      AS "at"
              FROM dip_reading d
              JOIN tank t    ON t.id = d.tank_id
              JOIN product p ON p.id = t.product_id
              LEFT JOIN shift sh ON sh.id = d.shift_id
              LEFT JOIN staff st ON st.id = d.recorded_by
             WHERE d.site_id = @site
               AND COALESCE(sh.business_date, d.captured_at::date) BETWEEN @from AND @to
             ORDER BY d.captured_at DESC
            """,
            [C("date", "Date", "date"), C("tank", "Tank"), C("product", "Product"),
             C("context", "When", "pill"), C("dipped", "Dipped", "litres"),
             C("water", "Water", "litres"), C("taken_by", "Taken by"),
             C("at", "Time", "date")],
            ["dipped"]),

        ["loss-gain"] = new(
            "Daily loss and gain",
            "Per tank, per day: what was sold, what the books said, what the stick "
            + "found. A single day is noise -- a column that only goes one way is not.",
            "Wet stock",
            """
            SELECT l.business_date  AS "date",
                   l.tank_code      AS "tank",
                   l.product_code   AS "product",
                   l.received_litres AS "received",
                   l.sold_litres    AS "sold",
                   l.book_litres    AS "book",
                   l.actual_litres  AS "dipped",
                   l.loss_litres    AS "difference",
                   l.loss_value     AS "at_cost"
              FROM v_daily_stock_loss l
             WHERE l.site_id = @site AND l.business_date BETWEEN @from AND @to
             ORDER BY l.business_date DESC, l.tank_code
            """,
            [C("date", "Date", "date"), C("tank", "Tank"), C("product", "Product"),
             C("received", "Received", "litres"), C("sold", "Sold", "litres"),
             C("book", "Books", "litres"), C("dipped", "Dipped", "litres"),
             C("difference", "Difference", "litres"), C("at_cost", "At cost", "money")],
            ["received", "sold", "difference", "at_cost"]),

        ["stock-adjustments"] = new(
            "Stock adjustments",
            "Every stock take and the adjustment it produced, with the reason "
            + "given. This is the month-end trail an auditor asks for first.",
            "Wet stock",
            """
            SELECT sc.counted_on       AS "date",
                   sc.kind             AS "kind",
                   t.code              AS "tank",
                   p.code              AS "product",
                   sct.book_litres     AS "book",
                   sct.counted_litres  AS "counted",
                   sct.variance_litres AS "adjustment",
                   sct.variance_reason AS "reason",
                   st.full_name        AS "counted_by"
              FROM stock_count sc
              JOIN stock_count_tank sct ON sct.count_id = sc.id
              JOIN tank t    ON t.id = sct.tank_id
              JOIN product p ON p.id = t.product_id
              LEFT JOIN staff st ON st.id = sc.counted_by
             WHERE sc.site_id = @site AND sc.counted_on BETWEEN @from AND @to
             ORDER BY sc.counted_on DESC, t.code
            """,
            [C("date", "Date", "date"), C("kind", "Kind", "pill"), C("tank", "Tank"),
             C("product", "Product"), C("book", "Books", "litres"),
             C("counted", "Counted", "litres"), C("adjustment", "Adjustment", "litres"),
             C("reason", "Reason"), C("counted_by", "Counted by")],
            ["adjustment"]),

        ["meter-drift"] = new(
            "Meter drift",
            "Electronic head against mechanical, per nozzle. A pump drifting past "
            + "half a percent gives fuel away on every fill and shows nowhere else.",
            "Wet stock",
            """
            SELECT m.business_date   AS "date",
                   m.nozzle_label    AS "nozzle",
                   m.product_code    AS "product",
                   m.mechanical_litres AS "mechanical",
                   m.electronic_litres AS "electronic",
                   m.divergence_litres AS "drift",
                   m.divergence_pct  AS "drift_pct"
              FROM v_meter_divergence m
             WHERE m.site_id = @site AND m.business_date BETWEEN @from AND @to
             ORDER BY abs(m.divergence_litres) DESC
            """,
            [C("date", "Date", "date"), C("nozzle", "Nozzle"), C("product", "Product"),
             C("mechanical", "Mechanical", "litres"), C("electronic", "Electronic", "litres"),
             C("drift", "Drift", "litres"), C("drift_pct", "Drift %", "figure")],
            ["mechanical", "electronic", "drift"]),

        ["deliveries"] = new(
            "Deliveries received",
            "Every load in, what the note said and what the dips found. A shortfall "
            + "on delivery is the cheapest loss to prove and the easiest to miss.",
            "Wet stock",
            """
            SELECT d.decant_ended_at::date AS "date",
                   d.delivery_note_no AS "note",
                   sup.name           AS "supplier",
                   d.truck_reg        AS "truck",
                   t.code             AS "tank",
                   dl.loaded_litres   AS "on_note",
                   dl.received_litres AS "received",
                   dl.transit_variance AS "variance",
                   d.status           AS "status"
              FROM delivery d
              JOIN delivery_line dl ON dl.delivery_id = d.id
              JOIN tank t   ON t.id = dl.tank_id
              LEFT JOIN supplier sup ON sup.id = d.supplier_id
             WHERE d.site_id = @site
               AND COALESCE(d.decant_ended_at, d.arrived_at)::date BETWEEN @from AND @to
             ORDER BY COALESCE(d.decant_ended_at, d.arrived_at) DESC
            """,
            [C("date", "Date", "date"), C("note", "Note", "figure"), C("supplier", "Supplier"),
             C("truck", "Truck", "figure"), C("tank", "Tank"),
             C("on_note", "On note", "litres"), C("received", "Received", "litres"),
             C("variance", "Variance", "litres"), C("status", "Status", "pill")],
            ["on_note", "received", "variance"]),

        ["own-use"] = new(
            "Own use",
            "Fuel the business burned itself. It reduces stock legitimately, and it "
            + "was bought and never sold, so it is a cost like any other.",
            "Wet stock",
            """
            SELECT sh.business_date AS "date",
                   t.code           AS "tank",
                   p.code           AS "product",
                   ou.litres        AS "litres",
                   ou.purpose       AS "reason",
                   st.full_name     AS "authorised_by"
              FROM own_use ou
              JOIN shift sh  ON sh.id = ou.shift_id
              JOIN tank t    ON t.id = ou.tank_id
              JOIN product p ON p.id = t.product_id
              LEFT JOIN staff st ON st.id = ou.authorised_by
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             ORDER BY sh.business_date DESC
            """,
            [C("date", "Date", "date"), C("tank", "Tank"), C("product", "Product"),
             C("litres", "Litres", "litres"), C("reason", "Reason"),
             C("authorised_by", "Authorised by")],
            ["litres"]),

        ["pump-tests"] = new(
            "Pump tests",
            "Every test draw and whether the can came back within tolerance. Fuel "
            + "that left the pump and returned to the tank, accounted for either way.",
            "Wet stock",
            """
            SELECT sh.business_date AS "date",
                   pu.code          AS "pump",
                   nz.code          AS "nozzle",
                   pt.can_size_litres AS "can",
                   pt.measured_litres AS "measured",
                   pt.measured_litres - pt.can_size_litres AS "error",
                   st.full_name     AS "tested_by"
              FROM pump_test pt
              JOIN shift sh  ON sh.id = pt.shift_id
              JOIN nozzle nz ON nz.id = pt.nozzle_id
              JOIN pump pu   ON pu.id = nz.pump_id
              LEFT JOIN staff st ON st.id = pt.tested_by
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             ORDER BY sh.business_date DESC
            """,
            [C("date", "Date", "date"), C("pump", "Pump"), C("nozzle", "Nozzle"),
             C("can", "Can", "litres"), C("measured", "Measured", "litres"),
             C("error", "Error", "litres"), C("tested_by", "Tested by")],
            ["can", "measured"]),

        // ------------------------------------------------------------------
        // CREDIT
        // ------------------------------------------------------------------
        ["credit-sales"] = new(
            "Credit sales",
            "Every litre billed to an account, with the voucher and the vehicle. "
            + "The evidence behind every figure on a customer statement.",
            "Credit",
            """
            SELECT cs.recorded_at::date AS "date",
                   c.name        AS "customer",
                   cs.voucher_no AS "voucher",
                   v.plate_no    AS "vehicle",
                   p.code        AS "product",
                   cs.litres     AS "litres",
                   cs.unit_price AS "price",
                   cs.amount     AS "amount"
              FROM credit_sale cs
              JOIN credit_customer c ON c.id = cs.customer_id
              JOIN product p ON p.id = cs.product_id
              LEFT JOIN credit_vehicle v ON v.id = cs.vehicle_id
             WHERE cs.site_id = @site AND cs.recorded_at::date BETWEEN @from AND @to
             ORDER BY cs.recorded_at DESC
            """,
            [C("date", "Date", "date"), C("customer", "Customer"),
             C("voucher", "Voucher", "figure"), C("vehicle", "Vehicle", "figure"),
             C("product", "Product"), C("litres", "Litres", "litres"),
             C("price", "Price", "money"), C("amount", "Amount", "money")],
            ["litres", "amount"],
            "credit_customer.manage"),

        ["credit-payments"] = new(
            "Payments received",
            "Money in against accounts, with the reference. Sits beside the ageing "
            + "to show whether a customer is paying or only promising.",
            "Credit",
            """
            SELECT cp.received_at::date AS "date",
                   c.name       AS "customer",
                   cp.method::text AS "method",
                   cp.reference AS "reference",
                   cp.amount    AS "amount",
                   st.full_name AS "received_by"
              FROM credit_payment cp
              JOIN credit_customer c ON c.id = cp.customer_id
              LEFT JOIN staff st ON st.id = cp.received_by
             WHERE cp.received_at::date BETWEEN @from AND @to
             ORDER BY cp.received_at DESC
            """,
            [C("date", "Date", "date"), C("customer", "Customer"),
             C("method", "Method", "pill"), C("reference", "Reference"),
             C("amount", "Amount", "money"), C("received_by", "Received by")],
            ["amount"],
            "credit_customer.manage"),

        ["credit-ageing"] = new(
            "Debtor ageing",
            "Who owes what, and for how long. Past agreed terms is the column that "
            + "needs a phone call today.",
            "Credit",
            """
            SELECT c.name       AS "customer",
                   b.balance     AS "balance",
                   b.current_30 AS "under_30",
                   b.days_31_60 AS "d30_60",
                   b.days_61_90 AS "d60_90",
                   b.over_90    AS "over_90",
                   b.over_90    AS "past_terms",
                   b.oldest_days AS "oldest_days"
              FROM v_credit_ageing_buckets b
              JOIN credit_customer c ON c.id = b.customer_id
             WHERE b.balance <> 0
             ORDER BY b.over_90 DESC, b.balance DESC
            """,
            [C("customer", "Customer"), C("balance", "Balance", "money"),
             C("under_30", "Under 30", "money"), C("d30_60", "30-60", "money"),
             C("d60_90", "60-90", "money"), C("over_90", "Over 90", "money"),
             C("past_terms", "Past terms", "money"), C("oldest_days", "Oldest", "figure")],
            ["balance", "under_30", "d30_60", "d60_90", "over_90", "past_terms"],
            "credit_customer.manage",
            NeedsDates: false),

        // ------------------------------------------------------------------
        // MONEY OUT
        // ------------------------------------------------------------------
        ["expenses"] = new(
            "Expenses",
            "What was spent, on what, and out of which pocket. Till cash spent is "
            + "cash that will never reach the bank, so it is marked.",
            "Money out",
            """
            SELECT e.business_date  AS "date",
                   -- Carried but not shown: an expense cannot be approved
                   -- without naming which one.
                   e.id            AS "expense_id",
                   e.category::text AS "category",
                   e.description    AS "description",
                   e.paid_from      AS "paid_from",
                   e.amount         AS "amount",
                   CASE WHEN e.approved_by IS NULL THEN 'Waiting' ELSE 'Approved' END AS "status"
              FROM expense e
             WHERE e.site_id = @site AND e.business_date BETWEEN @from AND @to
             ORDER BY e.business_date DESC
            """,
            [C("date", "Date", "date"), C("category", "Category", "pill"),
             C("description", "Description"), C("paid_from", "Paid from", "pill"),
             C("amount", "Amount", "money"), C("status", "Status", "pill")],
            ["amount"],
            "banking.record"),

        ["supplier-payments"] = new(
            "Supplier payments",
            "What was invoiced and what was paid. A month with two big deliveries "
            + "and no payments looks like the best month of the year until this.",
            "Money out",
            """
            SELECT sp.paid_on::date AS "date",
                   s.name      AS "supplier",
                   sp.method   AS "method",
                   sp.reference AS "reference",
                   sp.amount   AS "amount"
              FROM supplier_payment sp
              JOIN supplier s ON s.id = sp.supplier_id
             WHERE sp.site_id = @site AND sp.paid_on::date BETWEEN @from AND @to
             ORDER BY sp.paid_on DESC
            """,
            [C("date", "Date", "date"), C("supplier", "Supplier"),
             C("method", "Method", "pill"), C("reference", "Reference"),
             C("amount", "Amount", "money")],
            ["amount"],
            "banking.record"),

        // ------------------------------------------------------------------
        // TRADING
        // ------------------------------------------------------------------
        ["price-changes"] = new(
            "Price changes",
            "Every price that moved, when, and who executed it. A price change "
            + "that did not cut a shift is a margin figure nobody can defend.",
            "Trading",
            """
            SELECT pc.effective_from::date AS "date",
                   p.code        AS "product",
                   pc.old_price  AS "from_price",
                   pc.new_price  AS "to_price",
                   pc.new_price - pc.old_price AS "change",
                   pc.status::text AS "status"
              FROM price_change pc
              JOIN product p ON p.id = pc.product_id
             WHERE pc.site_id = @site AND pc.effective_from::date BETWEEN @from AND @to
             ORDER BY pc.effective_from DESC
            """,
            [C("date", "Date", "date"), C("product", "Product"),
             C("from_price", "From", "money"), C("to_price", "To", "money"),
             C("change", "Change", "money"), C("status", "Status", "pill")],
            [],
            "price.execute"),

        ["shop-sales"] = new(
            "Shop and lubricants",
            "Dry stock sold, by receipt. Small money that adds up, and the only "
            + "line where an LPG cylinder exchange is visible.",
            "Trading",
            """
            SELECT sh.business_date AS "date",
                   ds.receipt_no    AS "receipt",
                   i.sku            AS "item",
                   i.name           AS "description",
                   dsl.qty          AS "qty",
                   dsl.unit_price   AS "price",
                   dsl.line_amount  AS "amount"
              FROM dry_sale ds
              JOIN dry_sale_line dsl ON dsl.sale_id = ds.id
              JOIN dry_item i ON i.id = dsl.item_id
              JOIN shift sh   ON sh.id = ds.shift_id
             WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
             ORDER BY sh.business_date DESC, ds.receipt_no
            """,
            [C("date", "Date", "date"), C("receipt", "Receipt", "figure"),
             C("item", "Code", "figure"), C("description", "Item"),
             C("qty", "Qty", "figure"), C("price", "Price", "money"),
             C("amount", "Amount", "money")],
            ["qty", "amount"],
            "dry_sale.record"),

        ["bulk-sales"] = new(
            "Wholesale loads",
            "Fuel out of the depot by the truckload, with the margin on each. A "
            + "load below cost is a month of retail margin gone.",
            "Trading",
            """
            SELECT bs.loaded_at::date AS "date",
                   bs.invoice_no  AS "invoice",
                   c.name         AS "customer",
                   bs.truck_reg   AS "truck",
                   p.code         AS "product",
                   bs.litres      AS "litres",
                   bs.unit_price  AS "price",
                   bs.unit_cost   AS "cost",
                   (bs.unit_price - COALESCE(bs.unit_cost, 0)) * bs.litres AS "margin"
              FROM bulk_sale bs
              JOIN product p ON p.id = bs.product_id
              LEFT JOIN credit_customer c ON c.id = bs.customer_id
             WHERE bs.site_id = @site AND bs.loaded_at::date BETWEEN @from AND @to
             ORDER BY bs.loaded_at DESC
            """,
            [C("date", "Date", "date"), C("invoice", "Invoice", "figure"),
             C("customer", "Customer"), C("truck", "Truck", "figure"),
             C("product", "Product"), C("litres", "Litres", "litres"),
             C("price", "Price", "money"), C("cost", "Cost", "money"),
             C("margin", "Margin", "money")],
            ["litres", "margin"],
            "delivery.receive"),

        ["daily-summary"] = new(
            "Daily summary",
            "One row a day: what was sold, how it was paid for, what was given "
            + "away, what was spent, and whether the tanks agreed. The whole "
            + "trading day on a line.",
            "Trading",
            """
            WITH sales AS (
              SELECT sh.business_date AS d,
                     SUM(md.litres)                       AS litres,
                     SUM(md.litres * md.unit_price)       AS gross
                FROM shift sh
                JOIN meter_event me ON me.shift_id = sh.id
                JOIN metered_disposition md
                       ON md.meter_event_id = me.id AND md.kind = 'SALE'
               WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
               GROUP BY sh.business_date
            ),
            tenders AS (
              SELECT t.business_date AS d,
                     SUM(t.amount) FILTER (WHERE t.settlement = 'CASH')          AS cash,
                     SUM(t.amount) FILTER (WHERE t.settlement = 'MOBILE_MONEY')  AS momo,
                     SUM(t.amount) FILTER (WHERE t.settlement = 'CARD')          AS card
                FROM v_attendant_tender t
               WHERE t.site_id = @site AND t.business_date BETWEEN @from AND @to
               GROUP BY t.business_date
            ),
            credit AS (
              SELECT cs.recorded_at::date AS d, SUM(cs.amount) AS amount
                FROM credit_sale cs
               WHERE cs.site_id = @site
                 AND cs.recorded_at::date BETWEEN @from AND @to
               GROUP BY cs.recorded_at::date
            ),
            disc AS (
              SELECT sh.business_date AS d, SUM(dg.amount) AS amount
                FROM discount_grant dg
                JOIN shift sh ON sh.id = dg.shift_id
               WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
               GROUP BY sh.business_date
            ),
            spend AS (
              SELECT e.business_date AS d, SUM(e.amount) AS amount
                FROM expense e
               WHERE e.site_id = @site AND e.business_date BETWEEN @from AND @to
               GROUP BY e.business_date
            ),
            variance AS (
              SELECT l.business_date AS d, SUM(l.loss_litres) AS litres
                FROM v_daily_stock_loss l
               WHERE l.site_id = @site AND l.business_date BETWEEN @from AND @to
               GROUP BY l.business_date
            ),
            shorts AS (
              SELECT sh.business_date AS d, SUM(ss.amount) AS amount
                FROM staff_shortage ss
                JOIN cash_up c ON c.id = ss.cash_up_id
                JOIN shift sh  ON sh.id = c.shift_id
               WHERE sh.site_id = @site AND sh.business_date BETWEEN @from AND @to
               GROUP BY sh.business_date
            )
            SELECT s.d                          AS "date",
                   COALESCE(s.gross, 0)         AS "total_sales",
                   COALESCE(t.cash, 0)          AS "cash",
                   COALESCE(t.momo, 0)          AS "mobile_money",
                   COALESCE(t.card, 0)          AS "card",
                   COALESCE(cr.amount, 0)       AS "credit",
                   COALESCE(ds.amount, 0)       AS "discounts",
                   COALESCE(sp.amount, 0)       AS "expenses",
                   COALESCE(s.litres, 0)        AS "litres",
                   COALESCE(v.litres, 0)        AS "gain_loss",
                   COALESCE(sr.amount, 0)       AS "short"
              FROM sales s
              LEFT JOIN tenders  t  ON t.d  = s.d
              LEFT JOIN credit   cr ON cr.d = s.d
              LEFT JOIN disc     ds ON ds.d = s.d
              LEFT JOIN spend    sp ON sp.d = s.d
              LEFT JOIN variance v  ON v.d  = s.d
              LEFT JOIN shorts   sr ON sr.d = s.d
             ORDER BY s.d DESC
            """,
            [C("date", "Date", "date"), C("total_sales", "Sold", "money"),
             C("cash", "Cash", "money"), C("mobile_money", "Mobile money", "money"),
             C("card", "Card", "money"), C("credit", "On account", "money"),
             C("discounts", "Discounts", "money"), C("expenses", "Spent", "money"),
             C("litres", "Litres", "litres"), C("gain_loss", "Gain/loss", "litres"),
             C("short", "Short", "money")],
            ["total_sales", "cash", "mobile_money", "card", "credit",
             "discounts", "expenses", "litres", "gain_loss", "short"]),

        // ------------------------------------------------------------------
        // CONTROL
        // ------------------------------------------------------------------
        ["exceptions"] = new(
            "Exception log",
            "Everything the system refused to let pass quietly, and whether anyone "
            + "answered it. An exception nobody resolved is a control that does not exist.",
            "Control",
            """
            SELECT e.raised_at::date AS "date",
                   e.code      AS "kind",
                   e.level     AS "level",
                   e.entity    AS "about",
                   CASE WHEN e.resolved_at IS NULL THEN 'Open' ELSE 'Resolved' END AS "status",
                   st.full_name AS "resolved_by",
                   e.resolution AS "resolution"
              FROM exception_flag e
              LEFT JOIN staff st ON st.id = e.resolved_by
             WHERE e.site_id = @site AND e.raised_at::date BETWEEN @from AND @to
             ORDER BY e.raised_at DESC
            """,
            [C("date", "Date", "date"), C("kind", "Kind"), C("level", "Level", "pill"),
             C("about", "About"), C("status", "Status", "pill"),
             C("resolved_by", "Resolved by"), C("resolution", "Resolution")],
            []),

        ["shift-log"] = new(
            "Shift log",
            "Every shift opened and closed, by whom, and whether it was signed off. "
            + "A shift closed for a price change reads differently from one that ran out.",
            "Control",
            """
            SELECT s.business_date AS "date",
                   s.label::text   AS "shift",
                   s.segment       AS "part",
                   op.full_name    AS "opened_by",
                   cl.full_name    AS "closed_by",
                   ap.full_name    AS "approved_by",
                   s.closed_reason::text AS "reason",
                   s.state::text   AS "status"
              FROM shift s
              LEFT JOIN staff op ON op.id = s.opened_by
              LEFT JOIN staff cl ON cl.id = s.closed_by
              LEFT JOIN staff ap ON ap.id = s.approved_by
             WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to
             ORDER BY s.business_date DESC, s.segment
            """,
            [C("date", "Date", "date"), C("shift", "Shift", "pill"),
             C("part", "Part", "figure"), C("opened_by", "Opened by"),
             C("closed_by", "Closed by"), C("approved_by", "Approved by"),
             C("reason", "Reason", "pill"), C("status", "Status", "pill")],
            []),
    };

    public IReadOnlyList<StatementMeta> List() =>
        Defs.Where(d => _user.Can(d.Value.Permission))
            .Select(d => new StatementMeta(d.Key, d.Value.Title, d.Value.Purpose,
                                           d.Value.Group, d.Value.NeedsDates))
            .OrderBy(m => m.Group)
            .ThenBy(m => m.Title)
            .ToList();

    public async Task<StatementResult> RunAsync(string key, DateOnly from, DateOnly to,
                                                CancellationToken ct)
    {
        if (!Defs.TryGetValue(key, out var def))
            throw new DomainException("NO_SUCH_STATEMENT",
                $"There is no statement called '{key}'.", 404);

        if (!_user.Can(def.Permission))
            throw new DomainException("NOT_PERMITTED",
                $"{def.Title} needs the {def.Permission} permission.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        var rows = (await conn.QueryAsync(new CommandDefinition(
            def.Sql,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var shaped = rows
            .Select(r => (IDictionary<string, object?>)r)
            .Select(r => r.ToDictionary(kv => kv.Key, kv => kv.Value))
            .ToList();

        // Totals, computed here rather than in every screen. A statement whose
        // columns add up should show the sum; a person checking a printout
        // against a bank slip adds the column anyway.
        var totals = new Dictionary<string, decimal>();
        foreach (var k in def.TotalKeys)
        {
            decimal sum = 0;
            foreach (var r in shaped)
                if (r.TryGetValue(k, out var v) && v is not null &&
                    decimal.TryParse(v.ToString(), out var d))
                    sum += d;
            totals[k] = sum;
        }

        return new StatementResult(
            key, def.Title, def.Purpose,
            def.NeedsDates ? from : null, def.NeedsDates ? to : null,
            def.Columns.ToList(), shaped, totals);
    }
}

public static class StatementEndpoints
{
    public static void MapStatements(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/statements").RequireAuthorization();


        g.MapGet("/{key}", async (string key, DateOnly? from, DateOnly? to,
                                  StatementService s, CancellationToken ct) =>
        {
            var today = DateOnly.FromDateTime(DateTime.Today);
            return Results.Ok(await s.RunAsync(
                key,
                from ?? new DateOnly(today.Year, today.Month, 1),
                to ?? today,
                ct));
        });
    }
}
