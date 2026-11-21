using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Features.Accounts;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class SiteLine
{
    public string SiteName { get; set; } = "";
    public string SiteKind { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal Revenue { get; set; }
    public decimal Margin { get; set; }
    public decimal? MarginPerLitre { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class ApprovalItem
{
    public string Kind { get; set; } = "";
    public string Description { get; set; } = "";
    public decimal? Amount { get; set; }
    public DateTime Since { get; set; }
    public int AgeDays { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class ConcentrationRow
{
    public string Name { get; set; } = "";
    public decimal Balance { get; set; }
    public decimal SharePct { get; set; }
    public int? OldestDays { get; set; }
    public bool Overdue { get; set; }
}

public record DirectorsSummary(
    DateOnly From, DateOnly To,
    decimal Revenue, decimal GrossMargin, decimal NetPosition,
    decimal MarginPerLitre, decimal TotalLitres,
    decimal StockLossLitres, decimal StockLossValue, decimal? StockLossPct,
    decimal Receivables, decimal ReceivablesPastTerms,
    decimal Payables, decimal PayablesOverdue,
    decimal CashOnHand, decimal WorkingCapital,
    int OpenExceptions, int CriticalExceptions,
    int LoadsBelowCost, decimal BelowCostValue,
    List<SiteLine> Sites,
    List<ApprovalItem> Awaiting,
    List<ConcentrationRow> Concentration);

/// <summary>
/// What a director needs, on one page.
///
/// A director signing in was landing on the station dashboard -- nozzles, dips,
/// meter readings. That is a supervisor's view of a shift, and an owner does
/// not need it. They ask six questions, in this order:
///
///   Did we make money? Are we losing stock? Who owes us? Who do we owe?
///   What needs my signature? Is anything wrong right now?
///
/// So the page answers those six and stops. Every figure links to the screen
/// that shows the workings, because a headline nobody can drill into is a
/// headline nobody believes.
///
/// CONCENTRATION is here for a reason that is not obvious from the arithmetic:
/// a debtor book is not risky because it is large, it is risky because it is
/// concentrated. One haulier holding three quarters of it is a different
/// business from twenty holding an equal share, and the total is identical.
/// </summary>
public sealed class DirectorsService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;
    private readonly AccountsService _accounts;

    public DirectorsService(IUnitOfWork uow, ICurrentUser user, AccountsService accounts)
        => (_uow, _user, _accounts) = (uow, user, accounts);

    public async Task<DirectorsSummary> GetAsync(DateOnly from, DateOnly to,
                                                  CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);

        // The statement already knows how to compute a bottom line, and there
        // must only ever be one place that does. A second implementation would
        // drift from the first, and then two screens disagree about profit.
        var statement = await _accounts.StatementAsync(from, to, ct);

        var sites = (await conn.QueryAsync<SiteLine>(new CommandDefinition(
            """
            SELECT site_name AS SiteName, site_kind AS SiteKind,
                   SUM(retail_litres + bulk_litres) AS Litres,
                   SUM(revenue) AS Revenue,
                   SUM(margin)  AS Margin,
                   CASE WHEN SUM(retail_litres + bulk_litres) > 0
                        THEN round(SUM(margin) / SUM(retail_litres + bulk_litres), 3)
                   END AS MarginPerLitre
              FROM v_site_performance
             WHERE business_date BETWEEN @from AND @to
             GROUP BY site_name, site_kind
             ORDER BY SUM(margin) DESC
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var loss = await conn.QuerySingleAsync<LossHeadline>(new CommandDefinition(
            """
            SELECT COALESCE(SUM(loss_litres), 0) AS Litres,
                   COALESCE(SUM(loss_value), 0)  AS Value,
                   COALESCE(SUM(sold_litres), 0) AS Sold
              FROM v_daily_stock_loss
             WHERE business_date BETWEEN @from AND @to
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        var money = await conn.QuerySingleAsync<MoneyHeadline>(new CommandDefinition(
            """
            SELECT
              (SELECT COALESCE(SUM(balance), 0) FROM v_credit_ageing_buckets)     AS Receivables,
              (SELECT COALESCE(SUM(past_terms), 0) FROM v_credit_ageing_buckets)  AS PastTerms,
              (SELECT COALESCE(SUM(GREATEST(balance, 0)), 0)
                 FROM v_supplier_balance)                                         AS Payables,
              (SELECT COALESCE(SUM(GREATEST(balance, 0)), 0)
                 FROM v_supplier_balance WHERE overdue)                           AS Overdue,
              (SELECT COALESCE(SUM(on_hand), 0) FROM v_cash_position)            AS CashOnHand,
              (SELECT count(*) FROM exception_flag WHERE resolved_at IS NULL)     AS OpenExceptions,
              (SELECT count(*) FROM exception_flag
                WHERE resolved_at IS NULL AND level = 'CRITICAL')                 AS Critical
            """,
            transaction: _uow.Transaction, cancellationToken: ct));

        var below = await conn.QuerySingleAsync<BelowCostHeadline>(new CommandDefinition(
            """
            SELECT count(*)::int AS Loads, COALESCE(SUM(margin), 0) AS Value
              FROM v_bulk_sales_below_cost
             WHERE loaded_at::date BETWEEN @from AND @to
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct));

        // Everything sitting on a director's desk, oldest first. An approval
        // queue sorted by date rather than size is deliberate: a small write-off
        // waiting three weeks is a worse signal than a large one waiting a day.
        var awaiting = (await conn.QueryAsync<ApprovalItem>(new CommandDefinition(
            """
            SELECT 'Shift' AS Kind,
                   si.name || ' ' || s.business_date || ' ' || s.label::text AS Description,
                   NULL::numeric AS Amount, s.closed_at AS Since,
                   (current_date - s.closed_at::date)::int AS AgeDays
              FROM shift s JOIN site si ON si.id = s.site_id
             -- A closed shift waiting for approval is DECLARED. 'CLOSED' is not a
             -- shift state, so this failed every time and the Directors page with it.
             WHERE s.state = 'DECLARED' AND s.approved_by IS NULL

            UNION ALL
            SELECT 'Shortage', st.full_name || ' -- ' || COALESCE(ss.reason, 'no reason given'),
                   ss.amount, ss.created_at,
                   (current_date - ss.created_at::date)::int
              FROM staff_shortage ss JOIN staff st ON st.id = ss.staff_id
             WHERE ss.approved_by IS NULL

            UNION ALL
            SELECT 'Expense', e.description, e.amount, e.recorded_at,
                   (current_date - e.recorded_at::date)::int
              FROM expense e
             WHERE e.approved_by IS NULL AND e.amount >= 100000

            UNION ALL
            SELECT 'Below cost',
                   'Load ' || bs.invoice_no || ' to ' || c.name,
                   round((bs.unit_cost - bs.unit_price) * bs.litres, 2),
                   bs.loaded_at, (current_date - bs.loaded_at::date)::int
              FROM bulk_sale bs JOIN credit_customer c ON c.id = bs.customer_id
             WHERE bs.approved_by IS NULL
               AND bs.unit_cost IS NOT NULL AND bs.unit_price < bs.unit_cost

             ORDER BY 4
             LIMIT 25
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var concentration = (await conn.QueryAsync<ConcentrationRow>(new CommandDefinition(
            """
            WITH total AS (SELECT NULLIF(SUM(balance), 0) AS t FROM v_credit_ageing_buckets)
            SELECT b.name AS Name, b.balance AS Balance,
                   round(b.balance / (SELECT t FROM total) * 100, 1) AS SharePct,
                   b.oldest_days AS OldestDays,
                   (b.past_terms > 0) AS Overdue
              FROM v_credit_ageing_buckets b
             WHERE b.balance > 0
             ORDER BY b.balance DESC
             LIMIT 5
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var litres = sites.Sum(s => s.Litres);

        return new DirectorsSummary(
            from, to,
            statement.FuelRevenue + statement.ShopRevenue,
            statement.GrossMargin,
            statement.NetPosition,
            litres > 0 ? Math.Round(statement.NetPosition / litres, 3) : 0,
            litres,
            loss.Litres, loss.Value,
            loss.Sold > 0 ? Math.Round(loss.Litres / loss.Sold * 100, 4) : null,
            money.Receivables, money.PastTerms,
            money.Payables, money.Overdue,
            money.CashOnHand,
            // What the business could realise if everything owed came in and
            // everything owed went out. Not a balance sheet -- a cash reality
            // check, which is the number a dealer carries in their head.
            money.CashOnHand + money.Receivables - money.Payables,
            money.OpenExceptions, money.Critical,
            below.Loads, below.Value,
            sites, awaiting, concentration);
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class LossHeadline
    {
        public decimal Litres { get; set; }
        public decimal Value { get; set; }
        public decimal Sold { get; set; }
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class MoneyHeadline
    {
        public decimal Receivables { get; set; }
        public decimal PastTerms { get; set; }
        public decimal Payables { get; set; }
        public decimal Overdue { get; set; }
        public decimal CashOnHand { get; set; }
        public int OpenExceptions { get; set; }
        public int Critical { get; set; }
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class BelowCostHeadline
    {
        public int Loads { get; set; }
        public decimal Value { get; set; }
    }
}

public static class DirectorsEndpoints
{
    public static void MapDirectors(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/reports/directors",
            async (DateOnly? from, DateOnly? to, DirectorsService s, CancellationToken ct) =>
            {
                var today = DateOnly.FromDateTime(DateTime.Today);
                var start = from ?? new DateOnly(today.Year, today.Month, 1);
                return Results.Ok(await s.GetAsync(start, to ?? today, ct));
            })
           .RequireAuthorization();
    }
}
