using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class SiteOverviewRow
{
    /// <summary>STATION or DEPOT. The depot screen needs to know which is which.</summary>
    public string Kind { get; set; } = "";
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Location { get; set; } = "";
    public string Manager { get; set; } = "";

    public int PumpsTotal { get; set; }
    public int NozzlesActive { get; set; }
    public int NozzlesIdle { get; set; }

    public decimal? LowestTankPct { get; set; }
    public string? LowestTankGrade { get; set; }

    public decimal TodayRevenue { get; set; }
    public decimal LitresDispensed { get; set; }
    public int AlertCount { get; set; }
    public int CriticalAlerts { get; set; }
    public decimal? AvgTransaction { get; set; }
    public decimal? RevenueTarget { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class AlertRow
{
    /// <summary>
    /// An opaque identifier. Text, not Guid: exception_flag keys on a bigint,
    /// and not every table in this schema uses uuids.
    /// </summary>
    public string Id { get; set; } = "";
    public Guid SiteId { get; set; }
    public string SiteName { get; set; } = "";
    public string Type { get; set; } = "";
    public string Message { get; set; } = "";
    public DateTime RaisedAt { get; set; }
    public bool Acknowledged { get; set; }
}

public record DashboardOverview(
    DateOnly BusinessDate,
    decimal TotalRevenue,
    decimal TotalLitres,
    int SitesReporting,
    int CriticalTankAlerts,
    int PumpsTotal,
    int PumpsActive,
    decimal? RevenueVsYesterdayPct,
    decimal? LitresVsYesterdayPct,
    List<SiteOverviewRow> Sites);

/// <summary>
/// The cross-site overview the dashboard is built against.
///
/// The frontend arrived with this shape declared and mock data filling it, so
/// the contract was not a matter of guesswork -- it is written down in the
/// component. What follows is that shape, served from the real ledger.
///
/// TWO THINGS THE MOCK ASSUMED THAT THIS STATION DOES NOT HAVE, and they are
/// worth naming rather than faking:
///
///   PUMP STATUS. The mock has pumps that are active, idle, faulted or
///   offline, which comes from a live forecourt controller polling the pumps.
///   This system has no controller -- it is built for a station that reads
///   meters by hand. So a nozzle counts as ACTIVE when it is rostered to an
///   attendant on an open shift, and IDLE otherwise. That is honest, and it is
///   the only thing the data can actually say.
///
///   AVERAGE TRANSACTION. That needs a per-transaction record, which a manual
///   station does not produce -- there is no till roll, only a shift total. It
///   is returned as null rather than as a litres-divided-by-a-guess figure,
///   and the card should show a dash.
/// </summary>
public sealed class DashboardService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public DashboardService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    public async Task<DashboardOverview> OverviewAsync(DateOnly? on, CancellationToken ct)
    {
        RequireAny("report.view", "shift.open");
        var date = on ?? DateOnly.FromDateTime(DateTime.Today);
        var conn = await _uow.ConnectionAsync(ct);

        var sites = (await conn.QueryAsync<SiteOverviewRow>(new CommandDefinition(
            """
            WITH today AS (
              SELECT s.site_id,
                     COALESCE(SUM(md.litres), 0)                  AS litres,
                     COALESCE(SUM(round(md.litres * md.unit_price, 2)), 0)  AS revenue
                FROM shift s
                JOIN meter_event me ON me.shift_id = s.id
                JOIN metered_disposition md
                       ON md.meter_event_id = me.id AND md.kind = 'SALE'
               WHERE s.business_date = @date
               GROUP BY s.site_id
            ),
            manned AS (
              -- A nozzle is "active" when somebody is standing at it on an open
              -- shift. Without a forecourt controller that is the only honest
              -- definition available.
              SELECT n.site_id,
                     count(*) FILTER (WHERE na.id IS NOT NULL) AS active,
                     count(*) FILTER (WHERE na.id IS NULL)     AS idle
                FROM nozzle n
                LEFT JOIN nozzle_assignment na
                       ON na.nozzle_id = n.id
                      AND na.state = 'ACTIVE'
                      AND EXISTS (SELECT 1 FROM shift s
                                   WHERE s.id = na.shift_id AND s.state = 'OPEN')
               WHERE n.is_active
               GROUP BY n.site_id
            ),
            lowest AS (
              SELECT DISTINCT ON (t.site_id)
                     t.site_id,
                     round(GREATEST(0, fn_book_stock(t.id) - t.dead_stock)
                           / NULLIF(t.nominal_litres, 0) * 100, 1) AS pct,
                     p.code AS grade
                FROM tank t
                JOIN product p ON p.id = t.product_id
               WHERE t.is_active
               ORDER BY t.site_id,
                        GREATEST(0, fn_book_stock(t.id) - t.dead_stock)
                        / NULLIF(t.nominal_litres, 0)
            ),
            flags AS (
              SELECT site_id,
                     count(*)                                    AS total,
                     count(*) FILTER (WHERE level = 'CRITICAL')  AS critical
                FROM exception_flag
               WHERE resolved_at IS NULL
               GROUP BY site_id
            )
            SELECT si.id            AS Id,
                   si.name          AS Name,
                   si.kind::text    AS Kind,
                   COALESCE(si.address, '')    AS Location,
                   COALESCE(mgr.full_name, '') AS Manager,
                   si.revenue_target           AS RevenueTarget,
                   (SELECT count(*) FROM pump pu WHERE pu.site_id = si.id) AS PumpsTotal,
                   COALESCE(m.active, 0)     AS NozzlesActive,
                   COALESCE(m.idle, 0)       AS NozzlesIdle,
                   l.pct                     AS LowestTankPct,
                   l.grade                   AS LowestTankGrade,
                   COALESCE(t.revenue, 0)    AS TodayRevenue,
                   COALESCE(t.litres, 0)     AS LitresDispensed,
                   COALESCE(f.total, 0)::int AS AlertCount,
                   COALESCE(f.critical, 0)::int AS CriticalAlerts,
                   NULL::numeric             AS AvgTransaction
              FROM site si
              LEFT JOIN today  t ON t.site_id = si.id
              LEFT JOIN manned m ON m.site_id = si.id
              LEFT JOIN lowest l ON l.site_id = si.id
              LEFT JOIN flags  f ON f.site_id = si.id
              -- The NAMED manager, not whichever one the planner reaches first.
              LEFT JOIN staff mgr ON mgr.id = si.manager_id
             -- Trading sites only. A head office sells nothing, so as a card
             -- here it would read as a station with every pump idle.
             WHERE si.kind <> 'HEAD_OFFICE'
             ORDER BY si.name
            """,
            new { date },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        // Yesterday, for the movement figures. A percentage against nothing is
        // not a comparison, so both come back null on a station's first day.
        var prior = await conn.QuerySingleAsync<PriorDay>(new CommandDefinition(
            """
            SELECT COALESCE(SUM(md.litres), 0)                 AS Litres,
                   COALESCE(SUM(round(md.litres * md.unit_price, 2)), 0) AS Revenue
              FROM shift s
              JOIN meter_event me ON me.shift_id = s.id
              JOIN metered_disposition md
                     ON md.meter_event_id = me.id AND md.kind = 'SALE'
             WHERE s.business_date = @date - 1
            """,
            new { date },
            transaction: _uow.Transaction, cancellationToken: ct));

        var revenue = sites.Sum(s => s.TodayRevenue);
        var litres = sites.Sum(s => s.LitresDispensed);

        return new DashboardOverview(
            date,
            revenue,
            litres,
            sites.Count,
            sites.Count(s => s.LowestTankPct is not null and <= 30),
            sites.Sum(s => s.PumpsTotal),
            sites.Count(s => s.NozzlesActive > 0),
            prior.Revenue > 0 ? Math.Round((revenue - prior.Revenue) / prior.Revenue * 100, 1) : null,
            prior.Litres > 0 ? Math.Round((litres - prior.Litres) / prior.Litres * 100, 1) : null,
            sites);
    }

    /// <summary>
    /// The exceptions nobody has answered yet.
    ///
    /// These are not warnings the interface decided to raise -- every one was
    /// raised by the database refusing to let something pass quietly, so the
    /// list is the set of things the station genuinely owes an answer for.
    ///
    /// The message is composed here rather than dumped as key-value pairs. An
    /// earlier version printed the raw jsonb, which put a row like
    /// "amount: 35901 . attendant id: 10000000-0000-..." in front of a
    /// supervisor who needed a name and a number.
    /// </summary>
    public async Task<IReadOnlyList<AlertRow>> AlertsAsync(CancellationToken ct)
    {
        RequireAny("report.view", "shift.open");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<AlertRow>(new CommandDefinition(
            """
            -- AS TEXT, deliberately. exception_flag.id is a bigint, and this
            -- was read into a Guid: every dashboard alert crashed with
            -- "Invalid cast from Int64 to Guid". Text also keeps it safe in
            -- the browser, where a 64-bit id loses precision past 2^53.
            SELECT e.id::text  AS Id,
                   e.site_id   AS SiteId,
                   si.name     AS SiteName,
                   CASE e.level
                     WHEN 'CRITICAL' THEN 'critical'
                     WHEN 'WARN'     THEN 'warning'
                     ELSE 'info'
                   END         AS Type,
                   CASE e.code
                     WHEN 'STOCK_VARIANCE' THEN
                       'Tank stock does not match the books'
                     WHEN 'CASH_SHORT' THEN
                       'Cash short at cash-up'
                     WHEN 'METER_DIVERGENCE' THEN
                       'Electronic and mechanical meters disagree'
                     WHEN 'CREDIT_LIMIT_EXCEEDED' THEN
                       'A credit sale went past the customer limit'
                     WHEN 'ABOVE_SAFE_FILL' THEN
                       'A tank is filled past its safe level'
                     WHEN 'DELIVERY_SHORTFALL' THEN
                       'A delivery brought less than the note said'
                     ELSE replace(initcap(replace(e.code, '_', ' ')), '  ', ' ')
                   END         AS Message,
                   e.raised_at AS RaisedAt,
                   -- There is no acknowledged state in this system: an
                   -- exception is open or it is resolved, and the resolved ones
                   -- are excluded below. A half-state would let somebody make a
                   -- red row go quiet without answering it, which is exactly
                   -- what an exception log exists to prevent.
                   FALSE       AS Acknowledged
              FROM exception_flag e
              JOIN site si ON si.id = e.site_id
             WHERE e.resolved_at IS NULL
             ORDER BY (e.level = 'CRITICAL') DESC, e.raised_at DESC
             LIMIT 50
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

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

    private void Require(string permission)
    {
        if (!_user.Can(permission))
            throw new DomainException("NOT_PERMITTED",
                $"This needs the {permission} permission.", 403);
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class PriorDay
    {
        public decimal Litres { get; set; }
        public decimal Revenue { get; set; }
    }
}

public static class DashboardEndpoints
{
    public static void MapDashboard(this IEndpointRouteBuilder app)
    {
        // The path the frontend already calls, kept exactly.
        app.MapGet("/api/v1/dashboard/overview",
            async (DateOnly? date, DashboardService s, CancellationToken ct) =>
                Results.Ok(await s.OverviewAsync(date, ct)))
           .RequireAuthorization();

        app.MapGet("/api/v1/dashboard/alerts",
            async (DashboardService s, CancellationToken ct) =>
                Results.Ok(await s.AlertsAsync(ct)))
           .RequireAuthorization();
    }
}
