using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Credit;

/// <summary>Dapper target: one agreed price. See docs/DAPPER.md.</summary>
public sealed class CustomerPriceRow
{
    public Guid Id { get; set; }
    public Guid ProductId { get; set; }
    public string Product { get; set; } = "";
    /// <summary>A fixed agreed price, or null when the agreement is a margin.</summary>
    public decimal? Price { get; set; }
    /// <summary>Per litre on the pump price ("pump + 80"), or null for a fixed price.</summary>
    public decimal? Margin { get; set; }
    public DateTime ValidFrom { get; set; }
    public DateTime? ValidTo { get; set; }
    public string Reason { get; set; } = "";
    public string AuthorisedBy { get; set; } = "";
    public bool InForce { get; set; }
}

/// <summary>Exactly one of Price (fixed) or Margin (on the pump price).</summary>
public record AgreePrice(Guid ProductId, decimal? Price, decimal? Margin, string Reason);

/// <summary>
/// Agreed prices for credit customers (migration 600): a transporter billed a
/// premium for credit, a bulk buyer below the pump. The customer is billed the
/// agreed price; the attendant still answers for the pump value, and the
/// close settles the difference as PRICE_AGREEMENT.
///
/// An agreement is set by a manager or head office, never edited, and never
/// backdated -- sales already billed stay as billed. Agreeing a new price for
/// a grade ends the one in force at the same moment.
/// </summary>
public sealed class CustomerPriceService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public CustomerPriceService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    public async Task<IReadOnlyList<CustomerPriceRow>> ListAsync(Guid customerId, CancellationToken ct)
    {
        Require(alsoView: true);
        var conn = await _uow.ConnectionAsync(ct);
        var rows = await conn.QueryAsync<CustomerPriceRow>(new CommandDefinition(
            """
            SELECT cp.id AS Id, cp.product_id AS ProductId, p.code AS Product, cp.price AS Price, cp.margin AS Margin,
                   cp.valid_from AS ValidFrom, cp.valid_to AS ValidTo, cp.reason AS Reason,
                   st.full_name AS AuthorisedBy,
                   (cp.valid_from <= now() AND (cp.valid_to IS NULL OR cp.valid_to > now())) AS InForce
              FROM customer_price cp
              JOIN product p ON p.id = cp.product_id
              JOIN staff st ON st.id = cp.authorised_by
             WHERE cp.customer_id = @customer
             ORDER BY cp.valid_from DESC
            """,
            new { customer = customerId }, transaction: _uow.Transaction, cancellationToken: ct));
        return rows.ToList();
    }

    public async Task<Guid> AgreeAsync(Guid customerId, AgreePrice req, CancellationToken ct)
    {
        Require();
        if ((req.Price is null) == (req.Margin is null))
            throw new DomainException("PRICE_OR_MARGIN",
                "Agree either a fixed price or a margin on the pump price -- one of the two.");
        if (req.Price is <= 0)
            throw new DomainException("INVALID_PRICE", "An agreed price is more than zero.");
        if (req.Margin is 0)
            throw new DomainException("INVALID_PRICE", "A margin of zero is the pump price: end the agreement instead.");
        if (string.IsNullOrWhiteSpace(req.Reason))
            throw new DomainException("REASON_REQUIRED",
                "Say what the agreement is -- a contract, a volume deal, credit terms.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            // End the agreement in force for this grade, then start the new
            // one at the same moment: no gap in which the customer would be
            // billed the pump price, no overlap.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE customer_price SET valid_to = now(), ended_by = @actor
                 WHERE customer_id = @customer AND product_id = @product
                   AND valid_from <= now() AND valid_to IS NULL
                """,
                new { customer = customerId, product = req.ProductId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO customer_price (tenant_id, customer_id, product_id, price, margin, reason, authorised_by)
                VALUES (@tenant, @customer, @product, @price, @margin, @reason, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, customer = customerId, product = req.ProductId,
                    price = req.Price, margin = req.Margin, reason = req.Reason.Trim(), actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task EndAsync(Guid agreementId, CancellationToken ct)
    {
        Require();
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var n = await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE customer_price SET valid_to = GREATEST(now(), valid_from + interval '1 second'), ended_by = @actor
                 WHERE id = @id AND valid_to IS NULL
                """,
                new { id = agreementId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
            if (n == 0)
                throw new DomainException("NOT_FOUND", "No agreement in force with that id.", 404);
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    private void Require(bool alsoView = false)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (_user.Can("price.execute") && _user.Can("credit_customer.manage"))
            return;
        if (alsoView && (_user.Can("credit_sale.record") || _user.Can("report.view")))
            return;
        throw new DomainException("FORBIDDEN", "Agreed prices are set by a manager or head office.", 403);
    }
}

public static class CustomerPriceEndpoints
{
    public static void MapCustomerPrices(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/credit").RequireAuthorization();

        g.MapGet("/customers/{id:guid}/prices",
            async (Guid id, CustomerPriceService s, CancellationToken ct) => Results.Ok(await s.ListAsync(id, ct)));

        g.MapPost("/customers/{id:guid}/prices",
            async (Guid id, AgreePrice req, CustomerPriceService s, CancellationToken ct) =>
                Results.Ok(new { customerPriceId = await s.AgreeAsync(id, req, ct) }));

        g.MapPost("/prices/{id:guid}/end",
            async (Guid id, CustomerPriceService s, CancellationToken ct) =>
            {
                await s.EndAsync(id, ct);
                return Results.NoContent();
            });
    }
}
