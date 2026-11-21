using System.Data;
using Npgsql;

namespace Fcms.Api.Infrastructure;

/// <summary>
/// One request, one connection, one transaction.
///
/// This type exists because of two faults in v1 that were really the same
/// fault — nobody owned the transaction boundary.
///
///   C2  RLS context was set with set_config(..., false), i.e. SESSION scope,
///       on a POOLED connection. Either Npgsql reset it on return to the pool
///       (so FORCE ROW LEVEL SECURITY matched zero rows and every screen went
///       blank with no error), or it survived into the next request and one
///       tenant read another's data. Both were happening.
///
///   C9  A shift close ran fn_capture_shift_close on one Dapper connection,
///       fn_compute_cash_up on another, and the EF state update on a third.
///       Three independent transactions. A failure between them left readings
///       captured, assignments closed, no cash-up, and a shift stuck at
///       READINGS_DONE that could not be retried — the station was wedged.
///
/// Both are fixed by the same rule, enforced here rather than remembered:
/// every database call in a request goes through this object, and the RLS
/// settings are TRANSACTION-LOCAL (set_config's third argument is true), so
/// they cannot outlive the work they belong to.
/// </summary>
public interface IUnitOfWork : IAsyncDisposable
{
    /// <summary>Opens the connection and begins the transaction on first call.</summary>
    Task<NpgsqlConnection> ConnectionAsync(CancellationToken ct = default);

    NpgsqlTransaction? Transaction { get; }
    bool HasWork { get; }

    /// <summary>
    /// Establish the tenant context mid-transaction.
    ///
    /// Login is the one request that begins without knowing its tenant: the
    /// employee number has to be looked up before anyone can say which
    /// business it belongs to. That lookup runs through a SECURITY DEFINER
    /// function precisely because RLS cannot apply yet.
    ///
    /// The moment it returns, the tenant IS known - and everything the request
    /// does after that (writing a session row, recording the attempt) should be
    /// subject to the same isolation as every other request. Calling this is
    /// what makes that true.
    /// </summary>
    Task SetTenantContextAsync(Guid tenantId, Guid staffId, CancellationToken ct = default);

    Task CommitAsync(CancellationToken ct = default);
    Task RollbackAsync(CancellationToken ct = default);
}

public sealed class UnitOfWork : IUnitOfWork
{
    private readonly NpgsqlDataSource _source;
    private readonly ICurrentUser _user;
    private readonly ILogger<UnitOfWork> _log;

    private NpgsqlConnection? _connection;
    private NpgsqlTransaction? _transaction;
    private bool _finished;

    public UnitOfWork(NpgsqlDataSource source, ICurrentUser user, ILogger<UnitOfWork> log)
        => (_source, _user, _log) = (source, user, log);

    public NpgsqlTransaction? Transaction => _transaction;
    public bool HasWork => _transaction is not null && !_finished;

    public async Task<NpgsqlConnection> ConnectionAsync(CancellationToken ct = default)
    {
        if (_connection is not null) return _connection;

        _connection = await _source.OpenConnectionAsync(ct);

        // READ COMMITTED is correct here. The invariants that must not race —
        // one live shift per site, one active holder per nozzle — are unique
        // indexes, and a unique index is enforced regardless of isolation
        // level. Raising to SERIALIZABLE would buy nothing and cost
        // serialisation failures on a forecourt with poor connectivity.
        _transaction = await _connection.BeginTransactionAsync(
            IsolationLevel.ReadCommitted, ct);

        await ApplyRlsContextAsync(ct);
        return _connection;
    }

    /// <summary>
    /// The third argument to set_config is `true` — transaction-local. This one
    /// character is the difference between working tenant isolation and a
    /// cross-tenant data leak on a pooled connection.
    /// </summary>
    private async Task ApplyRlsContextAsync(CancellationToken ct)
    {
        if (!_user.IsAuthenticated)
        {
            // Unauthenticated work (login, health) touches only SECURITY DEFINER
            // functions owned by fcms_auth. Leaving the settings unset means RLS
            // matches nothing, which is the correct failure direction: an
            // accidental query returns zero rows instead of everything.
            return;
        }

        await using var cmd = new NpgsqlCommand(
            "SELECT set_config('app.tenant_id', $1, true), " +
            "       set_config('app.staff_id',  $2, true)",
            _connection, _transaction);
        cmd.Parameters.AddWithValue(_user.TenantId.ToString());
        cmd.Parameters.AddWithValue(_user.StaffId.ToString());
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task SetTenantContextAsync(Guid tenantId, Guid staffId,
                                            CancellationToken ct = default)
    {
        if (_connection is null)
            throw new InvalidOperationException(
                "No connection open; call ConnectionAsync first.");

        // Transaction-local, exactly as in ApplyRlsContextAsync. It expires
        // with this unit of work and cannot leak onto a pooled connection.
        await using var cmd = new NpgsqlCommand(
            "SELECT set_config('app.tenant_id', $1, true), " +
            "       set_config('app.staff_id',  $2, true)",
            _connection, _transaction);
        cmd.Parameters.AddWithValue(tenantId.ToString());
        cmd.Parameters.AddWithValue(staffId.ToString());
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task CommitAsync(CancellationToken ct = default)
    {
        if (_transaction is null || _finished) return;

        // Deferred constraint triggers fire HERE, not at the last INSERT. That
        // is deliberate: the cash-up balance rule and the fuel disposition rule
        // both need to see the complete picture. It also means a close can look
        // successful right up until this line and then be refused — which is
        // exactly what should happen when the litres do not add up.
        await _transaction.CommitAsync(ct);
        _finished = true;
    }

    public async Task RollbackAsync(CancellationToken ct = default)
    {
        if (_transaction is null || _finished) return;
        await _transaction.RollbackAsync(ct);
        _finished = true;
    }

    public async ValueTask DisposeAsync()
    {
        // An uncommitted transaction at dispose means something threw. Roll it
        // back explicitly rather than relying on the connection reset, so the
        // intent is visible in the logs.
        if (_transaction is not null && !_finished)
        {
            _log.LogWarning("Unit of work disposed without commit; rolling back.");
            try { await _transaction.RollbackAsync(); } catch { /* connection already gone */ }
        }
        if (_transaction is not null) await _transaction.DisposeAsync();
        if (_connection is not null) await _connection.DisposeAsync();
    }
}
