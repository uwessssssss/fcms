using Dapper;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Common;

/// <summary>
/// Reading another station's records, refused the same way writing them is.
/// </summary>
/// <remarks>
/// Migration 530 stops station staff WRITING another station's records, in the
/// database. Reads by id were still open: a supervisor at one station could load
/// another's shift, its tenders, its credit and shop sales, or a stock count, by
/// changing the id in the address. This asks the database the same question 530
/// asks -- fn_station_scope_ok -- so reads and writes can never disagree about
/// who belongs where. A missing row passes through for the caller's own 404.
/// </remarks>
public static class StationScope
{
    /// <summary>Refuse if this person may not see the shift's station.</summary>
    public static Task RequireShiftAsync(NpgsqlConnection conn, IUnitOfWork uow, Guid shiftId,
                                         CancellationToken ct) =>
        Check(conn, uow, "SELECT fn_station_scope_ok(site_id) FROM shift WHERE id = @id", shiftId, ct);

    /// <summary>Refuse if this person may not see the stock count's station.</summary>
    public static Task RequireStockCountAsync(NpgsqlConnection conn, IUnitOfWork uow, Guid countId,
                                              CancellationToken ct) =>
        Check(conn, uow, "SELECT fn_station_scope_ok(site_id) FROM stock_count WHERE id = @id", countId, ct);

    private static async Task Check(NpgsqlConnection conn, IUnitOfWork uow, string sql, Guid id,
                                    CancellationToken ct)
    {
        var ok = await conn.ExecuteScalarAsync<bool?>(new CommandDefinition(
            sql, new { id }, transaction: uow.Transaction, cancellationToken: ct));
        if (ok == false)
            throw new DomainException("OTHER_STATION",
                "That belongs to another station. Only its own people, or head office, can see it.", 403);
    }
}
