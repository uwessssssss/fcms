using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Deliveries;

public record DeliveryLineInput(Guid TankId, decimal LoadedLitres, decimal? UnitCost);

public record CreateDelivery(Guid? SupplierId, string DeliveryNoteNo, string? InvoiceNo,
    string? Depot, string? Transporter, string? TruckReg, string? DriverName,
    string[]? SealNumbers, List<DeliveryLineInput> Lines);

/// <summary>
/// One tank's decant: the dips either side, in LITRES.
///
/// This was the one dip in the system still taken in millimetres. Migration 190
/// moved every other dip to litres; delivery receiving was missed, so the
/// received figure -- after minus before -- went through fn_dip_to_litres and
/// the straight-line calibration chart. On a cylindrical tank a straight line
/// is wrong at both ends, which is exactly where a pre-delivery and a
/// post-delivery dip sit. And received litres is what a shortfall claim against
/// a transporter rests on, so the error became a dispute with a supplier.
///
/// Millimetres stay as an optional fallback for a station that only records
/// the stick. Litres win when both are given.
/// </summary>
public record DecantLine(Guid TankId, decimal? LitresBefore, decimal? LitresAfter,
    decimal RejectedLitres, string? RejectionReason,
    decimal? DipBeforeMm = null, decimal? DipAfterMm = null);

public record ReceiveDelivery(bool SealsIntact, string? SealPhotoUrl,
    List<DecantLine> Lines);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class DeliveryView
{
    public Guid Id { get; set; }
    public string DeliveryNoteNo { get; set; } = "";
    public string? SupplierName { get; set; }
    public string? TruckReg { get; set; }
    public string Status { get; set; } = "";
    public bool? SealsIntact { get; set; }
    public DateTime? ArrivedAt { get; set; }
    public DateTime? SettleUntil { get; set; }
    public decimal LoadedLitres { get; set; }
    public decimal? ReceivedLitres { get; set; }
    public decimal? TransitVariance { get; set; }
}


public sealed class DeliveryService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public DeliveryService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    public async Task<Guid> CreateAsync(CreateDelivery req, CancellationToken ct)
    {
        Require("delivery.receive");
        if (req.Lines.Count == 0)
            throw new DomainException("NO_LINES", "A delivery must name at least one tank.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO delivery
                  (tenant_id, site_id, supplier_id, delivery_note_no, invoice_no, depot,
                   transporter, truck_reg, driver_name, seal_numbers, status, arrived_at)
                VALUES (@tenant, @site, @supplier, @note, @invoice, @depot, @transporter,
                        @truck, @driver, @seals, 'ARRIVED', now())
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, supplier = req.SupplierId,
                    note = req.DeliveryNoteNo, invoice = req.InvoiceNo, depot = req.Depot,
                    transporter = req.Transporter, truck = req.TruckReg,
                    driver = req.DriverName, seals = req.SealNumbers
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            foreach (var line in req.Lines)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO delivery_line
                      (tenant_id, delivery_id, tank_id, product_id, loaded_litres, unit_cost)
                    SELECT @tenant, @delivery, @tank, t.product_id, @loaded, @cost
                      FROM tank t WHERE t.id = @tank
                    """,
                    new
                    {
                        tenant = _user.TenantId, delivery = id, tank = line.TankId,
                        loaded = line.LoadedLitres, cost = line.UnitCost
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Receive the load.
    ///
    /// The received quantity comes from the DIPS either side of the decant, not
    /// from the delivery note. The note is what the depot claims it loaded; the
    /// dip is what reached the ground. When they disagree by more than the
    /// tenant's transit tolerance, that gap is either evaporation, a short load,
    /// or theft in transit — and it is flagged rather than absorbed.
    ///
    /// fn_receive_delivery writes the DELIVERY_IN movements. Until it runs, the
    /// fuel exists on paper only and book stock does not know about it.
    /// </summary>
    public async Task<object> ReceiveAsync(Guid deliveryId, Guid shiftId,
                                           ReceiveDelivery req, CancellationToken ct)
    {
        Require("delivery.receive");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            foreach (var line in req.Lines)
            {
                // Two dips, recorded as evidence in their own right.
                if (line.LitresBefore is null && line.DipBeforeMm is null)
                    throw new DomainException("DIP_BEFORE_MISSING",
                        "Dip the tank before the decant, in litres. Without it there is "
                        + "nothing to measure the delivery against.", 422);
                if (line.LitresAfter is null && line.DipAfterMm is null)
                    throw new DomainException("DIP_AFTER_MISSING",
                        "Dip the tank after the decant, in litres. The difference is what "
                        + "was received, and what a shortfall claim rests on.", 422);

                // Two dips, recorded as evidence in their own right.
                var before = await RecordDipAsync(conn, line.TankId, deliveryId,
                    line.LitresBefore, line.DipBeforeMm, "PRE_DELIVERY", ct);
                var after = await RecordDipAsync(conn, line.TankId, deliveryId,
                    line.LitresAfter, line.DipAfterMm, "POST_DELIVERY", ct);

                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    UPDATE delivery_line
                       SET dip_before_id = @before, dip_after_id = @after,
                           received_litres = (SELECT product_litres FROM dip_reading WHERE id = @after)
                                           - (SELECT product_litres FROM dip_reading WHERE id = @before),
                           rejected_litres = @rejected,
                           rejection_reason = @reason
                     WHERE delivery_id = @delivery AND tank_id = @tank
                    """,
                    new
                    {
                        before, after, delivery = deliveryId, tank = line.TankId,
                        rejected = line.RejectedLitres, reason = line.RejectionReason
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));
            }

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE delivery
                   SET seals_intact = @seals, seal_photo_url = @photo,
                       decant_ended_at = now(), status = 'DECANTING'
                 WHERE id = @id
                """,
                new { id = deliveryId, seals = req.SealsIntact, photo = req.SealPhotoUrl },
                transaction: _uow.Transaction, cancellationToken: ct));

            var raw = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT fn_receive_delivery(@delivery, @shift, @actor)::text",
                new { delivery = deliveryId, shift = shiftId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            return System.Text.Json.JsonDocument.Parse(raw ?? "{}").RootElement.Clone();
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// A decant dip. Litres as read off the chart on the office wall; the
    /// millimetre stick reading only when that is all there is.
    /// </summary>
    private async Task<long> RecordDipAsync(NpgsqlConnection conn, Guid tankId,
        Guid deliveryId, decimal? litres, decimal? dipMm, string context, CancellationToken ct) =>
        await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            """
            INSERT INTO dip_reading
              (tenant_id, site_id, tank_id, context, dip_mm, water_dip_mm,
               gross_litres, water_litres, product_litres, evidence, recorded_by, captured_at)
            SELECT @tenant, t.site_id, @tank, @context::dip_context, @dip, 0,
                   COALESCE(@litres, fn_dip_to_litres(@tank, @dip)), 0,
                   COALESCE(@litres, fn_dip_to_litres(@tank, @dip)),
                   'PENDING', @actor, now()
              FROM tank t WHERE t.id = @tank
            RETURNING id
            """,
            new
            {
                tenant = _user.TenantId, tank = tankId, context, litres, dip = dipMm,
                actor = _user.StaffId, delivery = deliveryId
            },
            transaction: _uow.Transaction, cancellationToken: ct));

    public async Task<IReadOnlyList<DeliveryView>> ListAsync(int days, CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DeliveryView>(new CommandDefinition(
            """
            SELECT d.id, d.delivery_note_no AS DeliveryNoteNo, s.name AS SupplierName,
                   d.truck_reg AS TruckReg, d.status AS Status,
                   d.seals_intact AS SealsIntact, d.arrived_at AS ArrivedAt,
                   d.settle_until AS SettleUntil,
                   COALESCE(SUM(dl.loaded_litres), 0)  AS LoadedLitres,
                   SUM(dl.received_litres)             AS ReceivedLitres,
                   SUM(dl.transit_variance)            AS TransitVariance
              FROM delivery d
              LEFT JOIN supplier s ON s.id = d.supplier_id
              LEFT JOIN delivery_line dl ON dl.delivery_id = d.id
             WHERE d.arrived_at > now() - (@days || ' days')::interval
             GROUP BY d.id, s.name
             ORDER BY d.arrived_at DESC
            """,
            new { days }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
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

public static class DeliveryEndpoints
{
    public static void MapDeliveries(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/deliveries").RequireAuthorization();

        g.MapGet("/", async (int? days, DeliveryService s, CancellationToken ct) =>
            Results.Ok(await s.ListAsync(days ?? 30, ct)));


        g.MapPost("/", async (CreateDelivery req, DeliveryService s, CancellationToken ct) =>
            Results.Ok(new { deliveryId = await s.CreateAsync(req, ct) }));

        g.MapPost("/{id:guid}/receive",
            async (Guid id, Guid shiftId, ReceiveDelivery req, DeliveryService s,
                   CancellationToken ct) =>
                Results.Ok(await s.ReceiveAsync(id, shiftId, req, ct)));
    }
}
