using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Shifts;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class ShiftPriceRow
{
    public string ProductCode { get; set; } = "";
    public decimal UnitPrice { get; set; }
}

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class ReturnToTankRow
{
    public Guid Id { get; set; }
    public Guid NozzleId { get; set; }
    public string NozzleLabel { get; set; } = "";
    public decimal Litres { get; set; }
    public string Reason { get; set; } = "";
    public string RecordedBy { get; set; } = "";
    public string? WitnessedBy { get; set; }
    public DateTime RecordedAt { get; set; }
}

public record ClosureContext(List<ShiftPriceRow> Prices, List<ReturnToTankRow> Returns);

/// <summary>A return to tank, recorded against a nozzle on an open shift.</summary>
/// <param name="NozzleId">The nozzle the fuel went through.</param>
/// <param name="Litres">How much came back. Must be positive.</param>
/// <param name="Reason">Why. Required, at least five characters.</param>
/// <param name="WitnessedBy">Optional second person who saw it poured back.</param>
public record RecordReturn(Guid NozzleId, decimal Litres, string Reason, Guid? WitnessedBy);

/// <summary>
/// What the close screen needs that the shift detail does not carry.
///
/// PRICES, per grade. The screen used to multiply every litre by one hardcoded
/// figure -- 5,150, "avg price" -- across petrol and diesel alike, so a
/// diesel-heavy shift and a petrol-heavy shift were charged at the same rate
/// and a price change reached nothing. These come from fn_shift_price, the
/// same function the close itself calls, so the screen and the close cannot
/// disagree about what a litre cost.
///
/// RETURNS TO TANK, per nozzle. They reduce what the attendant owes, so they
/// have to be visible on the screen where that is being worked out.
///
/// Neither of these makes the browser authoritative. The figure an attendant is
/// held to comes from close-preview, which runs the real close and rolls it
/// back. This is what lets the screen show sensible running totals while the
/// supervisor is still typing.
/// </summary>
public sealed class ShiftClosureService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public ShiftClosureService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    public async Task<ClosureContext> ContextAsync(Guid shiftId, CancellationToken ct)
    {
        if (!_user.Can("shift.close") && !_user.Can("report.view"))
            throw new DomainException("NOT_PERMITTED",
                "Reading a shift's closure needs shift.close or report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);

        var prices = (await conn.QueryAsync<ShiftPriceRow>(new CommandDefinition(
            """
            SELECT p.code                          AS ProductCode,
                   fn_shift_price(@shiftId, p.id)  AS UnitPrice
              FROM product p
             WHERE EXISTS (SELECT 1 FROM tank t
                            JOIN shift s ON s.site_id = t.site_id
                           WHERE s.id = @shiftId AND t.product_id = p.id AND t.is_active)
             ORDER BY p.code
            """,
            new { shiftId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var returns = (await conn.QueryAsync<ReturnToTankRow>(new CommandDefinition(
            """
            SELECT r.id                       AS Id,
                   r.nozzle_id                AS NozzleId,
                   pu.code || '/' || n.code   AS NozzleLabel,
                   r.litres                   AS Litres,
                   r.reason                   AS Reason,
                   rb.full_name               AS RecordedBy,
                   wb.full_name               AS WitnessedBy,
                   r.recorded_at              AS RecordedAt
              FROM return_to_tank r
              JOIN nozzle n  ON n.id = r.nozzle_id
              JOIN pump pu   ON pu.id = n.pump_id
              JOIN staff rb  ON rb.id = r.recorded_by
              LEFT JOIN staff wb ON wb.id = r.witnessed_by
             WHERE r.shift_id = @shiftId
             ORDER BY r.recorded_at
            """,
            new { shiftId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        return new ClosureContext(prices, returns);
    }

    /// <summary>
    /// Record a return to tank.
    ///
    /// The database refuses it from an attendant, on a closed shift, or without
    /// a real reason -- those triggers and checks are the control. The checks
    /// here only exist so the refusal reads as a sentence rather than a
    /// constraint name.
    /// </summary>
    public async Task<Guid> RecordReturnAsync(Guid shiftId, RecordReturn req, CancellationToken ct)
    {
        if (!_user.Can("shift.close"))
            throw new DomainException("NOT_PERMITTED",
                "Recording a return to tank needs shift.close. It changes what an "
                + "attendant owes, so it is not something the attendant records.", 403);

        if (req.Litres <= 0)
            throw new DomainException("LITRES_MUST_BE_POSITIVE",
                "A return to tank is the litres that went back in. It must be more than zero.", 422);

        if (string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Trim().Length < 5)
            throw new DomainException("REASON_REQUIRED",
                "Say why the fuel went back -- \"line flushed after repair\", "
                + "\"customer drove off, drained back\". A return nobody can explain "
                + "is exactly how twenty litres sold for cash disappear.", 422);

        var conn = await _uow.ConnectionAsync(ct);

        return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
            """
            INSERT INTO return_to_tank (tenant_id, site_id, shift_id, nozzle_id,
                                        litres, reason, recorded_by, witnessed_by)
            SELECT s.tenant_id, s.site_id, s.id, @NozzleId,
                   @Litres, @reason, @actor, @WitnessedBy
              FROM shift s
             WHERE s.id = @shiftId
            RETURNING id
            """,
            new
            {
                shiftId, req.NozzleId, req.Litres,
                reason = req.Reason.Trim(), actor = _user.StaffId, req.WitnessedBy,
            },
            transaction: _uow.Transaction, cancellationToken: ct));
    }
}

/// <summary>Routes.</summary>
public static class ShiftClosureEndpoints
{
    public static void MapShiftClosure(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/shifts").RequireAuthorization().WithTags("Shift closure");

        g.MapGet("/{id:guid}/closure",
            async (Guid id, ShiftClosureService s, CancellationToken ct) =>
                Results.Ok(await s.ContextAsync(id, ct)))
         .WithSummary("Per-grade prices and returns to tank for a shift")
         .WithDescription(
             "Prices come from fn_shift_price, the function the close itself uses, "
             + "so the screen and the close cannot disagree about what a litre cost.");

        g.MapPost("/{id:guid}/rtt",
            async (Guid id, RecordReturn req, ShiftClosureService s, CancellationToken ct) =>
                Results.Ok(new { id = await s.RecordReturnAsync(id, req, ct) }))
         .WithSummary("Record a return to tank")
         .WithDescription(
             "Reduces what the attendant owes and puts the litres back in the tank "
             + "book. Refused from an attendant, on a closed shift, or without a "
             + "reason: RTT is the easiest place in the system to hide theft.");
    }
}
