using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Setup;





/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class ChannelRef
{
    public Guid Id { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? TillNumber { get; set; }
}

public record AtgReading(string TankCode, decimal ProductLitres, decimal? TcLitres,
    decimal? WaterLitres, decimal? UllageLitres, decimal? TemperatureC,
    DateTime PolledAt);

/// <summary>
/// Everything the shift-open screen needs, in one call.
///
/// Four round trips on a forecourt tablet over a 3G tether is four chances to
/// half-load. One call that either arrives or does not is easier to reason about
/// and easier to retry.
/// </summary>
public sealed class SetupService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public SetupService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);


    /// <summary>
    /// Ingest readings from an automatic tank gauge.
    ///
    /// The gauge itself is somebody else's hardware — a Veeder-Root or a
    /// Franklin box on a serial line — and polling it belongs in a small agent
    /// on the station's own network, not in this API. What matters here is that
    /// there is a door: readings land in atg_reading with the tank they belong
    /// to, and can then be compared against the manual dips.
    ///
    /// ATG readings are recorded, NOT trusted as truth. A gauge with a stuck
    /// float reads perfectly steady while a tank drains. The manual dip stays
    /// the reconciling measurement; this is a second opinion that makes a
    /// disagreement visible.
    ///
    /// Matched on tank CODE rather than id, because the agent knows what is
    /// painted on the tank, not what is in the database.
    /// </summary>
    /// <remarks>
    /// Accept readings from the tank gauge.
    ///
    /// Guarded, and it was not. An ATG reading feeds every variance
    /// calculation in the system, so anyone able to post one can make a loss
    /// disappear -- and this endpoint exists for an unattended agent, which is
    /// exactly the kind of credential that gets copied onto a laptop.
    ///
    /// equipment.manage rather than a softer permission: writing gauge data is
    /// closer to reconfiguring a tank than to recording a sale.
    /// </remarks>
    public async Task<int> IngestAtgAsync(List<AtgReading> readings, CancellationToken ct)
    {
        Require("equipment.manage");

        if (readings.Count > 500)
            throw new DomainException("TOO_MANY_READINGS",
                "Send at most 500 readings per call. A polling agent that has "
                + "backed up should catch up in batches, not in one request.", 413);

        var conn = await _uow.ConnectionAsync(ct);
        var n = 0;
        foreach (var r in readings)
        {
            n += await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO atg_reading
                  (tenant_id, site_id, tank_id, product_litres, tc_litres, water_litres,
                   ullage_litres, temperature_c, polled_at)
                SELECT t.tenant_id, t.site_id, t.id, @product, @tc, @water, @ullage,
                       @temp, @polled
                  FROM tank t
                 WHERE t.site_id = @site AND t.code = @code AND t.is_active
                ON CONFLICT (tank_id, polled_at) DO NOTHING
                """,
                new
                {
                    site = _user.SiteId, code = r.TankCode, product = r.ProductLitres,
                    tc = r.TcLitres, water = r.WaterLitres, ullage = r.UllageLitres,
                    temp = r.TemperatureC, polled = r.PolledAt
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        return n;
    }

    public async Task<IReadOnlyList<ChannelRef>> ChannelsAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ChannelRef>(new CommandDefinition(
            """
            SELECT id, code, name, kind::text AS Kind, till_number AS TillNumber
              FROM payment_channel
             WHERE site_id = @site AND is_active
             ORDER BY name
            """,
            new { site = _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
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

public static class SetupEndpoints
{
    public static void MapSetup(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/setup").RequireAuthorization();


        g.MapGet("/payment-channels", async (SetupService s, CancellationToken ct) =>
            Results.Ok(await s.ChannelsAsync(ct)));

        g.MapPost("/atg", async (List<AtgReading> readings, SetupService s,
                                 CancellationToken ct) =>
            Results.Ok(new { ingested = await s.IngestAtgAsync(readings, ct) }));
    }
}
