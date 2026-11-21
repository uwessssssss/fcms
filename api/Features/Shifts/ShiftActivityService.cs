using Dapper;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Shifts;

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class ActivityItem
{
    public string Kind { get; set; } = "";
    public string Description { get; set; } = "";
    public decimal? Litres { get; set; }
    public decimal? Amount { get; set; }
    public string RecordedBy { get; set; } = "";
    public DateTime At { get; set; }
}

public record ShiftActivity(
    int PumpTests, decimal PumpTestLitres,
    int OwnUseDraws, decimal OwnUseLitres,
    int CreditSales, decimal CreditValue,
    int DrySales, decimal DryValue,
    int Handovers,
    List<ActivityItem> Items);

/// <summary>
/// Everything recorded during a shift, before it closes.
///
/// This exists for one moment: the supervisor standing at the close screen
/// deciding whether they have forgotten something. A pump test that was done
/// and never entered does not announce itself — it silently becomes a stock
/// variance the manager has to explain the next morning. Showing the count
/// beside the close button is the cheapest possible defence against that.
/// </summary>
/// <remarks>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</remarks>
internal sealed class ActivityTotals
{
    public int PumpTests { get; set; }
    public decimal PumpTestLitres { get; set; }
    public int OwnUseDraws { get; set; }
    public decimal OwnUseLitres { get; set; }
    public int CreditSales { get; set; }
    public decimal CreditValue { get; set; }
    public int DrySales { get; set; }
    public decimal DryValue { get; set; }
    public int Handovers { get; set; }
}

public sealed class ShiftActivityService
{
    private readonly IUnitOfWork _uow;

    public ShiftActivityService(IUnitOfWork uow) => _uow = uow;

    public async Task<ShiftActivity> GetAsync(Guid shiftId, CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);

        var totals = await conn.QuerySingleAsync<ActivityTotals>(
            new CommandDefinition(
                """
                SELECT
                  (SELECT count(*)                       FROM pump_test WHERE shift_id = @id) AS PumpTests,
                  (SELECT COALESCE(SUM(measured_litres),0) FROM pump_test WHERE shift_id = @id) AS PumpTestLitres,
                  (SELECT count(*)                       FROM own_use   WHERE shift_id = @id) AS OwnUseDraws,
                  (SELECT COALESCE(SUM(litres),0)        FROM own_use   WHERE shift_id = @id) AS OwnUseLitres,
                  (SELECT count(*)                       FROM credit_sale WHERE shift_id = @id) AS CreditSales,
                  (SELECT COALESCE(SUM(amount),0)        FROM credit_sale WHERE shift_id = @id) AS CreditValue,
                  (SELECT count(*)                       FROM dry_sale  WHERE shift_id = @id) AS DrySales,
                  (SELECT COALESCE(SUM(total_amount),0)  FROM dry_sale  WHERE shift_id = @id) AS DryValue,
                  (SELECT count(*) FROM nozzle_assignment
                    WHERE shift_id = @id AND state = 'HANDED_OVER')                           AS Handovers
                """,
                new { id = shiftId },
                transaction: _uow.Transaction, cancellationToken: ct));

        // One timeline, so a supervisor can read the shift as a story rather
        // than four separate lists.
        var items = (await conn.QueryAsync<ActivityItem>(new CommandDefinition(
            """
            SELECT 'PUMP_TEST' AS Kind,
                   n.code || ' — ' || pt.measured_litres || ' L of a '
                     || pt.can_size_litres || ' L can'
                     || CASE WHEN pt.returned_to_tank THEN ', returned' ELSE ', not returned' END AS Description,
                   pt.measured_litres AS Litres, NULL::numeric AS Amount,
                   s.full_name AS RecordedBy, pt.tested_at AS At
              FROM pump_test pt
              JOIN nozzle n ON n.id = pt.nozzle_id
              JOIN staff s  ON s.id = pt.tested_by
             WHERE pt.shift_id = @id

            UNION ALL
            SELECT 'OWN_USE',
                   ou.purpose || CASE WHEN ou.nozzle_id IS NULL
                                      THEN ' (drawn direct)' ELSE ' (through a pump)' END
                     || COALESCE(' — ' || ou.reference, ''),
                   ou.litres, NULL, s.full_name, ou.recorded_at
              FROM own_use ou JOIN staff s ON s.id = ou.authorised_by
             WHERE ou.shift_id = @id

            UNION ALL
            SELECT 'CREDIT_SALE',
                   cc.name || COALESCE(' · ' || cv.plate_no, '') || ' — ' || cs.litres || ' L',
                   cs.litres, cs.amount, s.full_name, cs.recorded_at
              FROM credit_sale cs
              JOIN credit_customer cc ON cc.id = cs.customer_id
              JOIN staff s ON s.id = COALESCE(cs.attendant_id, cs.staff_id)
              LEFT JOIN credit_vehicle cv ON cv.id = cs.vehicle_id
             WHERE cs.shift_id = @id

            UNION ALL
            SELECT 'DRY_SALE',
                   'Shop sale' || COALESCE(' #' || ds.receipt_no, '') || ' by ' || seller.full_name,
                   NULL, ds.total_amount, rec.full_name, ds.recorded_at
              FROM dry_sale ds
              JOIN staff seller ON seller.id = ds.seller_id
              JOIN staff rec    ON rec.id = ds.recorded_by
             WHERE ds.shift_id = @id

            UNION ALL
            SELECT 'HANDOVER',
                   n.code || ' — ' || outgoing.full_name || ' to ' || incoming.full_name,
                   NULL, NULL, rel.full_name, na.released_at
              FROM nozzle_assignment na
              JOIN nozzle n ON n.id = na.nozzle_id
              JOIN staff outgoing ON outgoing.id = na.attendant_id
              JOIN nozzle_assignment next_a ON next_a.id = na.handed_to_id
              JOIN staff incoming ON incoming.id = next_a.attendant_id
              LEFT JOIN staff rel ON rel.id = na.released_by
             WHERE na.shift_id = @id AND na.state = 'HANDED_OVER'

            ORDER BY At
            """,
            new { id = shiftId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        return new ShiftActivity(
            totals.PumpTests, totals.PumpTestLitres,
            totals.OwnUseDraws, totals.OwnUseLitres,
            totals.CreditSales, totals.CreditValue,
            totals.DrySales, totals.DryValue,
            totals.Handovers, items);
    }
}

public static class ShiftActivityEndpoints
{
    public static void MapShiftActivity(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/shifts/{id:guid}/activity",
            async (Guid id, ShiftActivityService s, CancellationToken ct) =>
                Results.Ok(await s.GetAsync(id, ct)))
           .RequireAuthorization();
    }
}
