using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class DailyLossRow
{
    public DateOnly BusinessDate { get; set; }
    public string ProductCode { get; set; } = "";
    public string TankCode { get; set; } = "";
    public decimal SoldLitres { get; set; }
    public decimal ReceivedLitres { get; set; }
    public decimal BookLitres { get; set; }
    public decimal ActualLitres { get; set; }
    public decimal LossLitres { get; set; }
    public decimal? LossPct { get; set; }
    public decimal LossValue { get; set; }
    /// <summary>Head office sees every site's tanks: whose this is.</summary>
    public string SiteName { get; set; } = "";
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class CumulativeLossRow
{
    public DateOnly BusinessDate { get; set; }
    public string ProductCode { get; set; } = "";
    public decimal DayLossLitres { get; set; }
    public decimal DayLossValue { get; set; }
    public decimal DaySoldLitres { get; set; }
    public decimal CumulativeLossLitres { get; set; }
    public decimal CumulativeLossValue { get; set; }
    public decimal CumulativeSoldLitres { get; set; }
    public decimal? CumulativeLossPct { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class DivergenceRow
{
    public DateOnly BusinessDate { get; set; }
    public string NozzleLabel { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public decimal MechanicalLitres { get; set; }
    public decimal? ElectronicLitres { get; set; }
    public decimal? DivergenceLitres { get; set; }
    public decimal? DivergencePct { get; set; }
    public string AttendantName { get; set; } = "";
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class LossSummary
{
    /// <summary>The company's monthly loss tolerance, as a percentage of litres sold.</summary>
    public decimal? TolerancePct { get; set; }
    /// <summary>This period lost more than the tolerance allows.</summary>
    public bool OverTolerance { get; set; }
    public string ProductCode { get; set; } = "";
    public decimal TotalSold { get; set; }
    public decimal TotalLoss { get; set; }
    public decimal TotalLossValue { get; set; }
    public decimal? LossPct { get; set; }
    public int DaysWithLoss { get; set; }
    public int DaysMeasured { get; set; }
    public decimal WorstDayLitres { get; set; }
    public DateOnly? WorstDate { get; set; }
}

/// <summary>
/// Stock loss, which is a different question from shift variance.
///
/// Shift variance answers "did tonight balance". Stock loss answers "are we
/// losing diesel", and only the second one costs real money. A station can pass
/// every single shift inside tolerance and still lose four thousand litres a
/// month, because tolerance is applied per shift and the losses accumulate in
/// the same direction. That pattern is invisible unless somebody adds it up.
///
/// So the headline number here is CUMULATIVE, and the daily figures sit
/// underneath it as evidence.
/// </summary>
public sealed class StockLossService
{
    // Head office, auditors, the administrator: every site. It read the user's
    // own site, so for head office every loss report was empty -- and the
    // Losses screen said "the tanks agree with the books".
    private static readonly HashSet<string> CompanyWide =
        new(StringComparer.OrdinalIgnoreCase) { "HEAD_OFFICE", "AUDITOR", "SYSTEM_ADMIN" };

    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public StockLossService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    public async Task<IReadOnlyList<DailyLossRow>> DailyAsync(DateOnly from, DateOnly to,
                                                              CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DailyLossRow>(new CommandDefinition(
            """
            SELECT business_date AS BusinessDate, product_code AS ProductCode,
                   tank_code AS TankCode, sold_litres AS SoldLitres,
                   (SELECT name FROM site WHERE id = v_daily_stock_loss.site_id) AS SiteName,
                   received_litres AS ReceivedLitres, book_litres AS BookLitres,
                   actual_litres AS ActualLitres, loss_litres AS LossLitres,
                   loss_pct AS LossPct, loss_value AS LossValue
              FROM v_daily_stock_loss
             WHERE (@site::uuid IS NULL OR site_id = @site) AND business_date BETWEEN @from AND @to
             ORDER BY business_date DESC, product_code, tank_code
            """,
            new { site = CompanyWide.Contains(_user.Role) ? (Guid?)null : _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<CumulativeLossRow>> CumulativeAsync(DateOnly from,
        DateOnly to, CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<CumulativeLossRow>(new CommandDefinition(
            """
            SELECT business_date AS BusinessDate, product_code AS ProductCode,
                   day_loss_litres AS DayLossLitres, day_loss_value AS DayLossValue,
                   day_sold_litres AS DaySoldLitres,
                   cumulative_loss_litres AS CumulativeLossLitres,
                   cumulative_loss_value AS CumulativeLossValue,
                   cumulative_sold_litres AS CumulativeSoldLitres,
                   cumulative_loss_pct AS CumulativeLossPct
              FROM v_cumulative_stock_loss
             WHERE (@site::uuid IS NULL OR site_id = @site) AND business_date BETWEEN @from AND @to
             ORDER BY product_code, business_date
            """,
            new { site = CompanyWide.Contains(_user.Role) ? (Guid?)null : _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// One line per product for the period.
    ///
    /// `DaysWithLoss` against `DaysMeasured` is the figure that separates a
    /// leak from bad dipping. Losing on twenty-eight days out of thirty is a
    /// hole in the ground; losing on four is somebody misreading a stick.
    /// </summary>
    public async Task<IReadOnlyList<LossSummary>> SummaryAsync(DateOnly from, DateOnly to,
                                                               CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<LossSummary>(new CommandDefinition(
            """
            WITH per_day AS (
              SELECT product_code, business_date,
                     SUM(sold_litres) AS sold,
                     SUM(loss_litres) AS loss,
                     SUM(loss_value)  AS value
                FROM v_daily_stock_loss
               WHERE (@site::uuid IS NULL OR site_id = @site) AND business_date BETWEEN @from AND @to
               GROUP BY product_code, business_date
            ), worst AS (
              SELECT DISTINCT ON (product_code) product_code, business_date, loss
                FROM per_day ORDER BY product_code, loss ASC
            )
            SELECT d.product_code                       AS ProductCode,
                   SUM(d.sold)                          AS TotalSold,
                   SUM(d.loss)                          AS TotalLoss,
                   SUM(d.value)                         AS TotalLossValue,
                   CASE WHEN SUM(d.sold) > 0
                        THEN round(SUM(d.loss) / SUM(d.sold) * 100, 4) END AS LossPct,
                   count(*) FILTER (WHERE d.loss < 0)   AS DaysWithLoss,
                   count(*)                             AS DaysMeasured,
                   w.loss                               AS WorstDayLitres,
                   w.business_date                      AS WorstDate,
                   -- The company's monthly tolerance (it was a setting nothing
                   -- read), and whether this period's loss is beyond it.
                   (SELECT tp.monthly_variance_pct FROM tenant_policy tp
                      JOIN site si ON si.tenant_id = tp.tenant_id
                     WHERE si.id = @site)                AS TolerancePct,
                   COALESCE(SUM(d.sold) > 0
                     AND SUM(d.loss) / SUM(d.sold) * 100 <
                         -(SELECT tp.monthly_variance_pct FROM tenant_policy tp
                             JOIN site si ON si.tenant_id = tp.tenant_id
                            WHERE si.id = @site), false)  AS OverTolerance
              FROM per_day d
              LEFT JOIN worst w ON w.product_code = d.product_code
             GROUP BY d.product_code, w.loss, w.business_date
             ORDER BY d.product_code
            """,
            new { site = CompanyWide.Contains(_user.Role) ? (Guid?)null : _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<DivergenceRow>> DivergenceAsync(DateOnly from,
        DateOnly to, CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DivergenceRow>(new CommandDefinition(
            """
            SELECT business_date AS BusinessDate, nozzle_label AS NozzleLabel,
                   product_code AS ProductCode, mechanical_litres AS MechanicalLitres,
                   electronic_litres AS ElectronicLitres,
                   divergence_litres AS DivergenceLitres,
                   divergence_pct AS DivergencePct,
                   attendant_name AS AttendantName
              FROM v_meter_divergence
             WHERE (@site::uuid IS NULL OR site_id = @site) AND business_date BETWEEN @from AND @to
               AND electronic_litres IS NOT NULL
             ORDER BY abs(COALESCE(divergence_pct, 0)) DESC, business_date DESC
             LIMIT 200
            """,
            new { site = CompanyWide.Contains(_user.Role) ? (Guid?)null : _user.SiteId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }
}

public static class StockLossEndpoints
{
    public static void MapStockLoss(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/reports/loss").RequireAuthorization();

        g.MapGet("/daily", async (DateOnly from, DateOnly to, StockLossService s,
                                  CancellationToken ct) =>
            Results.Ok(await s.DailyAsync(from, to, ct)));

        g.MapGet("/cumulative", async (DateOnly from, DateOnly to, StockLossService s,
                                       CancellationToken ct) =>
            Results.Ok(await s.CumulativeAsync(from, to, ct)));

        g.MapGet("/summary", async (DateOnly from, DateOnly to, StockLossService s,
                                    CancellationToken ct) =>
            Results.Ok(await s.SummaryAsync(from, to, ct)));

        g.MapGet("/divergence", async (DateOnly from, DateOnly to, StockLossService s,
                                       CancellationToken ct) =>
            Results.Ok(await s.DivergenceAsync(from, to, ct)));
    }
}
