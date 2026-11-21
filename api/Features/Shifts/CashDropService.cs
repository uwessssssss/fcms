using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Shifts;

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class CashDropRow
{
    public Guid Id { get; set; }
    public int SeqNo { get; set; }
    public Guid AttendantId { get; set; }
    public string Attendant { get; set; } = "";
    public decimal Amount { get; set; }
    public string Witness { get; set; } = "";
    public string? BookRef { get; set; }
    public DateTime DroppedAt { get; set; }
    public string RecordedBy { get; set; } = "";
    public DateTime? VoidedAt { get; set; }
    public string? VoidReason { get; set; }
}

/// <summary>Dapper target: one attendant's drops on a shift, for the close
/// screen. See docs/DAPPER.md.</summary>
public sealed class CashDropTotal
{
    public Guid AttendantId { get; set; }
    public decimal Dropped { get; set; }
    public int Drops { get; set; }
}

/// <summary>Dapper target: someone who may witness a drop. See docs/DAPPER.md.</summary>
public sealed class DropWitness
{
    public Guid Id { get; set; }
    public string FullName { get; set; } = "";
    public string Role { get; set; } = "";
}

/// <summary>The shift's drops, each attendant's total, the cap, and who may
/// witness -- the station's active supervisors and managers, so the screen
/// needs no access to the staff register to offer them.</summary>
public record CashDropList(decimal Cap, List<CashDropRow> Drops, List<CashDropTotal> ByAttendant,
                           List<DropWitness> Witnesses);

public record RecordCashDrop(Guid AttendantId, decimal Amount, Guid WitnessId, string? BookRef);

public record VoidCashDrop(string Reason);

/// <summary>
/// Cash dropped into the safe during a shift (migration 580).
///
/// Every rule lives in the database: the shift must be open, the attendant
/// must be working it, the witness is a supervisor or manager of the station
/// and not the attendant, the time is the server's, and a drop is never edited
/// -- only voided, with a reason. At close each live drop settles as cash, so
/// the close screen asks only for what the attendant STILL holds.
/// </summary>
public sealed class CashDropService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public CashDropService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    public async Task<CashDropList> ListAsync(Guid shiftId, CancellationToken ct)
    {
        Require("cashup.declare", alsoReport: true);
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);

        var drops = (await conn.QueryAsync<CashDropRow>(new CommandDefinition(
            """
            SELECT cd.id AS Id, cd.seq_no AS SeqNo, cd.attendant_id AS AttendantId,
                   a.full_name AS Attendant, cd.amount AS Amount, w.full_name AS Witness,
                   cd.book_ref AS BookRef, cd.dropped_at AS DroppedAt, r.full_name AS RecordedBy,
                   cd.voided_at AS VoidedAt, cd.void_reason AS VoidReason
              FROM cash_drop cd
              JOIN staff a ON a.id = cd.attendant_id
              JOIN staff w ON w.id = cd.witnessed_by
              JOIN staff r ON r.id = cd.recorded_by
             WHERE cd.shift_id = @shift
             ORDER BY cd.seq_no
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var totals = (await conn.QueryAsync<CashDropTotal>(new CommandDefinition(
            """
            SELECT attendant_id AS AttendantId, SUM(amount) AS Dropped, count(*)::int AS Drops
              FROM cash_drop
             WHERE shift_id = @shift AND voided_at IS NULL
             GROUP BY attendant_id
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var cap = await conn.ExecuteScalarAsync<decimal>(new CommandDefinition(
            """
            SELECT p.attendant_cash_cap
              FROM shift s JOIN tenant_policy p ON p.tenant_id = s.tenant_id
             WHERE s.id = @shift
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct));

        var witnesses = (await conn.QueryAsync<DropWitness>(new CommandDefinition(
            """
            SELECT st.id AS Id, st.full_name AS FullName, st.role::text AS Role
              FROM shift s JOIN staff st ON st.site_id = s.site_id AND st.tenant_id = s.tenant_id
             WHERE s.id = @shift AND st.is_active AND st.role IN ('SUPERVISOR', 'MANAGER')
             ORDER BY st.full_name
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        return new CashDropList(cap, drops, totals, witnesses);
    }

    public async Task<Guid> RecordAsync(Guid shiftId, RecordCashDrop req, CancellationToken ct)
    {
        Require("cashup.declare");
        if (req.Amount <= 0)
            throw new DomainException("AMOUNT_NOT_POSITIVE", "A drop is more than zero.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_record_cash_drop(@shift, @attendant, @amount, @witness, @book, @actor)",
                new
                {
                    shift = shiftId, attendant = req.AttendantId, amount = req.Amount,
                    witness = req.WitnessId, book = req.BookRef, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task VoidAsync(Guid dropId, VoidCashDrop req, CancellationToken ct)
    {
        Require("cashup.declare");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                "SELECT fn_void_cash_drop(@id, @reason, @actor)",
                new { id = dropId, reason = req.Reason, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    private void Require(string permission, bool alsoReport = false)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (_user.Can(permission) || (alsoReport && _user.Can("report.view")))
            return;
        throw new DomainException("FORBIDDEN",
            "Cash drops are recorded by a supervisor or manager.", 403);
    }
}

public static class CashDropEndpoints
{
    public static void MapCashDrops(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api").RequireAuthorization();

        g.MapGet("/shifts/{shiftId:guid}/cash-drops",
            async (Guid shiftId, CashDropService s, CancellationToken ct) =>
                Results.Ok(await s.ListAsync(shiftId, ct)));

        g.MapPost("/shifts/{shiftId:guid}/cash-drops",
            async (Guid shiftId, RecordCashDrop req, CashDropService s, CancellationToken ct) =>
                Results.Ok(new { cashDropId = await s.RecordAsync(shiftId, req, ct) }));

        g.MapPost("/cash-drops/{id:guid}/void",
            async (Guid id, VoidCashDrop req, CashDropService s, CancellationToken ct) =>
            {
                await s.VoidAsync(id, req, ct);
                return Results.NoContent();
            });
    }
}
