using Dapper;
using Fcms.Api.Common;
using Npgsql;

namespace Fcms.Api.Infrastructure;

/// <summary>A previously completed response, replayed for a repeated key.</summary>
/// <remarks>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</remarks>
public sealed class IdempotencyHit
{
    public string Hash { get; set; } = "";
    public string? Body { get; set; }
    public int? Status { get; set; }
}

    /// <summary>
    /// Commits the unit of work when the request succeeded.
    ///
    /// This is the one place a transaction is committed, which is what makes
    /// "one request, one transaction" true rather than aspirational. An
    /// exception anywhere in the pipeline skips the commit, and DisposeAsync
    /// rolls back.
    /// </summary>
    public sealed class TransactionMiddleware
    {
        private readonly RequestDelegate _next;
        public TransactionMiddleware(RequestDelegate next) => _next = next;

        public async Task InvokeAsync(HttpContext ctx, IUnitOfWork uow)
        {
            await _next(ctx);

            if (uow.HasWork && ctx.Response.StatusCode is >= 200 and < 400)
                await uow.CommitAsync(ctx.RequestAborted);
        }
    }

    /// <summary>
    /// Turns a DomainException into a response the forecourt can read, and
    /// anything else into a 500 that leaks nothing.
    /// </summary>
    public sealed class ErrorMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly ILogger<ErrorMiddleware> _log;
        public ErrorMiddleware(RequestDelegate next, ILogger<ErrorMiddleware> log)
            => (_next, _log) = (next, log);

        public async Task InvokeAsync(HttpContext ctx)
        {
            try { await _next(ctx); }
            catch (DomainException ex)
            {
                // A refusal the system MEANT to make -- an unbalanced cash-up, a
                // dip above the chart -- is information, not a fault. It logs
                // at Information with its own sentence.
                //
                // But a DATABASE_ERROR reaching here is a genuine fault that a
                // service translated on the way up, and translating used to
                // discard the PostgresException entirely. The log then read
                // "Refused: DATABASE_ERROR Something went wrong saving that"
                // and nothing else, which is useless to everyone.
                //
                // DomainException now carries the original, so when one is
                // present the log gets the message, the table, the constraint,
                // the column and the SQL state.
                if (ex.InnerException is PostgresException pg)
                {
                    _log.LogError(pg,
                        "Refused: {Code} | pg {SqlState}: {Message} | table={Table} "
                        + "constraint={Constraint} column={Column} | trace={Trace}",
                        ex.Code, pg.SqlState, pg.MessageText,
                        pg.TableName ?? "-", pg.ConstraintName ?? "-",
                        pg.ColumnName ?? "-", ctx.TraceIdentifier);
                }
                else
                {
                    _log.LogInformation("Refused: {Code} {Message} | trace={Trace}",
                        ex.Code, ex.Message, ctx.TraceIdentifier);
                }

                await Write(ctx, ex.Status, ex.Code, ex.Message, ex.Detail);
            }
            catch (PostgresException ex)
            {
                var d = PostgresErrors.Translate(ex);
                // The client is told "something went wrong"; the log has to be
                // told everything. A generic DATABASE_ERROR with no detail sent
                // the last debugging session guessing, so the message, the
                // constraint and the position all go in on one line.
                _log.LogWarning(ex,
                    "Postgres {SqlState} -> {Code} | {Message} | table={Table} "
                    + "constraint={Constraint} column={Column}",
                    ex.SqlState, d.Code, ex.MessageText,
                    ex.TableName ?? "-", ex.ConstraintName ?? "-", ex.ColumnName ?? "-");
                await Write(ctx, d.Status, d.Code, d.Message, null);
            }
            // A cancelled request is not a failure. When a supervisor closes the
            // tab or the tablet loses signal mid-request, ASP.NET cancels the
            // token and Npgsql raises -- logging that as an unhandled error
            // fills the log with noise that hides real faults.
            catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
            {
                _log.LogDebug("Request cancelled by the client");
                if (!ctx.Response.HasStarted) ctx.Response.StatusCode = 499;
                return;
            }
            catch (NpgsqlException ex) when (ex.InnerException is TimeoutException
                                             || ex.Message.Contains("Timeout", StringComparison.OrdinalIgnoreCase))
            {
                // Distinguished from a generic database error because the
                // remedy is different: this one usually means try again.
                _log.LogError(ex, "Database timeout");
                await Write(ctx, 503, "DATABASE_BUSY",
                    "The database did not answer in time. Nothing was saved. "
                    + "Try again in a moment.",
                    null);
                return;
            }
            catch (System.Text.Json.JsonException ex)
            {
                // A malformed body is the caller's fault, not a 500.
                _log.LogWarning(ex, "Malformed request body");
                await Write(ctx, 400, "MALFORMED_REQUEST",
                    "That request could not be read. If this keeps happening, "
                    + "the app and the server may be different versions.",
                    null);
                return;
            }
            catch (BadHttpRequestException ex)
            {
                _log.LogWarning(ex, "Bad request");
                await Write(ctx, 400, "BAD_REQUEST",
                    "Something in that request was missing or the wrong shape.", null);
                return;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Unhandled");
                await Write(ctx, 500, "INTERNAL",
                    "Something went wrong. Nothing was saved.", null);
            }
        }

        /// <summary>
        /// Whether an unrecognised database error is shown in full -- table,
        /// constraint, the function that failed. On while testing (it is how a
        /// fault gets reported in one message); OFF in production, where the
        /// people signing in include every supervisor of every company, and
        /// the schema is not theirs to read. Either way the log has it all,
        /// under the reference the user is shown. Set by Errors:ShowDatabaseDetail.
        /// </summary>
        public static bool ShowDatabaseDetail { get; set; }

        /// <summary>
        /// Every error carries a trace id.
        ///
        /// When a supervisor rings up saying "it said no", one short string
        /// finds the exact request in the log. That beats reconstructing the
        /// evening from memory, which is the alternative.
        /// </summary>
        private static async Task Write(HttpContext ctx, int status, string code,
                                        string message, object? detail)
        {
            if (ctx.Response.HasStarted) return;
            if (code == "DATABASE_ERROR" && !ShowDatabaseDetail)
            {
                message = "The server hit an error it does not recognise. Nothing was changed. "
                        + $"Give whoever supports the system this reference: {ctx.TraceIdentifier}";
                detail = null;
            }
            ctx.Response.Clear();
            ctx.Response.StatusCode = status;
            ctx.Response.Headers["X-Trace-Id"] = ctx.TraceIdentifier;
            await ctx.Response.WriteAsJsonAsync(new
            {
                code,
                message,
                detail,
                traceId = ctx.TraceIdentifier,
            });
        }
    }

    /// <summary>
    /// Replays a completed response for a repeated Idempotency-Key.
    ///
    /// The forecourt has no signal and the client queues writes offline. When
    /// the outbox drains, the same close can arrive twice. Without this, the
    /// second one either fails confusingly or — worse, and this is what v1 did
    /// with shortages — posts a second time.
    ///
    /// The request body is hashed too: the same key with a DIFFERENT body is a
    /// client bug, and silently returning the first response would hide it.
    /// </summary>
    public sealed class IdempotencyMiddleware
    {
        private readonly RequestDelegate _next;
        public IdempotencyMiddleware(RequestDelegate next) => _next = next;

        public async Task InvokeAsync(HttpContext ctx, IUnitOfWork uow, ICurrentUser user)
        {
            if (!HttpMethods.IsPost(ctx.Request.Method)
                || !ctx.Request.Headers.TryGetValue("Idempotency-Key", out var raw)
                || !user.IsAuthenticated)
            {
                await _next(ctx);
                return;
            }

            var key = raw.ToString();
            ctx.Request.EnableBuffering();
            using var reader = new StreamReader(ctx.Request.Body, leaveOpen: true);
            var body = await reader.ReadToEndAsync();
            ctx.Request.Body.Position = 0;
            var hash = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(
                    System.Text.Encoding.UTF8.GetBytes(body)));

            var conn = await uow.ConnectionAsync(ctx.RequestAborted);

            // CLAIM THE KEY BEFORE DOING THE WORK. This used to look for a
            // stored reply, do the work, then record the key with ON CONFLICT
            // DO NOTHING. Two requests with the same key arriving together --
            // a double-tap, or a retry fired while the first was still running
            // -- both found nothing stored, both did the work, and the second
            // record insert was silently ignored: both sales committed. The
            // guard failed in exactly the race it exists for.
            //
            // A transaction-scoped advisory lock on (tenant, key) serialises
            // them: the second waits for the first to COMMIT, then finds its
            // stored reply below and replays it. Released with the transaction.
            await conn.ExecuteAsync(new CommandDefinition(
                "SELECT pg_advisory_xact_lock(hashtextextended(@t::text || ':' || @k, 0))",
                new { t = user.TenantId, k = key },
                transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));

            var prior = await conn.QuerySingleOrDefaultAsync<IdempotencyHit>(
                new CommandDefinition(
                    "SELECT request_hash AS Hash, response_body::text AS Body, " +
                    "       status_code AS Status " +
                    "  FROM idempotency_record WHERE tenant_id = @t AND key = @k",
                    new { t = user.TenantId, k = key },
                    transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));

            if (prior is not null)
            {
                if (prior.Hash != hash)
                {
                    ctx.Response.StatusCode = 409;
                    await ctx.Response.WriteAsJsonAsync(new
                    {
                        code = "IDEMPOTENCY_KEY_REUSED",
                        message = "That request key has already been used for a different "
                                + "request. Use a new key."
                    });
                    return;
                }
                ctx.Response.StatusCode = prior.Status ?? 200;
                ctx.Response.ContentType = "application/json";
                await ctx.Response.WriteAsync(prior.Body ?? "{}");
                return;
            }

            var captured = new MemoryStream();
            var original = ctx.Response.Body;
            ctx.Response.Body = captured;

            try
            {
                await _next(ctx);
                captured.Position = 0;
                var responseBody = await new StreamReader(captured).ReadToEndAsync();
                captured.Position = 0;
                await captured.CopyToAsync(original, ctx.RequestAborted);

                if (ctx.Response.StatusCode is >= 200 and < 300)
                {
                    // Recorded in the SAME transaction as the work -- which is
                    // true only because TransactionMiddleware is registered
                    // OUTSIDE this one. Registered the other way round, this
                    // insert runs after the commit, app.tenant_id is gone with
                    // the transaction, and RLS refuses the row. It also means a
                    // key could exist for work that rolled back, blocking the
                    // retry forever. See the note in Program.cs.
                    await conn.ExecuteAsync(new CommandDefinition(
                        """
                        INSERT INTO idempotency_record
                          (tenant_id, key, endpoint, request_hash, response_body, status_code)
                        VALUES (@t, @k, @e, @h, @b::jsonb, @s)
                        ON CONFLICT (tenant_id, key) DO NOTHING
                        """,
                        new
                        {
                            t = user.TenantId, k = key, e = ctx.Request.Path.ToString(),
                            h = hash, b = string.IsNullOrWhiteSpace(responseBody) ? "{}" : responseBody,
                            s = ctx.Response.StatusCode
                        },
                        transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));
                }
            }
            finally { ctx.Response.Body = original; }
        }
    }

    /// <summary>
    /// Rejects a token whose session has been revoked or has expired.
    ///
    /// v1 issued a 720-minute JWT with no refresh and no revocation: a
    /// dismissed supervisor kept working access for up to twelve hours. The
    /// token now carries session_id and this checks it is still live.
    /// </summary>
    public sealed class SessionCheckMiddleware
    {
        private static readonly HashSet<string> WorkingSiteRoles =
            new(StringComparer.OrdinalIgnoreCase) { "HEAD_OFFICE", "AUDITOR", "SYSTEM_ADMIN" };

        private readonly RequestDelegate _next;
        public SessionCheckMiddleware(RequestDelegate next) => _next = next;

        public async Task InvokeAsync(HttpContext ctx, IUnitOfWork uow, ICurrentUser user)
        {
            if (user.IsAuthenticated && user.SessionId != Guid.Empty)
            {
                var conn = await uow.ConnectionAsync(ctx.RequestAborted);
                var live = await conn.ExecuteScalarAsync<bool>(new CommandDefinition(
                    "SELECT fn_session_is_live(@id)", new { id = user.SessionId },
                    transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));

                if (!live)
                {
                    ctx.Response.StatusCode = 401;
                    await ctx.Response.WriteAsJsonAsync(new
                    {
                        code = "SESSION_REVOKED",
                        message = "This session has ended. Sign in again."
                    });
                    return;
                }

                await conn.ExecuteAsync(new CommandDefinition(
                    "UPDATE staff_session SET last_seen_at = now() WHERE id = @id",
                    new { id = user.SessionId },
                    transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));

                // Head office's working site: the station or depot its station
                // screens act on. Asked for in X-Site-Id; otherwise the first
                // station. Only a company-wide role may choose, and only a
                // trading site of its own company (RLS keeps the lookup in it).
                if (WorkingSiteRoles.Contains(user.Role))
                {
                    Guid? asked = Guid.TryParse(ctx.Request.Headers["X-Site-Id"].ToString(), out var a) ? a : null;
                    var site = await conn.ExecuteScalarAsync<Guid?>(new CommandDefinition(
                        """
                        SELECT id FROM site
                         WHERE tenant_id = @tenant AND kind IN ('STATION', 'DEPOT')
                           AND (@asked::uuid IS NULL OR id = @asked)
                         ORDER BY (kind = 'STATION') DESC, name LIMIT 1   -- the same default as the top bar's
                        """,
                        new { tenant = user.TenantId, asked },
                        transaction: uow.Transaction, cancellationToken: ctx.RequestAborted));
                    if (asked is not null && site is null)
                    {
                        ctx.Response.StatusCode = 403;
                        await ctx.Response.WriteAsJsonAsync(new
                        {
                            code = "SITE_NOT_YOURS",
                            message = "That site is not a station or depot of this company."
                        });
                        return;
                    }
                    if (site is Guid s) ctx.Items[CurrentUser.WorkingSiteKey] = s;
                }
            }
            await _next(ctx);
        }
    }
