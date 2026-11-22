using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Features.Shifts;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Shifts;

public static class ShiftEndpoints
{
    public static void MapShifts(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/shifts").RequireAuthorization();

        g.MapGet("/", async (string? state, int? days, ShiftService s, CancellationToken ct) =>
            Results.Ok(await s.ListAsync(state, days ?? 30, ct)));

        g.MapGet("/report", async (int? days, Guid? siteId, ShiftService s, CancellationToken ct) =>
            Results.Ok(await s.ReportAsync(days ?? 14, siteId, ct)));
        g.MapGet("/current", async (ShiftService s, CancellationToken ct) =>
            await s.CurrentAsync(ct) is { } shift ? Results.Ok(shift) : Results.NoContent());

        g.MapGet("/{id:guid}", async (Guid id, ShiftService s, CancellationToken ct) =>
            await s.GetAsync(id, ct) is { } d ? Results.Ok(d) : Results.NotFound());

        g.MapPost("/open", async (OpenShiftRequest req, ShiftService s, CancellationToken ct) =>
            Results.Ok(new { shiftId = await s.OpenAsync(req, null, ct) }));

        // Preview and close take the SAME request body on purpose. If they
        // differed, the thing reviewed would not be the thing committed.
        g.MapPost("/{id:guid}/close-preview",
            async (Guid id, CloseShiftRequest req, ShiftService s, CancellationToken ct) =>
                Results.Ok(await s.PreviewAsync(id, req, ct)));

        g.MapPost("/{id:guid}/close",
            async (Guid id, CloseShiftRequest req, ShiftService s, CancellationToken ct) =>
                Results.Ok(await s.CloseAsync(id, req, ct)));

        g.MapGet("/{id:guid}/tenders", async (Guid id, ShiftService s,
                                              CancellationToken ct) =>
            Results.Ok(await s.TendersAsync(id, ct)));

        g.MapPost("/{id:guid}/approve", async (Guid id, ShiftService s, CancellationToken ct) =>
        {
            await s.ApproveAsync(id, ct);
            return Results.Ok(new { approved = true });
        });
    }
}
