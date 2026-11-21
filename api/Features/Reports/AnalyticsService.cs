using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class RevenuePoint
{
    public DateOnly Date { get; set; }
    public string SiteName { get; set; } = "";
    public decimal Revenue { get; set; }
    public decimal Litres { get; set; }
}

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class FuelGradeSlice
{
    public string GradeCode { get; set; } = "";
    public string GradeName { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal Revenue { get; set; }
}

/// <summary>
/// One shift's sales on a business date: what the meters measured at its close.
/// </summary>
/// <remarks>
/// Replaces an "hourly" figure that spread each shift's total evenly across its
/// hours -- a flat line presented as a pattern, read in UTC (three hours off in
/// Kampala), with a night shift past midnight collapsed into one hour. A station
/// that reads meters per shift knows its sales per shift, and no finer.
/// </remarks>
public sealed class ShiftSalesPoint
{
    public Guid ShiftId { get; set; }
    public string Label { get; set; } = "";
    public int Segment { get; set; }
    public string State { get; set; } = "";
    public DateTime OpenedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public decimal Litres { get; set; }
    public decimal Revenue { get; set; }
}

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class NozzleState
{
    public Guid Id { get; set; }
    public string PumpCode { get; set; } = "";
    public string NozzleCode { get; set; } = "";
    public string GradeCode { get; set; } = "";
    public string GradeName { get; set; } = "";
    /// <summary>active | idle</summary>
    public string Status { get; set; } = "";
    public string? AttendantName { get; set; }
    public decimal TodayLitres { get; set; }
    public decimal TodayRevenue { get; set; }
    public DateTime? LastReadingAt { get; set; }
}

public record SiteOperations(
    Guid SiteId,
    string SiteName,
    string Location,
    string Manager,
    bool ShiftOpen,
    string? ShiftLabel,
    DateTime? ShiftOpenedAt,
    string? ShiftOpenedBy,
    decimal TodayRevenue,
    decimal TodayLitres,
    List<NozzleState> Nozzles);

/// <summary>
/// The analytics the charts are drawn from.
///
/// ONE THING THAT NEEDED A DECISION, and it is visible in every figure below:
/// this station has no per-transaction record. There is no till roll, only a
/// meter that moves and a shift that totals it.
///
/// So "hourly sales" cannot mean what it means on a controller-fed forecourt.
/// What it can honestly mean is the litres a shift sold, spread across the
/// hours that shift was open. That is an apportionment, not a measurement, and
/// the endpoint says so in its response rather than letting a smooth curve
/// imply a precision nobody has.
///
/// The alternative -- refusing to draw the chart at all -- was tempting and
/// wrong: a manager comparing a Tuesday with a Saturday gets real information
/// from the shift totals even when the within-shift shape is inferred.
/// </summary>
public sealed class AnalyticsService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public AnalyticsService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    /// <summary>
    /// Passes if the caller holds ANY of the permissions.
    ///
    /// For READING reference data: who works here, what equipment exists, how
    /// the site is doing. Reading was gated by the MANAGE permission, so the
    /// supervisors and managers who open shifts could not load the equipment
    /// or the staff list they roster from, and a supervisor's own dashboard
    /// refused them. Changing that data still needs the manage permission.
    /// </summary>
    private void RequireAny(params string[] permissions)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (!permissions.Any(_user.Can))
            throw new DomainException("FORBIDDEN",
                $"This needs one of: {string.Join(", ", permissions)}.", 403);
    }

    /// <summary>
    /// A station's own operational figures: anyone who reports may read any
    /// station; someone who only runs shifts may read their OWN station. Without
    /// the second half, a supervisor at one station could read another's by
    /// changing the id in the address.
    /// </summary>
    private void RequireSiteView(Guid siteId)
    {
        if (_user.Can("report.view")) return;
        if (_user.Can("shift.open") && siteId == _user.SiteId) return;
        throw new DomainException("FORBIDDEN", "You can see your own station's figures, not another's.", 403);
    }

    private void Require(string permission)
    {
        if (!_user.Can(permission))
            throw new DomainException("NOT_PERMITTED",
                $"This needs the {permission} permission.", 403);
    }

    /// <summary>Revenue by day and site, for the area chart.</summary>
    public async Task<IReadOnlyList<RevenuePoint>> RevenueAsync(int days, CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<RevenuePoint>(new CommandDefinition(
            """
            SELECT sh.business_date              AS "Date",
                   si.name                       AS SiteName,
                   SUM(md.litres * md.unit_price) AS Revenue,
                   SUM(md.litres)                AS Litres
              FROM shift sh
              JOIN site si ON si.id = sh.site_id
              JOIN meter_event me ON me.shift_id = sh.id
              JOIN metered_disposition md
                     ON md.meter_event_id = me.id AND md.kind = 'SALE'
             WHERE sh.business_date > current_date - @days
             GROUP BY sh.business_date, si.name
             ORDER BY sh.business_date
            """,
            new { days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>Litres and value by grade, for the bar chart.</summary>
    public async Task<IReadOnlyList<FuelGradeSlice>> FuelAsync(int days, CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<FuelGradeSlice>(new CommandDefinition(
            """
            SELECT p.code                        AS GradeCode,
                   p.name                        AS GradeName,
                   SUM(md.litres)                AS Litres,
                   SUM(md.litres * md.unit_price) AS Revenue
              FROM metered_disposition md
              JOIN meter_event me ON me.id = md.meter_event_id
              JOIN shift sh       ON sh.id = me.shift_id
              JOIN nozzle n       ON n.id = me.nozzle_id
              JOIN tank t         ON t.id = n.tank_id
              JOIN product p      ON p.id = t.product_id
             WHERE md.kind = 'SALE'
               AND sh.business_date > current_date - @days
             GROUP BY p.code, p.name
             ORDER BY SUM(md.litres) DESC
            """,
            new { days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>Each shift's measured sales on a business date (today's, by default).</summary>
    /// <param name="siteId">The station.</param>
    /// <param name="on">The business date; null means the station's current one.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<IReadOnlyList<ShiftSalesPoint>> ShiftSalesAsync(Guid siteId, DateOnly? on,
        CancellationToken ct)
    {
        RequireSiteView(siteId);
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<ShiftSalesPoint>(new CommandDefinition(
            """
            SELECT sh.id                                        AS ShiftId,
                   sh.label                                     AS Label,
                   sh.segment                                   AS Segment,
                   sh.state::text                               AS State,
                   sh.opened_at                                 AS OpenedAt,
                   sh.closed_at                                 AS ClosedAt,
                   COALESCE(SUM(md.litres), 0)                  AS Litres,
                   COALESCE(SUM(md.litres * md.unit_price), 0)  AS Revenue
              FROM shift sh
              LEFT JOIN meter_event me         ON me.shift_id = sh.id
              LEFT JOIN metered_disposition md ON md.meter_event_id = me.id AND md.kind = 'SALE'
             WHERE sh.site_id = @siteId
               AND sh.state <> 'VOID'
               -- The station's business date (06:00 to 06:00, its own timezone),
               -- not the server's calendar date.
               AND sh.business_date = COALESCE(@on::date, fn_business_date(@siteId, now()))
             GROUP BY sh.id
             ORDER BY sh.opened_at
            """,
            new { siteId, on },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>One site, in detail: its nozzles and what each has sold today.</summary>
    public async Task<SiteOperations> SiteAsync(Guid siteId, CancellationToken ct)
    {
        RequireSiteView(siteId);
        var conn = await _uow.ConnectionAsync(ct);

        var head = await conn.QuerySingleOrDefaultAsync<SiteHead>(new CommandDefinition(
            """
            SELECT si.id           AS SiteId,
                   si.name         AS SiteName,
                   COALESCE(si.address, '') AS Location,
                   COALESCE(m.full_name, '') AS Manager,
                   sh.id           AS ShiftId,
                   sh.label::text  AS ShiftLabel,
                   sh.opened_at    AS ShiftOpenedAt,
                   op.full_name    AS ShiftOpenedBy
              FROM site si
              LEFT JOIN staff m  ON m.id = si.manager_id
              LEFT JOIN shift sh ON sh.site_id = si.id AND sh.state = 'OPEN'
              LEFT JOIN staff op ON op.id = sh.opened_by
             WHERE si.id = @siteId
            """,
            new { siteId },
            transaction: _uow.Transaction, cancellationToken: ct));

        if (head is null)
            throw new DomainException("NO_SUCH_SITE", "There is no site with that id.", 404);

        var nozzles = (await conn.QueryAsync<NozzleState>(new CommandDefinition(
            """
            SELECT n.id             AS Id,
                   pu.code          AS PumpCode,
                   n.code           AS NozzleCode,
                   p.code           AS GradeCode,
                   p.name           AS GradeName,
                   CASE WHEN na.id IS NULL THEN 'idle' ELSE 'active' END AS Status,
                   st.full_name     AS AttendantName,
                   COALESCE(today.litres, 0)  AS TodayLitres,
                   COALESCE(today.revenue, 0) AS TodayRevenue,
                   today.last_at    AS LastReadingAt
              FROM nozzle n
              JOIN pump pu   ON pu.id = n.pump_id
              JOIN tank t    ON t.id = n.tank_id
              JOIN product p ON p.id = t.product_id
              LEFT JOIN nozzle_assignment na
                     ON na.nozzle_id = n.id AND na.state = 'ACTIVE'
                    AND EXISTS (SELECT 1 FROM shift s
                                 WHERE s.id = na.shift_id AND s.state = 'OPEN')
              LEFT JOIN staff st ON st.id = na.attendant_id
              LEFT JOIN (
                SELECT me.nozzle_id,
                       SUM(md.litres)                 AS litres,
                       SUM(md.litres * md.unit_price) AS revenue,
                       -- A meter event carries no time of its own; it is bounded
                       -- by two readings. The closing one is when the nozzle was
                       -- last read, which is what this column means.
                       max(mr.captured_at)            AS last_at
                  FROM meter_event me
                  JOIN metered_disposition md
                         ON md.meter_event_id = me.id AND md.kind = 'SALE'
                  JOIN shift sh ON sh.id = me.shift_id
                  LEFT JOIN meter_reading mr ON mr.id = me.closing_reading_id
                 WHERE sh.business_date = current_date
                 GROUP BY me.nozzle_id
              ) today ON today.nozzle_id = n.id
             WHERE n.site_id = @siteId AND n.is_active
             ORDER BY pu.code, n.code
            """,
            new { siteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        return new SiteOperations(
            head.SiteId, head.SiteName, head.Location, head.Manager,
            head.ShiftId is not null, head.ShiftLabel, head.ShiftOpenedAt, head.ShiftOpenedBy,
            nozzles.Sum(n => n.TodayRevenue),
            nozzles.Sum(n => n.TodayLitres),
            nozzles);
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class SiteHead
    {
        public Guid SiteId { get; set; }
        public string SiteName { get; set; } = "";
        public string Location { get; set; } = "";
        public string Manager { get; set; } = "";
        public Guid? ShiftId { get; set; }
        public string? ShiftLabel { get; set; }
        public DateTime? ShiftOpenedAt { get; set; }
        public string? ShiftOpenedBy { get; set; }
    }
}

public static class AnalyticsEndpoints
{
    public static void MapAnalytics(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1").RequireAuthorization();

        g.MapGet("/analytics/revenue",
            async (int? days, AnalyticsService s, CancellationToken ct) =>
                Results.Ok(await s.RevenueAsync(days ?? 7, ct)));

        g.MapGet("/analytics/fuel",
            async (int? days, AnalyticsService s, CancellationToken ct) =>
                Results.Ok(await s.FuelAsync(days ?? 1, ct)));

        g.MapGet("/sites/{siteId:guid}/analytics/by-shift",
            async (Guid siteId, DateOnly? date, AnalyticsService s, CancellationToken ct) =>
                Results.Ok(await s.ShiftSalesAsync(siteId, date, ct)));

        g.MapGet("/sites/{siteId:guid}/operations",
            async (Guid siteId, AnalyticsService s, CancellationToken ct) =>
                Results.Ok(await s.SiteAsync(siteId, ct)));

    }
}
