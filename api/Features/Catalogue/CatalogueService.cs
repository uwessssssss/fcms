using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Catalogue;

// ---------------------------------------------------------------------------
// Other income
// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class IncomeRow
{
    public Guid Id { get; set; }
    public DateOnly BusinessDate { get; set; }
    public string Site { get; set; } = "";
    public string Category { get; set; } = "";
    public string CategoryCode { get; set; } = "";
    public string Description { get; set; } = "";
    public decimal Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal Amount { get; set; }
    public string Settlement { get; set; } = "";
    public string? Reference { get; set; }
    public string RecordedBy { get; set; } = "";
}

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class IncomeCategoryRow
{
    public Guid Id { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
}

/// <summary>A new line of non-fuel income.</summary>
public record RecordIncome(
    Guid CategoryId, DateOnly BusinessDate, string Description,
    decimal Quantity, decimal UnitPrice, string Settlement, string? Reference);

// ---------------------------------------------------------------------------
// Fuel products
// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class ProductRow
{
    public Guid Id { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal? PumpPrice { get; set; }
    public decimal StockLitres { get; set; }
    public int TankCount { get; set; }
    public bool IsActive { get; set; }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class SettingRow
{
    public string Key { get; set; } = "";
    public string Category { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
    public string Value { get; set; } = "";
    public string Kind { get; set; } = "";
}

/// <summary>
/// What a station sells and how it is configured.
///
/// Three things that share one trait: they are reference data a manager
/// looks up far more often than they change it.
///
/// OTHER INCOME is kept out of every fuel figure on purpose. It carries no
/// litres, and folding it into fuel revenue would make a busy car wash look
/// like a more profitable forecourt per litre than it is.
///
/// SETTINGS are the trading policy, presented as settings. They are not a
/// separate key-value table: a tolerance that lives in `tenant_policy` AND in
/// a settings table has two sources of truth, and the database functions only
/// read one of them.
/// </summary>
public sealed class CatalogueService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public CatalogueService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    private void Require(string permission)
    {
        if (!_user.Can(permission))
            throw new DomainException("NOT_PERMITTED",
                $"This needs the {permission} permission.", 403);
    }

    public async Task<IReadOnlyList<IncomeRow>> IncomeAsync(DateOnly from, DateOnly to,
        CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<IncomeRow>(new CommandDefinition(
            """
            SELECT oi.id            AS Id,
                   oi.business_date AS BusinessDate,
                   si.name          AS Site,
                   ic.name          AS Category,
                   ic.code          AS CategoryCode,
                   oi.description   AS Description,
                   oi.quantity      AS Quantity,
                   oi.unit_price    AS UnitPrice,
                   oi.amount        AS Amount,
                   oi.settlement    AS Settlement,
                   oi.reference     AS Reference,
                   st.full_name     AS RecordedBy
              FROM other_income oi
              JOIN site si            ON si.id = oi.site_id
              JOIN income_category ic ON ic.id = oi.category_id
              JOIN staff st           ON st.id = oi.recorded_by
             WHERE oi.site_id = @site
               AND oi.business_date BETWEEN @from AND @to
             ORDER BY oi.business_date DESC, oi.recorded_at DESC
            """,
            new { site = _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<IncomeCategoryRow>> CategoriesAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<IncomeCategoryRow>(new CommandDefinition(
            """
            SELECT id AS Id, code AS Code, name AS Name
              FROM income_category
             WHERE is_active
             ORDER BY name
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Record non-fuel income.
    ///
    /// The amount is computed here rather than taken from the request, and the
    /// database checks it again. A client that sends quantity 3 at 5,000 and a
    /// total of 12,000 has made an error that should be refused, not silently
    /// corrected -- so the check constraint refuses it, and computing it here
    /// means an honest client never trips that check.
    /// </summary>
    public async Task<Guid> RecordIncomeAsync(RecordIncome req, CancellationToken ct)
    {
        Require("dry_sale.record");

        if (string.IsNullOrWhiteSpace(req.Description))
            throw new DomainException("DESCRIPTION_REQUIRED",
                "Say what the income was for. A line reading only an amount is "
                + "the kind an auditor cannot trace.", 422);

        var settlement = req.Settlement.ToUpperInvariant();
        if (settlement is not ("CASH" or "MOBILE_MONEY" or "CARD" or "ACCOUNT"))
            throw new DomainException("UNKNOWN_SETTLEMENT",
                "Settlement must be CASH, MOBILE_MONEY, CARD or ACCOUNT.", 422);

        var conn = await _uow.ConnectionAsync(ct);

        return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
            """
            INSERT INTO other_income (tenant_id, site_id, category_id, business_date,
                                      description, quantity, unit_price, amount,
                                      settlement, reference, recorded_by)
            VALUES (@tenant, @site, @CategoryId, @BusinessDate,
                    @Description, @Quantity, @UnitPrice, round(@Quantity * @UnitPrice, 2),
                    @settlement, @Reference, @actor)
            RETURNING id
            """,
            new
            {
                tenant = _user.TenantId,
                site = _user.SiteId,
                req.CategoryId, req.BusinessDate, req.Description,
                req.Quantity, req.UnitPrice, settlement, req.Reference,
                actor = _user.StaffId,
            },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    /// <summary>Fuel products, with what is in the ground and the pump price.</summary>
    public async Task<IReadOnlyList<ProductRow>> ProductsAsync(CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<ProductRow>(new CommandDefinition(
            """
            SELECT p.id          AS Id,
                   p.code        AS Code,
                   p.name        AS Name,
                   (SELECT pc.new_price
                      FROM price_change pc
                     WHERE pc.product_id = p.id
                       AND pc.site_id = @site
                       AND pc.status = 'EXECUTED'
                     ORDER BY pc.effective_from DESC
                     LIMIT 1)    AS PumpPrice,
                   COALESCE((SELECT SUM(fn_book_stock(t.id))
                               FROM tank t
                              WHERE t.product_id = p.id AND t.is_active), 0) AS StockLitres,
                   (SELECT count(*) FROM tank t
                     WHERE t.product_id = p.id AND t.is_active)::int      AS TankCount,
                   p.is_active   AS IsActive
              FROM product p
             ORDER BY p.code
            """,
            new { site = _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// The trading policy, presented as settings.
    ///
    /// Read straight from `tenant_policy` -- the same row the variance checks
    /// read -- so a setting shown here is the setting in force. A separate
    /// settings table would be a second source of truth that the database
    /// functions ignore.
    /// </summary>
    public async Task<IReadOnlyList<SettingRow>> SettingsAsync(CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        var p = await conn.QuerySingleOrDefaultAsync<PolicyValues>(new CommandDefinition(
            """
            SELECT shift_variance_pct      AS ShiftVariancePct,
                   shift_variance_litres   AS ShiftVarianceLitres,
                   monthly_variance_pct    AS MonthlyVariancePct,
                   pump_test_tolerance_pct AS PumpTestTolerancePct,
                   water_alarm_mm          AS WaterAlarmMm,
                   water_alarm_litres      AS WaterAlarmLitres
              FROM tenant_policy
            """,
            transaction: _uow.Transaction, cancellationToken: ct));

        if (p is null) return Array.Empty<SettingRow>();

        return new[]
        {
            new SettingRow
            {
                Key = "shift_variance_pct", Category = "Wet stock",
                Label = "Shift variance tolerance",
                Description = "A tank more than this far from the books at shift "
                    + "close raises an exception. Industry practice is 0.5%.",
                Value = p.ShiftVariancePct.ToString("0.##") + "%", Kind = "percent",
            },
            new SettingRow
            {
                Key = "shift_variance_litres", Category = "Wet stock",
                Label = "Shift variance floor",
                Description = "Below this many litres a variance is ignored, "
                    + "because on a small sale a percentage is meaningless.",
                Value = p.ShiftVarianceLitres.ToString("0") + " L", Kind = "litres",
            },
            new SettingRow
            {
                Key = "monthly_variance_pct", Category = "Wet stock",
                Label = "Monthly variance tolerance",
                Description = "The month as a whole. Tighter than the shift "
                    + "figure: daily noise cancels out, a real loss does not.",
                Value = p.MonthlyVariancePct.ToString("0.##") + "%", Kind = "percent",
            },
            new SettingRow
            {
                Key = "pump_test_tolerance_pct", Category = "Calibration",
                Label = "Pump test tolerance",
                Description = "A test can outside this means the pump needs "
                    + "calibrating. Past half a percent it gives fuel away on "
                    + "every fill.",
                Value = p.PumpTestTolerancePct.ToString("0.##") + "%", Kind = "percent",
            },
            new SettingRow
            {
                Key = "water_alarm", Category = "Wet stock",
                Label = "Water alarm",
                Description = "Water in a tank above either figure raises a critical "
                    + "exception at close. The litres figure should be tuned to tank "
                    + "size -- it does not scale the way millimetres do.",
                Value = p.WaterAlarmMm.ToString("0.#") + " mm or "
                    + p.WaterAlarmLitres.ToString("0") + " L",
                Kind = "litres",
            },
        };
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class PolicyValues
    {
        public decimal ShiftVariancePct { get; set; }
        public decimal ShiftVarianceLitres { get; set; }
        public decimal MonthlyVariancePct { get; set; }
        public decimal PumpTestTolerancePct { get; set; }
        public decimal WaterAlarmMm { get; set; }
        public decimal WaterAlarmLitres { get; set; }
    }
}

/// <summary>Routes.</summary>
public static class CatalogueEndpoints
{
    public static void MapCatalogue(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        g.MapGet("/income",
            async (DateOnly? from, DateOnly? to, CatalogueService s, CancellationToken ct) =>
            {
                var today = DateOnly.FromDateTime(DateTime.Today);
                return Results.Ok(await s.IncomeAsync(
                    from ?? new DateOnly(today.Year, today.Month, 1), to ?? today, ct));
            })
         .WithTags("Income").WithSummary("Non-fuel income in a period");

        g.MapGet("/income/categories",
            async (CatalogueService s, CancellationToken ct) =>
                Results.Ok(await s.CategoriesAsync(ct)))
         .WithTags("Income").WithSummary("The kinds of income a company takes");

        g.MapPost("/income",
            async (RecordIncome req, CatalogueService s, CancellationToken ct) =>
                Results.Ok(new { id = await s.RecordIncomeAsync(req, ct) }))
         .WithTags("Income").WithSummary("Record a line of non-fuel income");

        g.MapGet("/products",
            async (CatalogueService s, CancellationToken ct) =>
                Results.Ok(await s.ProductsAsync(ct)))
         .WithTags("Products").WithSummary("Fuel products with stock and pump price");

        g.MapGet("/settings",
            async (CatalogueService s, CancellationToken ct) =>
                Results.Ok(await s.SettingsAsync(ct)))
         .WithTags("Settings").WithSummary("The trading policy in force");
    }
}
