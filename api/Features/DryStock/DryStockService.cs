using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.DryStock;

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class DryItemView
{
    public Guid ItemId { get; set; }
    public string Sku { get; set; } = "";
    public string Name { get; set; } = "";
    public string Category { get; set; } = "";
    public string SellUnit { get; set; } = "";
    public decimal OnHand { get; set; }
    public decimal ReorderLevel { get; set; }
    public bool NeedsReorder { get; set; }
    public decimal? UnitPrice { get; set; }
    public bool IsCylinder { get; set; }
    public string? CylinderState { get; set; }
    public Guid? ExchangePairId { get; set; }
}

public record DrySaleLineInput(Guid ItemId, decimal Qty, Guid? ExchangeInItemId);

public record RecordDrySale(Guid SellerId, string? ReceiptNo, string? CustomerRef,
    List<DrySaleLineInput> Lines);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class DrySaleView
{
    public Guid Id { get; set; }
    /// <summary>Who sold it. The close needs a cash-up for everyone who sold.</summary>
    public Guid SellerId { get; set; }
    public string SellerName { get; set; } = "";
    public string? ReceiptNo { get; set; }
    public decimal TotalAmount { get; set; }
    public DateTime RecordedAt { get; set; }
}

/// <summary>A new shop or lubricant item, with its first selling price.</summary>
/// <param name="Sku">The shelf code, unique within the company.</param>
/// <param name="Name">What it is called on the shelf and on a receipt.</param>
/// <param name="Category">
/// LUBRICANT, SHOP, TYRE, ACCESSORY or SERVICE. LPG is refused here: a
/// cylinder is a full/empty pair with a deposit and needs its own form.
/// </param>
/// <param name="SellUnit">EACH, CARTON, LITRE, KG, PAIR or SET.</param>
/// <param name="ReorderLevel">
/// The count at which it needs ordering. Zero means no reminder.
/// </param>
/// <param name="UnitPrice">
/// The first selling price, optional. Stored as a price row rather than a
/// column, so a sale is valued at the price in force when it was rung up.
/// </param>
public record CreateDryItem(string Sku, string Name, string Category, string SellUnit,
    decimal ReorderLevel, decimal? UnitPrice);

public record ReceiveStock(Guid ItemId, decimal Qty, decimal? UnitCost, string? Note);

public record AdjustStock(Guid ItemId, decimal Qty, string Kind, string Note);

public sealed class DryStockService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public DryStockService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly HashSet<string> AdjustKinds = new(StringComparer.OrdinalIgnoreCase)
        { "DAMAGE_OUT", "EXPIRY_OUT", "OWN_USE_OUT", "CUSTOMER_RETURN_IN",
          "TRANSFER_IN", "TRANSFER_OUT" };

    private static readonly HashSet<string> CompanyWide =
        new(StringComparer.OrdinalIgnoreCase) { "HEAD_OFFICE", "AUDITOR", "SYSTEM_ADMIN" };

    /// <summary>Shop and lubricant items, with one site's stock and price. A
    /// station sees its own; head office names the site (it holds no stock, so
    /// its own site read 0 of everything with no prices).</summary>
    public async Task<IReadOnlyList<DryItemView>> ItemsAsync(string? category, Guid? siteId,
                                                             CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DryItemView>(new CommandDefinition(
            """
            SELECT i.id AS ItemId, i.sku, i.name, i.category, i.sell_unit AS SellUnit,
                   COALESCE(oh.on_hand, 0) AS OnHand,
                   i.reorder_level AS ReorderLevel,
                   COALESCE(oh.on_hand, 0) <= i.reorder_level AND i.is_sellable AS NeedsReorder,
                   pr.unit_price AS UnitPrice,
                   i.is_cylinder AS IsCylinder, i.cylinder_state AS CylinderState,
                   i.exchange_pair_id AS ExchangePairId
              FROM dry_item i
              LEFT JOIN v_dry_stock_on_hand oh
                     ON oh.item_id = i.id AND oh.site_id = @site
              LEFT JOIN LATERAL (
                SELECT unit_price FROM dry_price
                 WHERE item_id = i.id AND site_id = @site AND effective_from <= now()
                 ORDER BY effective_from DESC LIMIT 1) pr ON TRUE
             WHERE i.is_active
               AND (@category::text IS NULL OR i.category = @category)
             ORDER BY i.category, i.name
            """,
            new { site = CompanyWide.Contains(_user.Role) && siteId is Guid g ? g : _user.SiteId, category },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Record a shop or lubricant sale.
    ///
    /// SellerId is the attendant or shop hand — the SUBJECT, who does not sign
    /// in. The supervisor recording it is the AUTHOR. The sale then settles into
    /// that seller's cash-up at close, under the identical balance rule as a
    /// litre of diesel: a bottle of Helix that leaves the shelf must be either
    /// paid for or declared short.
    ///
    /// LPG: naming ExchangeInItemId turns a refill into a full cylinder out AND
    /// an empty cylinder in, so empties become stock you can count rather than a
    /// thing people remember.
    /// </summary>
    public async Task<Guid> RecordSaleAsync(Guid shiftId, RecordDrySale req,
                                            CancellationToken ct)
    {
        Require("dry_sale.record");
        if (req.Lines.Count == 0)
            throw new DomainException("NO_LINES", "A sale needs at least one item.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var priced = new List<(Guid ItemId, decimal Qty, decimal Price, decimal Amount,
                Guid? ExchangeIn)>();
            decimal total = 0;

            foreach (var line in req.Lines)
            {
                if (line.Qty <= 0)
                    throw new DomainException("INVALID_QTY", "Quantity must be more than zero.");

                // Price from the catalogue, not from the client.
                var price = await conn.ExecuteScalarAsync<decimal>(new CommandDefinition(
                    "SELECT fn_dry_price(@site, @item)",
                    new { site = _user.SiteId, item = line.ItemId },
                    transaction: _uow.Transaction, cancellationToken: ct));

                var amount = Math.Round(line.Qty * price, 2);
                total += amount;
                priced.Add((line.ItemId, line.Qty, price, amount, line.ExchangeInItemId));
            }

            var currency = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT base_currency FROM tenant WHERE id = @t", new { t = _user.TenantId },
                transaction: _uow.Transaction, cancellationToken: ct));

            var saleId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO dry_sale
                  (tenant_id, site_id, shift_id, seller_id, receipt_no, customer_ref,
                   total_amount, currency, recorded_by)
                VALUES (@tenant, @site, @shift, @seller, @receipt, @customer,
                        @total, @currency, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, shift = shiftId,
                    seller = req.SellerId, receipt = req.ReceiptNo,
                    customer = req.CustomerRef, total, currency, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            foreach (var p in priced)
            {
                var lineId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO dry_sale_line
                      (tenant_id, sale_id, item_id, qty, unit_price, line_amount,
                       exchange_in_item_id)
                    VALUES (@tenant, @sale, @item, @qty, @price, @amount, @exchange)
                    RETURNING id
                    """,
                    new
                    {
                        tenant = _user.TenantId, sale = saleId, item = p.ItemId,
                        qty = p.Qty, price = p.Price, amount = p.Amount,
                        exchange = p.ExchangeIn
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

                // Stock out. The deferred trigger refuses this at COMMIT if it
                // would take on-hand negative — an unbooked delivery or a
                // miskey, either way it stops at the counter.
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO dry_movement
                      (tenant_id, site_id, item_id, shift_id, kind, qty, signed_qty,
                       unit_price, dry_sale_line_id, recorded_by)
                    VALUES (@tenant, @site, @item, @shift, 'SALE_OUT', @qty, -@qty,
                            @price, @line, @actor)
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId, item = p.ItemId,
                        shift = shiftId, qty = p.Qty, price = p.Price, line = lineId,
                        actor = _user.StaffId
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

                // The empty cylinder coming back.
                if (p.ExchangeIn is { } emptyId)
                    await conn.ExecuteAsync(new CommandDefinition(
                        """
                        INSERT INTO dry_movement
                          (tenant_id, site_id, item_id, shift_id, kind, qty, signed_qty,
                           dry_sale_line_id, note, recorded_by)
                        VALUES (@tenant, @site, @item, @shift, 'EXCHANGE_IN', @qty, @qty,
                                @line, 'Cylinder exchange', @actor)
                        """,
                        new
                        {
                            tenant = _user.TenantId, site = _user.SiteId, item = emptyId,
                            shift = shiftId, qty = p.Qty, line = lineId, actor = _user.StaffId
                        },
                        transaction: _uow.Transaction, cancellationToken: ct));
            }

            return saleId;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<DrySaleView>> SalesForShiftAsync(Guid shiftId,
                                                                     CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);
        return (await conn.QueryAsync<DrySaleView>(new CommandDefinition(
            """
            SELECT ds.id, ds.seller_id AS SellerId, st.full_name AS SellerName, ds.receipt_no AS ReceiptNo,
                   ds.total_amount AS TotalAmount, ds.recorded_at AS RecordedAt
              FROM dry_sale ds JOIN staff st ON st.id = ds.seller_id
             WHERE ds.shift_id = @shift ORDER BY ds.recorded_at DESC
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task ReceiveAsync(ReceiveStock req, CancellationToken ct)
    {
        Require("dry_stock.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO dry_movement
                  (tenant_id, site_id, item_id, kind, qty, signed_qty, unit_cost,
                   note, recorded_by)
                VALUES (@tenant, @site, @item, 'PURCHASE_IN', @qty, @qty, @cost,
                        @note, @actor)
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, item = req.ItemId,
                    qty = req.Qty, cost = req.UnitCost, note = req.Note, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Write-offs and transfers. The schema requires a note on anything that
    /// removes stock without a sale, because that is money leaving the business
    /// and it needs a name against it.
    /// </summary>
    public async Task AdjustAsync(AdjustStock req, CancellationToken ct)
    {
        Require("dry_stock.manage");
        if (!AdjustKinds.Contains(req.Kind))
            throw new DomainException("INVALID_KIND",
                $"'{req.Kind}' is not an adjustment. Use one of: {string.Join(", ", AdjustKinds)}");
        if ((req.Note ?? "").Trim().Length < 5)
            throw new DomainException("REASON_REQUIRED",
                "Say what happened to it. Stock does not leave a station by itself.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO dry_movement
                  (tenant_id, site_id, item_id, kind, qty, signed_qty, note, recorded_by)
                VALUES (@tenant, @site, @item, @kind::dry_movement_kind, @qty,
                        @qty * fn_dry_sign(@kind::dry_movement_kind), @note, @actor)
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, item = req.ItemId,
                    kind = req.Kind.ToUpperInvariant(), qty = req.Qty,
                    note = req.Note!.Trim(), actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    private static readonly string[] Categories =
        { "LUBRICANT", "LPG", "SHOP", "TYRE", "ACCESSORY", "SERVICE" };
    private static readonly string[] SellUnits =
        { "EACH", "CARTON", "LITRE", "KG", "PAIR", "SET" };

    /// <summary>
    /// Create an item. Stock starts at ZERO -- it arrives through a receive, so
    /// every unit on the shelf has a movement behind it. An item created with
    /// an opening quantity typed in would be stock nobody can account for.
    ///
    /// The price is a dry_price row, not a column, because prices change and
    /// a sale must be valued at the price in force when it was rung up.
    /// Cylinders are not created here: an LPG cylinder is a full/empty pair
    /// with a deposit, which needs its own form.
    /// </summary>
    public async Task<Guid> CreateItemAsync(CreateDryItem req, CancellationToken ct)
    {
        Require("dry_stock.manage");

        var category = req.Category.ToUpperInvariant();
        var unit = req.SellUnit.ToUpperInvariant();
        if (!Categories.Contains(category))
            throw new DomainException("UNKNOWN_CATEGORY",
                $"Category must be one of {string.Join(", ", Categories)}.", 422);
        if (!SellUnits.Contains(unit))
            throw new DomainException("UNKNOWN_UNIT",
                $"Sell unit must be one of {string.Join(", ", SellUnits)}.", 422);
        if (string.IsNullOrWhiteSpace(req.Sku) || string.IsNullOrWhiteSpace(req.Name))
            throw new DomainException("MISSING_FIELDS", "An item needs a SKU and a name.", 422);
        if (category == "LPG")
            throw new DomainException("CYLINDER_NEEDS_ITS_OWN_FORM",
                "An LPG cylinder is a full/empty pair with a deposit, so it is not "
                + "created as a single item here.", 422);

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO dry_item (tenant_id, sku, name, category, sell_unit, reorder_level)
                VALUES (@tenant, @sku, @name, @category, @unit, @reorder)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, sku = req.Sku.Trim().ToUpperInvariant(),
                    name = req.Name.Trim(), category, unit, reorder = req.ReorderLevel,
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (req.UnitPrice is > 0)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO dry_price (tenant_id, site_id, item_id, unit_price, effective_from, set_by)
                    VALUES (@tenant, @site, @id, @price, now(), @actor)
                    """,
                    new { tenant = _user.TenantId, site = _user.SiteId, id, price = req.UnitPrice, actor = _user.StaffId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
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

public static class DryStockEndpoints
{
    public static void MapDryStock(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/dry-stock").RequireAuthorization();

        g.MapGet("/items", async (string? category, Guid? siteId, DryStockService s, CancellationToken ct) =>
            Results.Ok(await s.ItemsAsync(category, siteId, ct)));

        g.MapPost("/shifts/{shiftId:guid}/sales",
            async (Guid shiftId, RecordDrySale req, DryStockService s, CancellationToken ct) =>
                Results.Ok(new { drySaleId = await s.RecordSaleAsync(shiftId, req, ct) }));

        g.MapGet("/shifts/{shiftId:guid}/sales",
            async (Guid shiftId, DryStockService s, CancellationToken ct) =>
                Results.Ok(await s.SalesForShiftAsync(shiftId, ct)));

        g.MapPost("/items", async (CreateDryItem req, DryStockService s, CancellationToken ct) =>
            Results.Ok(new { itemId = await s.CreateItemAsync(req, ct) }));

        g.MapPost("/receive", async (ReceiveStock req, DryStockService s, CancellationToken ct) =>
        {
            await s.ReceiveAsync(req, ct);
            return Results.Ok(new { received = true });
        });

        g.MapPost("/adjust", async (AdjustStock req, DryStockService s, CancellationToken ct) =>
        {
            await s.AdjustAsync(req, ct);
            return Results.Ok(new { adjusted = true });
        });
    }
}
