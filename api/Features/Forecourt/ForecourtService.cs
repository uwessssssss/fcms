using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Forecourt;

public record RecordPumpTest(Guid NozzleId, decimal CanSizeLitres, decimal MeasuredLitres,
    bool ReturnedToTank, Guid? WitnessedBy, string? PhotoUrl);

public record RecordOwnUse(Guid TankId, Guid? NozzleId, decimal Litres, string Purpose,
    string? Reference);

/// <summary>
/// A spot dip, in LITRES. See OpeningDip for why.
/// </summary>
public record RecordDip(Guid TankId, string Context, decimal ProductLitres,
    decimal? WaterLitres, decimal? DipMm, decimal? WaterDipMm,
    decimal? TemperatureC, string? PhotoUrl);

/// <summary>Dapper target: an assignment's opening, both meters, and the tolerance.</summary>
public sealed class OpeningPair
{
    public decimal? Volume { get; set; }
    public decimal? Electronic { get; set; }
    public decimal Tolerance { get; set; }
}

/// <summary>Both meters are read at a handover (730), and the outgoing
/// holder's litres on each must agree to within 1 L -- or a reason is given.</summary>
public record HandoverRequest(Guid AssignmentId, Guid IncomingAttendantId,
    decimal VolumeTotalizer, decimal? ElectronicTotalizer, string? PhotoUrl,
    bool IsRollover = false, string? DifferenceReason = null);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class ExceptionView
{
    public long Id { get; set; }
    public string Entity { get; set; } = "";
    public string EntityId { get; set; } = "";
    public string Code { get; set; } = "";
    public string Level { get; set; } = "";
    public string Detail { get; set; } = "";
    public DateTime RaisedAt { get; set; }
    public string? ResolvedByName { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public string? Resolution { get; set; }
}

public record ResolveException(string Resolution);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
internal sealed class OutgoingAssignment
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid SiteId { get; set; }
    public Guid ShiftId { get; set; }
    public Guid NozzleId { get; set; }
    public string State { get; set; } = "";
}

public sealed class ForecourtService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public ForecourtService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly HashSet<string> Purposes = new(StringComparer.OrdinalIgnoreCase)
        { "GENERATOR", "COMPANY_VEHICLE", "TRANSFER_OUT", "SAMPLE", "CLEANING" };
    private static readonly HashSet<string> DipContexts = new(StringComparer.OrdinalIgnoreCase)
        { "SHIFT_OPEN", "SHIFT_CLOSE", "PRE_DELIVERY", "POST_DELIVERY", "STOCK_TAKE", "SPOT_CHECK" };

    /// <summary>
    /// A pump test.
    ///
    /// measured_litres is what actually came out of the nozzle, and it is what
    /// the meter counted. can_size_litres is the target. v1 used the can size
    /// everywhere, so the deviation of every single test — every pump, every day
    /// — was pushed into stock variance as a phantom loss. Over a month on a
    /// busy forecourt that is a meaningful invented shortfall.
    /// </summary>
    public async Task<Guid> RecordPumpTestAsync(Guid shiftId, RecordPumpTest req,
                                                CancellationToken ct)
    {
        Require("pump_test.record");

        if (req.MeasuredLitres <= 0)
            throw new DomainException("INVALID_MEASUREMENT",
                "Record what actually came out of the nozzle, in litres.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO pump_test
                  (tenant_id, site_id, shift_id, nozzle_id, can_size_litres,
                   measured_litres, returned_to_tank, tested_by, witnessed_by, photo_url)
                SELECT @tenant, s.site_id, @shift, @nozzle, @can, @measured,
                       @returned, @actor, @witness, @photo
                  FROM shift s WHERE s.id = @shift
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, shift = shiftId, nozzle = req.NozzleId,
                    can = req.CanSizeLitres, measured = req.MeasuredLitres,
                    returned = req.ReturnedToTank, actor = _user.StaffId,
                    witness = req.WitnessedBy, photo = req.PhotoUrl
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // A pump delivering outside tolerance is a calibration problem that
            // costs money in one direction or reputation in the other.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                SELECT fn_raise_flag(pt.tenant_id, pt.site_id, pt.shift_id, 'pump_test',
                         pt.id::text, 'PUMP_OUT_OF_TOLERANCE', 'WARN',
                         jsonb_build_object('nozzle', n.code, 'can_litres', pt.can_size_litres,
                           'measured', pt.measured_litres, 'deviation_ml', pt.deviation_ml))
                  FROM pump_test pt
                  JOIN nozzle n ON n.id = pt.nozzle_id
                  JOIN tenant_policy pol ON pol.tenant_id = pt.tenant_id
                 WHERE pt.id = @id
                   AND abs(pt.measured_litres - pt.can_size_litres)
                       / pt.can_size_litres * 100 > pol.pump_test_tolerance_pct
                """,
                new { id }, transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Fuel the station drew for itself.
    ///
    /// NozzleId decides everything downstream. With a nozzle, the fuel passed a
    /// meter and is classified inside that meter event. Without one, it never
    /// touched a meter and becomes a BULK_OUT movement instead.
    ///
    /// v1 subtracted ALL own use from metered throughput regardless, so a bulk
    /// draw for the generator reduced what the attendant was charged for fuel
    /// that had never gone through their pump. That is audit C5, and it is
    /// structurally impossible here because the two paths are different tables.
    /// </summary>
    public async Task<Guid> RecordOwnUseAsync(Guid shiftId, RecordOwnUse req,
                                              CancellationToken ct)
    {
        Require("dip.record");

        if (req.Litres <= 0)
            throw new DomainException("INVALID_LITRES", "Litres must be more than zero.");
        if (!Purposes.Contains(req.Purpose))
            throw new DomainException("INVALID_PURPOSE",
                $"'{req.Purpose}' is not a recognised purpose. Use one of: "
                + string.Join(", ", Purposes));

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var ownUseId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO own_use
                  (tenant_id, site_id, shift_id, tank_id, nozzle_id, litres, purpose,
                   reference, authorised_by)
                SELECT @tenant, s.site_id, @shift, @tank, @nozzle, @litres,
                       @purpose, @reference, @actor
                  FROM shift s WHERE s.id = @shift
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, shift = shiftId, tank = req.TankId,
                    nozzle = req.NozzleId, litres = req.Litres,
                    purpose = req.Purpose.ToUpperInvariant(), reference = req.Reference,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // No nozzle means no meter. Raise the bulk draw now so the close can
            // turn it into a BULK_OUT movement.
            if (req.NozzleId is null)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO bulk_draw
                      (tenant_id, site_id, shift_id, tank_id, own_use_id, litres,
                       reason, authorised_by)
                    SELECT @tenant, s.site_id, @shift, @tank, @ownUse, @litres,
                           @reason, @actor
                      FROM shift s WHERE s.id = @shift
                    """,
                    new
                    {
                        tenant = _user.TenantId, shift = shiftId, tank = req.TankId,
                        ownUse = ownUseId, litres = req.Litres,
                        reason = $"{req.Purpose}: {req.Reference ?? "no reference"}",
                        actor = _user.StaffId
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return ownUseId;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// A dip outside the shift open/close cycle — a spot check, or the pair
    /// either side of a delivery.
    /// </summary>
    public async Task<long> RecordDipAsync(Guid? shiftId, RecordDip req, CancellationToken ct)
    {
        Require("dip.record");

        if (!DipContexts.Contains(req.Context))
            throw new DomainException("INVALID_CONTEXT",
                $"'{req.Context}' is not a dip context. Use one of: "
                + string.Join(", ", DipContexts));

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            // fn_dip_to_litres refuses to extrapolate past the calibration chart,
            // so a misread or an overfill surfaces here rather than silently
            // becoming invented stock.
            return await conn.ExecuteScalarAsync<long>(new CommandDefinition(
                """
                INSERT INTO dip_reading
                  (tenant_id, site_id, tank_id, shift_id, context, dip_mm, water_dip_mm,
                   gross_litres, water_litres, product_litres, temperature_c, photo_url,
                   evidence, recorded_by, captured_at)
                SELECT @tenant, t.site_id, @tank, @shift, @context::dip_context,
                       @dip, @water,
                       fn_dip_to_litres(@tank, @dip),
                       CASE WHEN @water > 0 THEN fn_dip_to_litres(@tank, @water) ELSE 0 END,
                       fn_dip_to_litres(@tank, @dip)
                         - CASE WHEN @water > 0 THEN fn_dip_to_litres(@tank, @water) ELSE 0 END,
                       @temp, @photo,
                       CASE WHEN @photo IS NULL THEN 'PENDING' ELSE 'PRESENT' END::evidence_state,
                       @actor, now()
                  FROM tank t WHERE t.id = @tank
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, tank = req.TankId, shift = shiftId,
                    context = req.Context.ToUpperInvariant(), dip = req.ProductLitres,
                    water = req.WaterDipMm, temp = req.TemperatureC, photo = req.PhotoUrl,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// A nozzle changes hands mid-shift.
    ///
    /// The outgoing attendant's closing reading IS the incoming attendant's
    /// opening reading — one number, recorded once, used twice. Reading the
    /// meter twice invites two different numbers, and the difference becomes a
    /// litre nobody owns.
    /// </summary>
    public async Task<Guid> HandoverAsync(HandoverRequest req, CancellationToken ct)
    {
        Require("assignment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var outgoing = await conn.QuerySingleOrDefaultAsync<OutgoingAssignment>(
                new CommandDefinition(
                    """
                    SELECT id AS Id, tenant_id AS TenantId, site_id AS SiteId,
                           shift_id AS ShiftId, nozzle_id AS NozzleId, state AS State
                      FROM nozzle_assignment WHERE id = @id FOR UPDATE
                    """,
                    new { id = req.AssignmentId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            if (outgoing is null)
                throw new DomainException("UNKNOWN_ASSIGNMENT", "That assignment does not exist.", 404);
            if (outgoing.State != "ACTIVE")
                throw new DomainException("ASSIGNMENT_NOT_ACTIVE",
                    "That nozzle has already been released.", 409);

            // A reading below the opening is a TYPO unless the supervisor says the
            // meter rolled over (470). Caught here, while it can be corrected --
            // the outgoing attendant is billed on this reading at close.
            var open = await conn.QuerySingleOrDefaultAsync<OpeningPair>(new CommandDefinition(
                """
                SELECT mr.volume_totalizer AS Volume, mr.electronic_totalizer AS Electronic,
                       p.meter_pair_tolerance_litres AS Tolerance
                  FROM meter_reading mr JOIN tenant_policy p ON p.tenant_id = mr.tenant_id
                 WHERE mr.assignment_id = @id AND mr.is_opening
                """,
                new { id = outgoing.Id }, transaction: _uow.Transaction, cancellationToken: ct));
            var opening = open?.Volume;

            // (730) Both meters, here as at the close, while it can still be put right.
            if (req.ElectronicTotalizer is null)
                throw new DomainException("ELECTRONIC_READING_REQUIRED",
                    "Read the electronic meter as well as the manual one: both are recorded at every handover.", 422);
            if (open?.Electronic is not null && opening is not null && !req.IsRollover)
            {
                var manual = req.VolumeTotalizer - opening.Value;
                var electronic = req.ElectronicTotalizer.Value - open.Electronic.Value;
                if (Math.Abs(electronic - manual) > open.Tolerance && string.IsNullOrWhiteSpace(req.DifferenceReason))
                    throw new DomainException("METER_PAIR_DISAGREES",
                        $"The electronic meter shows {electronic:0.###} L and the manual {manual:0.###} L for this holding, " +
                        $"{electronic - manual:+0.###;-0.###} L apart (at most {open.Tolerance:0.##} L). Check both readings; " +
                        "if they are right, give the reason and the shift goes to the manager flagged.", 422);
            }

            if (!req.IsRollover && opening is not null && req.VolumeTotalizer < opening)
                throw new DomainException("METER_BACKWARDS",
                    $"The handover reading {req.VolumeTotalizer} is below this nozzle's opening reading " +
                    $"{opening}. Check it -- or, if the meter rolled over, tick that it did.", 422);

            // 1. Close the outgoing holder's reading.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO meter_reading
                  (tenant_id, site_id, nozzle_id, shift_id, assignment_id, is_opening,
                   source, volume_totalizer, electronic_totalizer, photo_url, evidence,
                   recorded_by, captured_at, is_rollover, difference_reason)
                VALUES (@tenant, @site, @nozzle, @shift, @assignment, false, 'MANUAL',
                        @volume, @electronic, @photo,
                        CASE WHEN @photo IS NULL THEN 'PENDING' ELSE 'PRESENT' END::evidence_state,
                        @actor, now(), @rollover, @reason)
                """,
                new
                {
                    tenant = outgoing.TenantId, site = outgoing.SiteId,
                    nozzle = outgoing.NozzleId, shift = outgoing.ShiftId,
                    assignment = outgoing.Id, volume = req.VolumeTotalizer,
                    electronic = req.ElectronicTotalizer, photo = req.PhotoUrl,
                    actor = _user.StaffId, rollover = req.IsRollover,
                    reason = string.IsNullOrWhiteSpace(req.DifferenceReason) ? null : req.DifferenceReason.Trim()
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // 2. Release it. This must happen before the new assignment, because
            //    one_active_holder_per_nozzle allows exactly one ACTIVE row.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                -- Released as CLOSED first: the table requires a HANDED_OVER row to
                -- point at the assignment that took over, which does not exist yet,
                -- and the incoming one cannot be created while this one is still
                -- ACTIVE (one holder per nozzle). Setting HANDED_OVER here broke
                -- that check, so EVERY handover failed. It becomes HANDED_OVER,
                -- with its pointer, once the incoming assignment exists -- all in
                -- this one transaction, so nothing ever sees the CLOSED step.
                UPDATE nozzle_assignment
                   SET state = 'CLOSED', released_at = now(), released_by = @actor
                 WHERE id = @id
                """,
                new { id = outgoing.Id, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            // 3. The incoming holder.
            var incoming = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO nozzle_assignment
                  (tenant_id, site_id, shift_id, nozzle_id, attendant_id, assigned_by)
                VALUES (@tenant, @site, @shift, @nozzle, @attendant, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = outgoing.TenantId, site = outgoing.SiteId,
                    shift = outgoing.ShiftId, nozzle = outgoing.NozzleId,
                    attendant = req.IncomingAttendantId, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // 4. The same number, as their opening.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO meter_reading
                  (tenant_id, site_id, nozzle_id, shift_id, assignment_id, is_opening,
                   source, volume_totalizer, electronic_totalizer, photo_url, evidence,
                   recorded_by, captured_at)
                VALUES (@tenant, @site, @nozzle, @shift, @assignment, true, 'MANUAL',
                        @volume, @electronic, @photo,
                        CASE WHEN @photo IS NULL THEN 'PENDING' ELSE 'PRESENT' END::evidence_state,
                        @actor, now())
                """,
                new
                {
                    tenant = outgoing.TenantId, site = outgoing.SiteId,
                    nozzle = outgoing.NozzleId, shift = outgoing.ShiftId,
                    assignment = incoming, volume = req.VolumeTotalizer,
                    electronic = req.ElectronicTotalizer, photo = req.PhotoUrl,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // 5. Link them, so the chain of custody for this nozzle is traceable.
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE nozzle_assignment SET handed_to_id = @in, state = 'HANDED_OVER' WHERE id = @out",
                new { @in = incoming, @out = outgoing.Id },
                transaction: _uow.Transaction, cancellationToken: ct));

            return incoming;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<ExceptionView>> ExceptionsAsync(Guid? shiftId,
        bool openOnly, CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ExceptionView>(new CommandDefinition(
            """
            SELECT e.id, e.entity, e.entity_id AS EntityId, e.code,
                   e.level::text AS Level, e.detail::text AS Detail,
                   e.raised_at AS RaisedAt, r.full_name AS ResolvedByName,
                   e.resolved_at AS ResolvedAt, e.resolution
              FROM exception_flag e
              LEFT JOIN staff r ON r.id = e.resolved_by
             WHERE (@shift::uuid IS NULL OR e.shift_id = @shift)
               AND (@openOnly = false OR e.resolved_at IS NULL)
             ORDER BY e.level DESC, e.raised_at DESC
             LIMIT 200
            """,
            new { shift = shiftId, openOnly },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task ResolveExceptionAsync(long id, ResolveException req, CancellationToken ct)
    {
        Require("exception.resolve");

        // The schema requires ten characters. Enforcing it here too means the
        // person gets a useful message instead of a constraint name.
        if ((req.Resolution ?? "").Trim().Length < 10)
            throw new DomainException("RESOLUTION_TOO_SHORT",
                "Say what was actually found and done. 'OK' tells the next auditor nothing.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var n = await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE exception_flag
                   SET resolved_by = @actor, resolved_at = now(), resolution = @resolution
                 WHERE id = @id AND resolved_at IS NULL
                """,
                new { id, actor = _user.StaffId, resolution = req.Resolution!.Trim() },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (n == 0)
                throw new DomainException("ALREADY_RESOLVED",
                    "That exception has already been dealt with.", 409);
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
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

public static class ForecourtEndpoints
{
    public static void MapForecourt(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/forecourt").RequireAuthorization();

        g.MapPost("/shifts/{shiftId:guid}/pump-tests",
            async (Guid shiftId, RecordPumpTest req, ForecourtService s, CancellationToken ct) =>
                Results.Ok(new { pumpTestId = await s.RecordPumpTestAsync(shiftId, req, ct) }));

        g.MapPost("/shifts/{shiftId:guid}/own-use",
            async (Guid shiftId, RecordOwnUse req, ForecourtService s, CancellationToken ct) =>
                Results.Ok(new { ownUseId = await s.RecordOwnUseAsync(shiftId, req, ct) }));

        g.MapPost("/dips", async (Guid? shiftId, RecordDip req, ForecourtService s,
                                  CancellationToken ct) =>
            Results.Ok(new { dipId = await s.RecordDipAsync(shiftId, req, ct) }));

        g.MapPost("/handover", async (HandoverRequest req, ForecourtService s, CancellationToken ct) =>
            Results.Ok(new { assignmentId = await s.HandoverAsync(req, ct) }));

        g.MapGet("/exceptions", async (Guid? shiftId, bool? openOnly, ForecourtService s,
                                       CancellationToken ct) =>
            Results.Ok(await s.ExceptionsAsync(shiftId, openOnly ?? true, ct)));

        g.MapPost("/exceptions/{id:long}/resolve",
            async (long id, ResolveException req, ForecourtService s, CancellationToken ct) =>
            {
                await s.ResolveExceptionAsync(id, req, ct);
                return Results.Ok(new { resolved = true });
            });
    }
}
