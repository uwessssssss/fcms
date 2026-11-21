using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Accounts;


public record RecordExpense(DateOnly BusinessDate, string Category, string Description,
    decimal Amount, string PaidFrom, string? Reference, Guid? SupplierId,
    string? ReceiptUrl);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class SupplierBalanceRow
{
    public Guid SupplierId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal Billed { get; set; }
    public decimal Paid { get; set; }
    public decimal Balance { get; set; }
    public DateOnly? OldestInvoice { get; set; }
    public DateOnly? EarliestDue { get; set; }
    public bool Overdue { get; set; }
}

public record RecordInvoice(Guid SupplierId, string InvoiceNo, DateOnly InvoiceDate,
    DateOnly? DueDate, decimal Amount, string? Notes, List<Guid>? DeliveryIds);

public record RecordSupplierPayment(Guid SupplierId, Guid? InvoiceId, decimal Amount,
    string Method, string? Reference, DateOnly PaidOn);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class CategoryTotal
{
    public string Category { get; set; } = "";
    public decimal Amount { get; set; }
    public decimal FromTill { get; set; }
    public int Entries { get; set; }
}

public record ProfitStatement(
    DateOnly From, DateOnly To,
    decimal FuelRevenue, decimal FuelCost, decimal FuelMargin,
    decimal ShopRevenue, decimal ShopCost, decimal ShopMargin,
    decimal GrossMargin,
    decimal Expenses, decimal ExpensesFromTill,
    decimal StockLossValue,
    decimal ShortagesRaised, decimal ShortagesRecovered,
    decimal DiscountsGiven,
    decimal OwnUseLitres, decimal OwnUseCost,
    decimal NetPosition,
    List<CategoryTotal> ExpenseBreakdown,
    decimal TransitLossValue,
    decimal UncostedFuelLitres);

/// <summary>
/// What the station actually made, after what it spent.
///
/// Gross margin is the number every fuel system reports and it is not a profit:
/// a station with a healthy margin and an unpaid power bill is not doing well,
/// it just has not been told yet.
///
/// The statement below is deliberately NOT a general ledger. It is the handful
/// of lines a dealer can hold in their head -- what we sold, what it cost, what
/// we spent, what leaked away -- and every figure traces to records the station
/// already keeps. A chart of accounts nobody maintains produces reports nobody
/// trusts.
/// </summary>
public sealed class AccountsService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public AccountsService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly HashSet<string> Categories = new(StringComparer.OrdinalIgnoreCase)
    {
        "WAGES","POWER","WATER","SECURITY","REPAIRS","MAINTENANCE","TRANSPORT",
        "LICENCES","RENT","CONSUMABLES","BANK_CHARGES","OTHER"
    };
    private static readonly HashSet<string> PaidFrom = new(StringComparer.OrdinalIgnoreCase)
        { "TILL_CASH","BANK","MOBILE_MONEY","CREDIT" };

    // === EXPENSES ============================================================


    public async Task<Guid> RecordExpenseAsync(RecordExpense r, CancellationToken ct)
    {
        Require("banking.record");

        if (!Categories.Contains(r.Category))
            throw new DomainException("INVALID_CATEGORY",
                $"'{r.Category}' is not an expense category.");
        if (!PaidFrom.Contains(r.PaidFrom))
            throw new DomainException("INVALID_SOURCE",
                $"'{r.PaidFrom}' is not a way of paying.");
        if (r.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "An expense must be more than zero.");
        if ((r.Description ?? "").Trim().Length < 3)
            throw new DomainException("DESCRIPTION_REQUIRED",
                "Say what the money was for. \"Misc\" is how a month of small "
                + "payments becomes unexplainable.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO expense (tenant_id, site_id, business_date, category,
                                     description, amount, currency, paid_from,
                                     reference, supplier_id, receipt_url, recorded_by)
                SELECT @tenant, @site, @date, @category::expense_category,
                       @description, @amount, t.base_currency, @paidFrom,
                       @reference, @supplier, @receipt, @actor
                  FROM tenant t WHERE t.id = @tenant
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, date = r.BusinessDate,
                    category = r.Category.ToUpperInvariant(),
                    description = r.Description!.Trim(), amount = r.Amount,
                    paidFrom = r.PaidFrom.ToUpperInvariant(), reference = r.Reference,
                    supplier = r.SupplierId, receipt = r.ReceiptUrl, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task ApproveExpenseAsync(Guid id, CancellationToken ct)
    {
        Require("shortage.approve");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var n = await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE expense SET approved_by = @actor, approved_at = now() " +
                " WHERE id = @id AND approved_by IS NULL",
                new { id, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
            if (n == 0)
                throw new DomainException("ALREADY_APPROVED",
                    "That expense has already been signed off.", 409);
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === PAYABLES ============================================================

    public async Task<IReadOnlyList<SupplierBalanceRow>> SuppliersAsync(CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<SupplierBalanceRow>(new CommandDefinition(
            """
            SELECT supplier_id AS SupplierId, code AS Code, name AS Name,
                   billed AS Billed, paid AS Paid, balance AS Balance,
                   oldest_invoice AS OldestInvoice, earliest_due AS EarliestDue,
                   overdue AS Overdue
              FROM v_supplier_balance
             ORDER BY balance DESC, name
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> RecordInvoiceAsync(RecordInvoice r, CancellationToken ct)
    {
        Require("banking.record");
        if (r.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "An invoice must be more than zero.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO supplier_invoice (tenant_id, site_id, supplier_id, invoice_no,
                                              invoice_date, due_date, amount, currency,
                                              notes, recorded_by)
                SELECT @tenant, @site, @supplier, @invoiceNo, @invoiceDate, @dueDate,
                       @amount, t.base_currency, @notes, @actor
                  FROM tenant t WHERE t.id = @tenant
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, supplier = r.SupplierId,
                    invoiceNo = r.InvoiceNo.Trim(), invoiceDate = r.InvoiceDate,
                    dueDate = r.DueDate, amount = r.Amount, notes = r.Notes,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            foreach (var deliveryId in r.DeliveryIds ?? new List<Guid>())
                await conn.ExecuteAsync(new CommandDefinition(
                    "INSERT INTO supplier_invoice_delivery (invoice_id, delivery_id) " +
                    "VALUES (@invoice, @delivery) ON CONFLICT DO NOTHING",
                    new { invoice = id, delivery = deliveryId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> RecordSupplierPaymentAsync(RecordSupplierPayment r,
                                                       CancellationToken ct)
    {
        Require("banking.record");
        if (r.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "A payment must be more than zero.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO supplier_payment (tenant_id, site_id, supplier_id, invoice_id,
                                              amount, currency, method, reference,
                                              paid_on, recorded_by)
                SELECT @tenant, @site, @supplier, @invoice, @amount, t.base_currency,
                       @method, @reference, @paidOn, @actor
                  FROM tenant t WHERE t.id = @tenant
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, supplier = r.SupplierId,
                    invoice = r.InvoiceId, amount = r.Amount,
                    method = r.Method.ToUpperInvariant(), reference = r.Reference,
                    paidOn = r.PaidOn, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === THE STATEMENT =======================================================

    /// <summary>
    /// A period statement a dealer can actually read.
    ///
    /// Stock loss is subtracted, not shown alongside: fuel that leaked was paid
    /// for and never sold, so it is a cost of the period whether or not anyone
    /// wrote a cheque for it. Leaving it out of the bottom line is the single
    /// most common way a forecourt overstates its profit.
    ///
    /// Shortages are shown raised AND recovered, because only the difference is
    /// a real loss -- and reporting the raised figure alone punishes a station
    /// that chases its money.
    /// </summary>
    public async Task<ProfitStatement> StatementAsync(DateOnly from, DateOnly to,
                                                      CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        var fuel = await conn.QuerySingleAsync<FuelPeriod>(new CommandDefinition(
            """
            WITH sold AS (
              SELECT me.tank_id, s.business_date, SUM(md.litres) AS litres,
                     SUM(md.litres * md.unit_price) AS revenue
                FROM meter_event me
                JOIN metered_disposition md
                  ON md.meter_event_id = me.id AND md.kind = 'SALE'
                JOIN shift s ON s.id = me.shift_id
               WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to
               GROUP BY me.tank_id, s.business_date
            )
            -- Each tank-day at its moving average as that day ended (380), the
            -- same basis as the depot-against-station report. This costed the
            -- whole period at today's average: a delivery this morning rewrote
            -- what last month's sales cost.
            -- Litres with NO cost basis are counted apart, not costed at 0 --
            -- costing them at nothing reported their whole price as margin.
            SELECT COALESCE(SUM(revenue), 0)                          AS Revenue,
                   COALESCE(SUM(litres * c.avg), 0)                   AS Cost,
                   COALESCE(SUM(litres) FILTER (WHERE c.avg IS NULL), 0) AS UncostedLitres
              FROM sold
              CROSS JOIN LATERAL (SELECT fn_weighted_avg_cost(tank_id,
                                    (business_date + 1)::timestamptz) AS avg) c
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        var shop = await conn.QuerySingleAsync<ShopPeriod>(new CommandDefinition(
            """
            -- Each item-DAY at its moving average at THIS station as that day
            -- ended (390) -- the same basis as fuel. This took the latest
            -- purchase price ever recorded, at any station: a price rise today
            -- re-costed last month, and one station priced another's sales.
            SELECT COALESCE(SUM(revenue), 0) AS Revenue,
                   COALESCE(SUM(qty * COALESCE(
                     fn_dry_avg_cost(item_id, @site, (business_date + 1)::timestamptz), 0)), 0) AS Cost
              FROM (
                SELECT dsl.item_id, s.business_date,
                       SUM(dsl.qty) AS qty, SUM(dsl.line_amount) AS revenue
                  FROM dry_sale ds
                  JOIN dry_sale_line dsl ON dsl.sale_id = ds.id
                  JOIN shift s ON s.id = ds.shift_id
                 WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to
                 GROUP BY dsl.item_id, s.business_date) d
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        // Fuel the business burned itself: the generator, the pickup, the
        // grounds tank. It reduces stock legitimately, so it is not a loss --
        // but it was bought and never sold, and until now its cost was charged
        // nowhere at all. A station running a generator through a power cut
        // was quietly understating its costs by exactly that much.
        var ownUse = await conn.QuerySingleAsync<OwnUsePeriod>(new CommandDefinition(
            """
            SELECT COALESCE(SUM(litres), 0) AS Litres,
                   COALESCE(SUM(litres * COALESCE(
                     fn_weighted_avg_cost(tank_id, (business_date + 1)::timestamptz), 0)), 0) AS Cost
              FROM (
                SELECT ou.tank_id, s.business_date, SUM(ou.litres) AS litres
                  FROM own_use ou
                  JOIN shift s ON s.id = ou.shift_id
                 WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to
                 GROUP BY ou.tank_id, s.business_date) d
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        var breakdown = (await conn.QueryAsync<CategoryTotal>(new CommandDefinition(
            """
            SELECT category AS Category, SUM(amount) AS Amount,
                   COALESCE(SUM(from_till), 0) AS FromTill, SUM(entries)::int AS Entries
              FROM v_daily_expense
             WHERE site_id = @site AND business_date BETWEEN @from AND @to
             GROUP BY category ORDER BY SUM(amount) DESC
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var other = await conn.QuerySingleAsync<OtherPeriod>(new CommandDefinition(
            """
            SELECT
              (SELECT COALESCE(SUM(loss_value), 0) FROM v_daily_stock_loss
                WHERE site_id = @site AND business_date BETWEEN @from AND @to) AS StockLossValue,
              (SELECT COALESCE(SUM(ss.amount), 0) FROM staff_shortage ss
                 JOIN shift s ON s.id = ss.shift_id
                WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to)
                                                                       AS ShortagesRaised,
              -- THIS station's recoveries, and only money actually got back.
              -- It had no site filter -- every station's statement counted the
              -- whole company's repayments -- and it counted WRITE-OFFS, money
              -- given up on, as recovered: net overstated by every write-off.
              (SELECT COALESCE(SUM(sr.amount), 0) FROM shortage_recovery sr
                 JOIN staff st ON st.id = sr.staff_id
                WHERE st.site_id = @site
                  AND sr.method <> 'WRITE_OFF'
                  AND fn_business_date(st.site_id, sr.recovered_at) BETWEEN @from AND @to)
                                                                       AS ShortagesRecovered,
              (SELECT COALESCE(SUM(dg.amount), 0) FROM discount_grant dg
                 JOIN shift s ON s.id = dg.shift_id
                WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to)
              -- (600) Credit billed at an agreed price: below the pump it is
              -- revenue given up, like a discount; a credit premium above the
              -- pump is revenue earned, and reduces this figure.
            + (SELECT COALESCE(SUM(round(cs.litres * cs.pump_price, 2) - cs.amount), 0) FROM credit_sale cs
                 JOIN shift s ON s.id = cs.shift_id
                WHERE s.site_id = @site AND s.business_date BETWEEN @from AND @to
                  AND cs.customer_price_id IS NOT NULL)
                                                                       AS DiscountsGiven,
              -- Fuel PAID FOR and never received. The supplier bills the
              -- note's litres; the book takes in the dipped litres at the
              -- invoice price per litre -- so the shortfall's money fell out
              -- of the statement entirely: not in cost of sales, not a loss.
              -- A short load, claimed or not, is a cost until it is recovered.
              (SELECT COALESCE(SUM(GREATEST(dl.loaded_litres - dl.received_litres, 0)
                                   * COALESCE(dl.unit_cost, 0)), 0)
                 FROM delivery_line dl
                 JOIN delivery d ON d.id = dl.delivery_id
                 JOIN shift s    ON s.id = d.decant_shift_id
                WHERE d.site_id = @site AND d.status = 'RECEIVED'
                  AND dl.received_litres IS NOT NULL
                  AND s.business_date BETWEEN @from AND @to)       AS TransitLossValue
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        var expenses = breakdown.Sum(b => b.Amount);
        var fromTill = breakdown.Sum(b => b.FromTill);
        var fuelMargin = fuel.Revenue - fuel.Cost;
        var shopMargin = shop.Revenue - shop.Cost;
        var gross = fuelMargin + shopMargin;

        // DISCOUNTS COME OFF. This was wrong, and wrong in the direction that
        // flatters: revenue is litres times the SHIFT price, gross of any
        // discount, because that is what the meter dispensed at. The discount
        // is a settlement line in the cash-up -- money the station agreed not
        // to receive. Counting the full price as revenue and never subtracting
        // it overstated margin by every shilling given away, and the screen
        // said the opposite out loud.
        //
        // Stock loss is already negative when fuel went missing, so adding it
        // subtracts. Unrecovered shortage is a real loss; recovered is not.
        var net = gross
                  - other.DiscountsGiven
                  - ownUse.Cost
                  + other.StockLossValue
                  - expenses
                  - (other.ShortagesRaised - other.ShortagesRecovered)
                  - other.TransitLossValue;

        return new ProfitStatement(
            from, to,
            fuel.Revenue, fuel.Cost, fuelMargin,
            shop.Revenue, shop.Cost, shopMargin,
            gross,
            expenses, fromTill,
            other.StockLossValue,
            other.ShortagesRaised, other.ShortagesRecovered,
            other.DiscountsGiven,
            ownUse.Litres, ownUse.Cost,
            net,
            breakdown,
            other.TransitLossValue,
            fuel.UncostedLitres);
    }

    internal sealed class FuelPeriod
    {
        public decimal Revenue { get; set; }
        public decimal Cost { get; set; }
        public decimal UncostedLitres { get; set; }
    }
    internal sealed class ShopPeriod
    {
        public decimal Revenue { get; set; }
        public decimal Cost { get; set; }
    }
    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class OwnUsePeriod
    {
        public decimal Litres { get; set; }
        public decimal Cost { get; set; }
    }

    internal sealed class OtherPeriod
    {
        public decimal StockLossValue { get; set; }
        public decimal ShortagesRaised { get; set; }
        public decimal ShortagesRecovered { get; set; }
        public decimal DiscountsGiven { get; set; }
        public decimal TransitLossValue { get; set; }
    }

    private void Require(string permission)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (!_user.Can(permission))
            throw new DomainException("FORBIDDEN",
                string.IsNullOrEmpty(_user.Role)
                    ? "Your session does not carry a role, so nothing can be authorised."
                    : $"A {_user.Role.ToLowerInvariant()} cannot do that.", 403);
    }
}

public static class AccountsEndpoints
{
    public static void MapAccounts(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/accounts").RequireAuthorization();


        g.MapPost("/expenses", async (RecordExpense r, AccountsService s, CancellationToken ct) =>
            Results.Ok(new { expenseId = await s.RecordExpenseAsync(r, ct) }));

        g.MapPost("/expenses/{id:guid}/approve", async (Guid id, AccountsService s,
                                                        CancellationToken ct) =>
        {
            await s.ApproveExpenseAsync(id, ct);
            return Results.Ok(new { approved = true });
        });

        g.MapGet("/suppliers", async (AccountsService s, CancellationToken ct) =>
            Results.Ok(await s.SuppliersAsync(ct)));

        g.MapPost("/invoices", async (RecordInvoice r, AccountsService s, CancellationToken ct) =>
            Results.Ok(new { invoiceId = await s.RecordInvoiceAsync(r, ct) }));

        g.MapPost("/supplier-payments", async (RecordSupplierPayment r, AccountsService s,
                                               CancellationToken ct) =>
            Results.Ok(new { paymentId = await s.RecordSupplierPaymentAsync(r, ct) }));

        g.MapGet("/statement", async (DateOnly from, DateOnly to, AccountsService s,
                                      CancellationToken ct) =>
            Results.Ok(await s.StatementAsync(from, to, ct)));
    }
}
