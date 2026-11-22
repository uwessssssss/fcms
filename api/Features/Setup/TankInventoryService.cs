using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Setup;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class TankInventoryRow
{
    public Guid Id { get; set; }
    public string Site { get; set; } = "";
    public string Grade { get; set; } = "";
    public string GradeCode { get; set; } = "";
    public string Code { get; set; } = "";

    public decimal CapacityLitres { get; set; }
    public decimal SafeFill { get; set; }
    public decimal DeadStock { get; set; }
    public decimal CurrentLitres { get; set; }
    public decimal? WaterLitres { get; set; }
    public decimal FillPct { get; set; }

    /// <summary>normal | low | critical | replenishing</summary>
    public string Status { get; set; } = "normal";

    public decimal? DrawRateLph { get; set; }
    public decimal? HoursToEmpty { get; set; }

    public DateTime? LastDelivery { get; set; }
    public DateTime? LastDipped { get; set; }
}

/// <summary>
/// Every tank, with enough to decide whether to order fuel.
///
/// THE DRAW RATE IS AN AVERAGE, and the name says litres per hour, so it is
/// worth being exact about what it means: a fortnight of sales divided by the
/// trading hours in a fortnight. It is not an instantaneous rate -- that needs
/// a gauge polling the tank, which this station does not have.
///
/// The difference matters on a forecourt. A tank selling 300 litres an hour
/// through a Friday afternoon and nothing overnight has the same daily average
/// as one selling steadily, and only one of them runs dry before the morning.
/// So the hours-to-empty figure is honest about being a planning number, not a
/// countdown.
///
/// STATUS follows the industry bands, with one addition: a tank that took a
/// delivery today is REPLENISHING rather than low, however little is in it.
/// Colouring a delivery in progress as an alarm is how an operator learns to
/// ignore the colour.
/// </summary>
public sealed class TankInventoryService
{
    private static readonly HashSet<string> CompanyWide =
        new(StringComparer.OrdinalIgnoreCase) { "HEAD_OFFICE", "AUDITOR", "SYSTEM_ADMIN" };

    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public TankInventoryService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    public async Task<IReadOnlyList<TankInventoryRow>> ListAsync(CancellationToken ct)
    {
        if (!_user.Can("report.view") && !_user.Can("dip.record"))
            throw new DomainException("NOT_PERMITTED",
                "Tank inventory needs the report.view or dip.record permission.", 403);

        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<TankInventoryRow>(new CommandDefinition(
            """
            WITH latest_dip AS (
              SELECT DISTINCT ON (tank_id) tank_id, product_litres, water_litres, captured_at
                FROM dip_reading
               ORDER BY tank_id, captured_at DESC
            ),
            last_delivery AS (
              SELECT dl.tank_id, max(d.decant_ended_at) AS at
                FROM delivery_line dl
                JOIN delivery d ON d.id = dl.delivery_id
               WHERE d.decant_ended_at IS NOT NULL
               GROUP BY dl.tank_id
            ),
            throughput AS (
              -- A fortnight of sales, and the DAYS THAT ACTUALLY TRADED. A tank
              -- on a site that was shut for a week would otherwise look half as
              -- busy as it is.
              SELECT n.tank_id,
                     SUM(md.litres)                       AS litres,
                     count(DISTINCT sh.business_date)     AS trading_days
                FROM metered_disposition md
                JOIN meter_event me ON me.id = md.meter_event_id
                JOIN nozzle n       ON n.id = me.nozzle_id
                JOIN shift sh       ON sh.id = me.shift_id
               WHERE md.kind = 'SALE'
                 AND sh.business_date > current_date - 14
               GROUP BY n.tank_id
            )
            SELECT t.id                       AS Id,
                   si.name                    AS Site,
                   p.name                     AS Grade,
                   p.code                     AS GradeCode,
                   t.code                     AS Code,
                   t.nominal_litres           AS CapacityLitres,
                   t.safe_fill                AS SafeFill,
                   t.dead_stock               AS DeadStock,
                   COALESCE(d.product_litres, fn_book_stock(t.id)) AS CurrentLitres,
                   d.water_litres             AS WaterLitres,
                   round(COALESCE(d.product_litres, fn_book_stock(t.id))
                         / NULLIF(t.nominal_litres, 0) * 100, 1) AS FillPct,

                   CASE
                     -- Took fuel today: being filled, not running out.
                     WHEN ld.at::date = current_date THEN 'replenishing'
                     WHEN COALESCE(d.product_litres, fn_book_stock(t.id))
                          / NULLIF(t.nominal_litres, 0) <= 0.15 THEN 'critical'
                     WHEN COALESCE(d.product_litres, fn_book_stock(t.id))
                          / NULLIF(t.nominal_litres, 0) <= 0.30 THEN 'low'
                     ELSE 'normal'
                   END                        AS Status,

                   -- Litres an hour, over the hours the station actually traded.
                   CASE WHEN tp.trading_days > 0
                        THEN round(tp.litres / (tp.trading_days * 24.0), 1)
                   END                        AS DrawRateLph,

                   CASE WHEN tp.trading_days > 0 AND tp.litres > 0
                        THEN round(
                               GREATEST(0, COALESCE(d.product_litres, fn_book_stock(t.id))
                                           - t.dead_stock)
                               / (tp.litres / (tp.trading_days * 24.0)), 1)
                   END                        AS HoursToEmpty,

                   ld.at                      AS LastDelivery,
                   d.captured_at              AS LastDipped
              FROM tank t
              JOIN site si    ON si.id = t.site_id
              JOIN product p  ON p.id = t.product_id
              LEFT JOIN latest_dip d    ON d.tank_id = t.id
              LEFT JOIN last_delivery ld ON ld.tank_id = t.id
              LEFT JOIN throughput tp    ON tp.tank_id = t.id
             WHERE t.is_active
               -- A station's own tanks; head office every site's. Station staff
               -- were sent every station's stock and screens filtered it after.
               AND (@site::uuid IS NULL OR t.site_id = @site)
             ORDER BY si.name, t.code
            """,
            new { site = CompanyWide.Contains(_user.Role) ? (Guid?)null : _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }
}

public static class TankInventoryEndpoints
{
    public static void MapTankInventory(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/inventory/tanks",
            async (TankInventoryService s, CancellationToken ct) =>
                Results.Ok(await s.ListAsync(ct)))
           .RequireAuthorization();
    }
}
