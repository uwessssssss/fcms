using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Accounts;

/// <summary>Dapper target: a bank account or wallet. See docs/DAPPER.md.</summary>
public sealed class MoneyAccountRow
{
    public Guid Id { get; set; }
    public string Kind { get; set; } = "";
    public string Name { get; set; } = "";
    public string Institution { get; set; } = "";
    public string? AccountRef { get; set; }
    public string? ChannelCode { get; set; }
    public bool IsDefault { get; set; }
    public decimal BookBalance { get; set; }
    public DateTime? LastStatement { get; set; }
}

/// <summary>Dapper target: the reconciliation's totals.</summary>
public sealed class BankRecSummary
{
    public decimal StatementBalance { get; set; }
    public DateTime? StatementDate { get; set; }
    public decimal InTransit { get; set; }
    public decimal NotPresented { get; set; }
    public decimal StatementOnly { get; set; }
    public decimal BookBalance { get; set; }
    public decimal Difference { get; set; }
    public int UnmatchedBook { get; set; }
    public int UnmatchedStatement { get; set; }
    public int StaleBook { get; set; }
}

/// <summary>Dapper target: an item in one side and not the other.</summary>
public sealed class BankRecItem
{
    public string Side { get; set; } = "";
    public string Id { get; set; } = "";
    public DateTime OnDate { get; set; }
    public decimal Amount { get; set; }
    public string? Description { get; set; }
    public string? Reference { get; set; }
}

public record BankReconciliation(BankRecSummary Summary, List<BankRecItem> Items);

public record NewMoneyAccount(string Kind, string Name, string Institution, string? AccountRef,
                              Guid? ChannelId, Guid? SiteId, bool IsDefault);
public record NewTransfer(Guid FromAccountId, Guid ToAccountId, decimal Amount, decimal Fee, string? Reference);
public record StatementLineIn(DateOnly Date, DateTime? At, string? Description, string? Reference,
                              decimal Amount, decimal? Balance);
public record StatementIn(DateOnly PeriodFrom, DateOnly PeriodTo, decimal? OpeningBalance, decimal? ClosingBalance,
                          string? SourceName, List<StatementLineIn> Lines);
public record ManualMatch(List<Guid> StatementLineIds, List<long> BookLineIds, string? Note);
public record PostStatementLine(string Code, string? Memo);

/// <summary>
/// Bank accounts and mobile-money wallets against their statements (630).
///
/// A statement is imported once: a line seen before is skipped, so an
/// overlapping statement can be imported again harmlessly. Matching is
/// reconciliation work and can be undone; what a statement shows that the
/// books do not -- a charge, interest, a standing order -- is posted to the
/// books from here, and matched in the same step. Moving money between
/// accounts (a MoMo withdrawal to the bank) is an event that posts itself.
/// </summary>
public sealed class MoneyAccountService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public MoneyAccountService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private void Require(string permission)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (!_user.Can(permission) || _user.Role.Equals("ADMIN", StringComparison.OrdinalIgnoreCase))
            throw new DomainException("FORBIDDEN", "Bank reconciliation is for managers, accountants and head office.", 403);
    }

    public async Task<List<MoneyAccountRow>> ListAsync(CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<MoneyAccountRow>(new CommandDefinition(
            """
            SELECT ma.id AS Id, ma.kind AS Kind, ma.name AS Name, ma.institution AS Institution,
                   ma.account_ref AS AccountRef, pc.code AS ChannelCode, ma.is_default AS IsDefault,
                   COALESCE((SELECT SUM(amount) FROM fn_money_account_book(ma.id)), 0) AS BookBalance,
                   (SELECT max(period_to) FROM bank_statement s WHERE s.money_account_id = ma.id) AS LastStatement
              FROM money_account ma LEFT JOIN payment_channel pc ON pc.id = ma.channel_id
             WHERE fn_money_scope_ok(ma.id)   -- (660) a station sees its own accounts; head office all
             ORDER BY ma.kind, ma.name
            """, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> CreateAsync(NewMoneyAccount req, CancellationToken ct)
    {
        Require("banking.record");
        if (req.Kind is not ("BANK" or "MOBILE_MONEY"))
            throw new DomainException("INVALID_KIND", "An account is a BANK account or a MOBILE_MONEY wallet.");
        if (string.IsNullOrWhiteSpace(req.Name) || string.IsNullOrWhiteSpace(req.Institution))
            throw new DomainException("NAME_REQUIRED", "Name the account and the bank or network.");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO money_account (tenant_id, site_id, kind, name, institution, account_ref, channel_id, is_default)
                VALUES (@tenant, @site, @kind, @name, @institution, @ref, @channel, @isDefault)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = req.SiteId, kind = req.Kind, name = req.Name.Trim(),
                    institution = req.Institution.Trim(), @ref = req.AccountRef, channel = req.ChannelId,
                    isDefault = req.IsDefault
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> TransferAsync(NewTransfer req, CancellationToken ct)
    {
        Require("banking.record");
        if (req.Amount <= 0 || req.Fee < 0)
            throw new DomainException("INVALID_AMOUNT", "A transfer moves more than zero; a fee is zero or more.");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO money_transfer (tenant_id, site_id, from_account, to_account, amount, fee, reference, recorded_by)
                SELECT @tenant, ma.site_id, @from, @to, @amount, @fee, @ref, @actor
                  FROM money_account ma WHERE ma.id = @from
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, from = req.FromAccountId, to = req.ToAccountId, amount = req.Amount,
                    fee = req.Fee, @ref = req.Reference, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<object> ImportAsync(Guid accountId, StatementIn req, CancellationToken ct)
    {
        Require("banking.record");
        if (req.Lines is null || req.Lines.Count == 0)
            throw new DomainException("EMPTY_STATEMENT", "The statement has no lines.");
        if (req.Lines.Any(l => l.Amount == 0))
            throw new DomainException("ZERO_LINE", "A statement line of zero moves nothing; leave it out.");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var statementId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO bank_statement (tenant_id, money_account_id, period_from, period_to, opening_balance,
                                            closing_balance, source_name, imported_by)
                VALUES (@tenant, @account, @from, @to, @opening, @closing, @source, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, account = accountId,
                    from = req.PeriodFrom.ToDateTime(TimeOnly.MinValue), to = req.PeriodTo.ToDateTime(TimeOnly.MinValue),
                    opening = req.OpeningBalance, closing = req.ClosingBalance, source = req.SourceName,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            var imported = 0;
            var lineNo = 0;
            foreach (var l in req.Lines)
            {
                lineNo++;
                imported += await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO bank_statement_line (tenant_id, statement_id, money_account_id, txn_date, txn_at,
                                                     description, reference, amount, balance, line_no)
                    VALUES (@tenant, @statement, @account, @date, @at, @description, @reference, @amount, @balance, @lineNo)
                    ON CONFLICT DO NOTHING
                    """,
                    new
                    {
                        tenant = _user.TenantId, statement = statementId, account = accountId,
                        date = l.Date.ToDateTime(TimeOnly.MinValue), at = l.At is { } t ? DateTime.SpecifyKind(t.ToUniversalTime(), DateTimeKind.Utc) : (DateTime?)null, // Npgsql writes only UTC to timestamptz
                        description = l.Description?.Trim() ?? "", reference = l.Reference?.Trim() ?? "",
                        amount = l.Amount, balance = l.Balance, lineNo
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));
            }
            return new { statementId, imported, skipped = req.Lines.Count - imported };
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<int> AutoMatchAsync(Guid accountId, CancellationToken ct)
    {
        Require("banking.record");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<int>(new CommandDefinition(
                "SELECT fn_bank_auto_match(@account, @actor)",
                new { account = accountId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<BankReconciliation> ReconciliationAsync(Guid accountId, DateOnly asOf, CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);
        // (660) another station's or the company's account reads as unknown here.
        if (!await conn.ExecuteScalarAsync<bool>(new CommandDefinition(
                "SELECT fn_money_scope_ok(@account) AND EXISTS (SELECT 1 FROM money_account WHERE id = @account)",
                new { account = accountId }, transaction: _uow.Transaction, cancellationToken: ct)))
            throw new DomainException("UNKNOWN_ACCOUNT", "No such bank or mobile-money account.", 404);
        var day = asOf.ToDateTime(TimeOnly.MinValue);
        var summary = await conn.QuerySingleAsync<BankRecSummary>(new CommandDefinition(
            """
            SELECT statement_balance AS StatementBalance, statement_date AS StatementDate, in_transit AS InTransit,
                   not_presented AS NotPresented, statement_only AS StatementOnly, book_balance AS BookBalance,
                   difference AS Difference, unmatched_book AS UnmatchedBook,
                   unmatched_statement AS UnmatchedStatement, stale_book AS StaleBook
              FROM fn_bank_reconciliation(@account, @asOf)
            """, new { account = accountId, asOf = day }, transaction: _uow.Transaction, cancellationToken: ct));
        var items = (await conn.QueryAsync<BankRecItem>(new CommandDefinition(
            """
            SELECT side AS Side, id AS Id, on_date AS OnDate, amount AS Amount, description AS Description,
                   reference AS Reference
              FROM fn_bank_unmatched(@account, @asOf)
             LIMIT 1000
            """, new { account = accountId, asOf = day }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
        return new BankReconciliation(summary, items);
    }

    public async Task<Guid> MatchAsync(Guid accountId, ManualMatch req, CancellationToken ct)
    {
        Require("banking.record");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_bank_match(@account, @lines, @book, 'MANUAL', @actor, @note)",
                new
                {
                    account = accountId, lines = req.StatementLineIds.ToArray(), book = req.BookLineIds.ToArray(),
                    actor = _user.StaffId, note = req.Note
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task UndoMatchAsync(Guid matchId, CancellationToken ct)
    {
        Require("banking.record");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                "SELECT fn_bank_unmatch(@match, @actor)", new { match = matchId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> PostLineAsync(Guid lineId, PostStatementLine req, CancellationToken ct)
    {
        Require("banking.record");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_bank_post_statement_line(@line, @code, @memo, @actor)",
                new { line = lineId, code = req.Code, memo = req.Memo, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }
}

public static class MoneyAccountEndpoints
{
    public static void MapMoneyAccounts(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/money").RequireAuthorization();
        static DateOnly Today() => DateOnly.FromDateTime(DateTime.UtcNow.AddHours(3));

        g.MapGet("/accounts", async (MoneyAccountService s, CancellationToken ct) => Results.Ok(await s.ListAsync(ct)));
        g.MapPost("/accounts", async (NewMoneyAccount req, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(new { moneyAccountId = await s.CreateAsync(req, ct) }));
        g.MapPost("/transfers", async (NewTransfer req, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(new { transferId = await s.TransferAsync(req, ct) }));
        g.MapPost("/accounts/{id:guid}/statements", async (Guid id, StatementIn req, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(await s.ImportAsync(id, req, ct)));
        g.MapPost("/accounts/{id:guid}/auto-match", async (Guid id, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(new { matched = await s.AutoMatchAsync(id, ct) }));
        g.MapGet("/accounts/{id:guid}/reconciliation", async (Guid id, DateOnly? asOf, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(await s.ReconciliationAsync(id, asOf ?? Today(), ct)));
        g.MapPost("/accounts/{id:guid}/match", async (Guid id, ManualMatch req, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(new { matchId = await s.MatchAsync(id, req, ct) }));
        g.MapPost("/matches/{id:guid}/undo", async (Guid id, MoneyAccountService s, CancellationToken ct) =>
        {
            await s.UndoMatchAsync(id, ct);
            return Results.NoContent();
        });
        g.MapPost("/statement-lines/{id:guid}/post", async (Guid id, PostStatementLine req, MoneyAccountService s, CancellationToken ct) =>
            Results.Ok(new { journalId = await s.PostLineAsync(id, req, ct) }));
    }
}
