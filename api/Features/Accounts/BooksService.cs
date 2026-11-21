using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Accounts;

// ---- Dapper targets: classes with settable properties (docs/DAPPER.md) ----

/// <summary>One account on the trial balance. Amounts: debit positive.</summary>
public sealed class TrialBalanceRow
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public decimal Opening { get; set; }
    public decimal Debits { get; set; }
    public decimal Credits { get; set; }
    public decimal Closing { get; set; }
}

/// <summary>One line of an account's ledger, with the running balance.</summary>
public sealed class LedgerLine
{
    public DateTime? PostingDate { get; set; }
    public DateTime? EventAt { get; set; }
    public Guid? JournalId { get; set; }
    public string Source { get; set; } = "";
    public string Memo { get; set; } = "";
    public string? Party { get; set; }
    public decimal? Qty { get; set; }
    public decimal? Debit { get; set; }
    public decimal? Credit { get; set; }
    public decimal Balance { get; set; }
}

/// <summary>One credit customer: their account against the ledger, and its age.</summary>
public sealed class ReceivableRow
{
    public Guid CustomerId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal CreditLimit { get; set; }
    public decimal Billed { get; set; }
    public decimal Paid { get; set; }
    public decimal Subledger { get; set; }
    public decimal Ledger { get; set; }
    public decimal Difference { get; set; }
    /// <summary>Credit sales on shifts still open: on the account, not yet in the books.</summary>
    public decimal InOpenShifts { get; set; }
    public decimal Current0To30 { get; set; }
    public decimal Days31To60 { get; set; }
    public decimal Days61To90 { get; set; }
    public decimal Over90 { get; set; }
    public DateTime? LastPayment { get; set; }
    public DateTime? OldestUnpaid { get; set; }
}

/// <summary>One control account against the record it stands for.</summary>
public sealed class ControlRow
{
    public string Control { get; set; } = "";
    public string Detail { get; set; } = "";
    public decimal Ledger { get; set; }
    public decimal? Record { get; set; }
    public decimal? Difference { get; set; }
    public string Unit { get; set; } = "";
    /// <summary>true agrees, false differs, null = for information (no record to compare).</summary>
    public bool? Ok { get; set; }
}

/// <summary>A journal in the list.</summary>
public sealed class JournalRow
{
    public Guid Id { get; set; }
    public DateTime PostingDate { get; set; }
    public DateTime EventAt { get; set; }
    public string Source { get; set; } = "";
    public string Memo { get; set; } = "";
    public decimal Total { get; set; }
    public Guid? ReversesId { get; set; }
    public bool Reversed { get; set; }
    public string? PostedBy { get; set; }
}

/// <summary>A line of one journal.</summary>
public sealed class JournalLineRow
{
    public string Code { get; set; } = "";
    public string Account { get; set; } = "";
    public decimal? Debit { get; set; }
    public decimal? Credit { get; set; }
    public decimal? Qty { get; set; }
    public string? Party { get; set; }
    public string? Memo { get; set; }
}

/// <summary>An account in the chart.</summary>
public sealed class AccountRow
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public string? Control { get; set; }
}

public record StatementLine(string Code, string Name, decimal Amount);
public record ProfitAndLoss(DateOnly From, DateOnly To, List<StatementLine> Income, decimal TotalIncome,
                            List<StatementLine> CostOfSales, decimal GrossProfit,
                            List<StatementLine> Expenses, decimal TotalExpenses, decimal NetProfit);
public record BalanceSheet(DateOnly AsOf, List<StatementLine> Assets, decimal TotalAssets,
                           List<StatementLine> Liabilities, decimal TotalLiabilities,
                           List<StatementLine> Equity, decimal EarningsToDate, decimal TotalEquity,
                           decimal Difference);

/// <summary>A manual journal line: Amount positive = debit, negative = credit.</summary>
public record ManualLine(string Code, decimal Amount, string? Memo, Guid? CustomerId, Guid? SupplierId,
                         Guid? StaffId, Guid? TankId, decimal? Qty);
public record ManualJournal(Guid? SiteId, DateOnly Date, string Memo, List<ManualLine> Lines);
public record ReverseJournal(string Reason);

/// <summary>
/// The books (migrations 610/620): read them, reconcile them, correct them.
///
/// Every figure comes from the database's own functions -- the API adds no
/// arithmetic of its own, so a screen, an export and a check can never
/// disagree. Postings happen in the database as events happen; the only
/// writes here are a manual journal, a reversal and a month's close, each
/// refused by the database unless an accountant, manager or head office does it.
///
/// Who sees what: head office, directors and auditors see the company; a
/// station's manager or accountant sees their own station.
/// </summary>
public sealed class BooksService
{
    private static readonly HashSet<string> CompanyWide =
        new(StringComparer.OrdinalIgnoreCase) { "DIRECTOR", "HEAD_OFFICE", "AUDITOR", "SYSTEM_ADMIN" };

    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public BooksService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    /// <summary>The books' permission check: report.view, never ADMIN, and a
    /// station sees its own station. Returns the site to read.</summary>
    private Guid? Require(Guid? requested)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (!_user.Can("report.view") || _user.Role.Equals("ADMIN", StringComparison.OrdinalIgnoreCase))
            throw new DomainException("FORBIDDEN", "The books are for managers, accountants and head office.", 403);
        if (CompanyWide.Contains(_user.Role))
            return requested;
        // A station sees its own books, whatever it asks for.
        if (requested is not null && requested != _user.SiteId)
            throw new DomainException("OTHER_STATION", "You see your own station's books.", 403);
        return _user.SiteId;
    }

    private bool SeesCompany => CompanyWide.Contains(_user.Role);

    public async Task<List<TrialBalanceRow>> TrialBalanceAsync(DateOnly from, DateOnly to, Guid? site, CancellationToken ct,
        bool tradingOnly = false)
    {
        var s = Require(site);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<TrialBalanceRow>(new CommandDefinition(
            """
            SELECT code AS Code, name AS Name, type::text AS Type, opening AS Opening,
                   debits AS Debits, credits AS Credits, closing AS Closing
              FROM fn_gl_trial_balance(@from, @to, @site, @tradingOnly)
            """,
            new { from = from.ToDateTime(TimeOnly.MinValue), to = to.ToDateTime(TimeOnly.MinValue), site = s, tradingOnly },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<ProfitAndLoss> ProfitAndLossAsync(DateOnly from, DateOnly to, Guid? site, CancellationToken ct)
    {
        Require(site);   // checked here too: the permission is visible where it is used
        // Trading only: a closed year's closing journal (640) would otherwise
        // empty every income and expense line.
        var tb = await TrialBalanceAsync(from, to, site, ct, tradingOnly: true);
        // The period's movement; income shown positive.
        static decimal Moved(TrialBalanceRow r) => r.Debits - r.Credits;
        var income = tb.Where(r => r.Type == "INCOME")
                       .Select(r => new StatementLine(r.Code, r.Name, -Moved(r))).Where(l => l.Amount != 0).ToList();
        var cost = tb.Where(r => r.Type == "EXPENSE" && r.Code.StartsWith('5'))
                     .Select(r => new StatementLine(r.Code, r.Name, Moved(r))).Where(l => l.Amount != 0).ToList();
        var expenses = tb.Where(r => r.Type == "EXPENSE" && !r.Code.StartsWith('5'))
                         .Select(r => new StatementLine(r.Code, r.Name, Moved(r))).Where(l => l.Amount != 0).ToList();
        var totalIncome = income.Sum(l => l.Amount);
        var gross = totalIncome - cost.Sum(l => l.Amount);
        var totalExpenses = expenses.Sum(l => l.Amount);
        return new ProfitAndLoss(from, to, income, totalIncome, cost, gross, expenses, totalExpenses, gross - totalExpenses);
    }

    public async Task<BalanceSheet> BalanceSheetAsync(DateOnly asOf, Guid? site, CancellationToken ct)
    {
        Require(site);   // checked here too: the permission is visible where it is used
        var tb = await TrialBalanceAsync(new DateOnly(2000, 1, 1), asOf, site, ct);
        var assets = tb.Where(r => r.Type == "ASSET").Select(r => new StatementLine(r.Code, r.Name, r.Closing)).ToList();
        var liabilities = tb.Where(r => r.Type == "LIABILITY").Select(r => new StatementLine(r.Code, r.Name, -r.Closing)).ToList();
        var equity = tb.Where(r => r.Type == "EQUITY").Select(r => new StatementLine(r.Code, r.Name, -r.Closing)).ToList();
        // Income less expenses not yet closed into retained earnings.
        var earnings = -tb.Where(r => r.Type is "INCOME" or "EXPENSE").Sum(r => r.Closing);
        var totalAssets = assets.Sum(l => l.Amount);
        var totalLiabilities = liabilities.Sum(l => l.Amount);
        var totalEquity = equity.Sum(l => l.Amount) + earnings;
        return new BalanceSheet(asOf, assets, totalAssets, liabilities, totalLiabilities, equity, earnings,
                                totalEquity, totalAssets - totalLiabilities - totalEquity);
    }

    public async Task<List<LedgerLine>> LedgerAsync(string code, DateOnly from, DateOnly to, Guid? site, CancellationToken ct)
    {
        var s = Require(site);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<LedgerLine>(new CommandDefinition(
            """
            SELECT posting_date AS PostingDate, event_at AS EventAt, journal_id AS JournalId, source AS Source,
                   memo AS Memo, party AS Party, qty AS Qty, debit AS Debit, credit AS Credit, balance AS Balance
              FROM fn_gl_account_ledger(@code, @from, @to, @site)
            """,
            new { code, from = from.ToDateTime(TimeOnly.MinValue), to = to.ToDateTime(TimeOnly.MinValue), site = s },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<List<ReceivableRow>> ReceivablesAsync(DateOnly asOf, CancellationToken ct)
    {
        var s = Require(null);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ReceivableRow>(new CommandDefinition(
            """
            SELECT r.customer_id AS CustomerId, r.code AS Code, r.name AS Name, r.credit_limit AS CreditLimit,
                   r.billed AS Billed, r.paid AS Paid, r.subledger AS Subledger, r.ledger AS Ledger,
                   r.difference AS Difference, r.in_open_shifts AS InOpenShifts, r.current_0_30 AS Current0To30, r.days_31_60 AS Days31To60,
                   r.days_61_90 AS Days61To90, r.over_90 AS Over90, r.last_payment AS LastPayment,
                   r.oldest_unpaid AS OldestUnpaid
              FROM fn_ar_reconciliation(@asOf) r
              JOIN credit_customer cc ON cc.id = r.customer_id
             WHERE @site::uuid IS NULL OR cc.site_id = @site
            """,
            new { asOf = asOf.ToDateTime(TimeOnly.MinValue), site = s },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<List<ControlRow>> ControlsAsync(DateOnly asOf, CancellationToken ct)
    {
        Require(null);
        if (!SeesCompany)
            throw new DomainException("FORBIDDEN", "The company's controls are for head office and auditors.", 403);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ControlRow>(new CommandDefinition(
            """
            SELECT control AS Control, detail AS Detail, ledger AS Ledger, record AS Record,
                   difference AS Difference, unit AS Unit, ok AS Ok
              FROM fn_gl_controls_checked(@asOf)
            """,
            new { asOf = asOf.ToDateTime(TimeOnly.MinValue) },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<List<JournalRow>> JournalsAsync(DateOnly from, DateOnly to, string? source, Guid? site, CancellationToken ct)
    {
        var s = Require(site);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<JournalRow>(new CommandDefinition(
            """
            SELECT j.id AS Id, j.posting_date AS PostingDate, j.event_at AS EventAt, j.source AS Source,
                   j.memo AS Memo,
                   (SELECT SUM(amount) FROM gl_line l WHERE l.journal_id = j.id AND l.amount > 0) AS Total,
                   j.reverses_id AS ReversesId,
                   EXISTS (SELECT 1 FROM gl_journal r WHERE r.reverses_id = j.id) AS Reversed,
                   st.full_name AS PostedBy
              FROM gl_journal j LEFT JOIN staff st ON st.id = j.posted_by
             WHERE j.posting_date BETWEEN @from AND @to
               AND (@source::text IS NULL OR j.source = @source)
               AND (@site::uuid IS NULL OR j.site_id = @site)
             ORDER BY j.posting_date DESC, j.event_at DESC
             LIMIT 500
            """,
            new { from = from.ToDateTime(TimeOnly.MinValue), to = to.ToDateTime(TimeOnly.MinValue), source, site = s },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<List<JournalLineRow>> JournalLinesAsync(Guid id, CancellationToken ct)
    {
        var s = Require(null);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<JournalLineRow>(new CommandDefinition(
            """
            SELECT a.code AS Code, a.name AS Account,
                   CASE WHEN l.amount > 0 THEN l.amount END AS Debit,
                   CASE WHEN l.amount < 0 THEN -l.amount END AS Credit,
                   l.qty AS Qty,
                   COALESCE(cc.name, su.name, st.full_name, t.code, di.name, pc.name) AS Party,
                   l.memo AS Memo
              FROM gl_line l JOIN gl_account a ON a.id = l.account_id
              JOIN gl_journal j ON j.id = l.journal_id
              LEFT JOIN credit_customer cc ON cc.id = l.customer_id
              LEFT JOIN supplier su ON su.id = l.supplier_id
              LEFT JOIN staff st ON st.id = l.staff_id
              LEFT JOIN tank t ON t.id = l.tank_id
              LEFT JOIN dry_item di ON di.id = l.item_id
              LEFT JOIN payment_channel pc ON pc.id = l.channel_id
             WHERE l.journal_id = @id AND (@site::uuid IS NULL OR j.site_id = @site)
             ORDER BY l.amount DESC
            """,
            new { id, site = s }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<List<AccountRow>> AccountsAsync(CancellationToken ct)
    {
        Require(null);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<AccountRow>(new CommandDefinition(
            "SELECT code AS Code, name AS Name, type::text AS Type, control AS Control FROM gl_account WHERE is_active ORDER BY code",
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> ManualJournalAsync(ManualJournal req, CancellationToken ct)
    {
        var s = Require(req.SiteId);
        if (req.Lines is null || req.Lines.Count < 2)
            throw new DomainException("JOURNAL_ONE_SIDED", "A journal has at least two lines.");
        if (req.Lines.Sum(l => l.Amount) != 0)
            throw new DomainException("JOURNAL_UNBALANCED",
                $"Debits and credits differ by {req.Lines.Sum(l => l.Amount):N2}. They must be equal.");
        var lines = System.Text.Json.JsonSerializer.Serialize(req.Lines.Select(l => new Dictionary<string, object?>
        {
            ["code"] = l.Code, ["amount"] = l.Amount, ["memo"] = l.Memo, ["customer_id"] = l.CustomerId,
            ["supplier_id"] = l.SupplierId, ["staff_id"] = l.StaffId, ["tank_id"] = l.TankId, ["qty"] = l.Qty
        }));
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_gl_manual_journal(@site, @date, @memo, @lines::jsonb, @actor)",
                new { site = s, date = req.Date.ToDateTime(TimeOnly.MinValue), memo = req.Memo, lines, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> ReverseAsync(Guid id, ReverseJournal req, CancellationToken ct)
    {
        Require(null);
        if (!SeesCompany && !_user.Role.Equals("ACCOUNTANT", StringComparison.OrdinalIgnoreCase))
            throw new DomainException("FORBIDDEN", "A journal is reversed by an accountant or head office.", 403);
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_gl_reverse(@id, @reason, @actor)",
                new { id, reason = req.Reason, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> CloseYearAsync(int year, CancellationToken ct)
    {
        Require((Guid?)null);
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_gl_close_year(@year, @actor)", new { year, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task ClosePeriodAsync(int year, int month, CancellationToken ct)
    {
        Require(null);
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                "SELECT fn_gl_close_period(@month, @actor)",
                new { month = new DateTime(year, month, 1), actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }
}

public static class BooksEndpoints
{
    public static void MapBooks(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/books").RequireAuthorization();
        static DateOnly Today() => DateOnly.FromDateTime(DateTime.UtcNow.AddHours(3));
        static DateOnly MonthStart() => new(Today().Year, Today().Month, 1);

        g.MapGet("/trial-balance", async (DateOnly? from, DateOnly? to, Guid? siteId, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.TrialBalanceAsync(from ?? MonthStart(), to ?? Today(), siteId, ct)));
        g.MapGet("/profit-and-loss", async (DateOnly? from, DateOnly? to, Guid? siteId, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.ProfitAndLossAsync(from ?? MonthStart(), to ?? Today(), siteId, ct)));
        g.MapGet("/balance-sheet", async (DateOnly? asOf, Guid? siteId, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.BalanceSheetAsync(asOf ?? Today(), siteId, ct)));
        g.MapGet("/ledger/{code}", async (string code, DateOnly? from, DateOnly? to, Guid? siteId, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.LedgerAsync(code, from ?? MonthStart(), to ?? Today(), siteId, ct)));
        g.MapGet("/receivables", async (DateOnly? asOf, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.ReceivablesAsync(asOf ?? Today(), ct)));
        g.MapGet("/controls", async (DateOnly? asOf, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.ControlsAsync(asOf ?? Today(), ct)));
        g.MapGet("/journals", async (DateOnly? from, DateOnly? to, string? source, Guid? siteId, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.JournalsAsync(from ?? MonthStart(), to ?? Today(), source, siteId, ct)));
        g.MapGet("/journals/{id:guid}", async (Guid id, BooksService s, CancellationToken ct) =>
            Results.Ok(await s.JournalLinesAsync(id, ct)));
        g.MapGet("/accounts", async (BooksService s, CancellationToken ct) => Results.Ok(await s.AccountsAsync(ct)));
        g.MapPost("/journals", async (ManualJournal req, BooksService s, CancellationToken ct) =>
            Results.Ok(new { journalId = await s.ManualJournalAsync(req, ct) }));
        g.MapPost("/journals/{id:guid}/reverse", async (Guid id, ReverseJournal req, BooksService s, CancellationToken ct) =>
            Results.Ok(new { journalId = await s.ReverseAsync(id, req, ct) }));
        g.MapPost("/years/{year:int}/close", async (int year, BooksService s, CancellationToken ct) =>
            Results.Ok(new { journalId = await s.CloseYearAsync(year, ct) }));
        g.MapPost("/periods/{year:int}/{month:int}/close", async (int year, int month, BooksService s, CancellationToken ct) =>
        {
            await s.ClosePeriodAsync(year, month, ct);
            return Results.NoContent();
        });
    }
}
