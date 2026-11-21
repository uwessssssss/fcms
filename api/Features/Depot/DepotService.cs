using System.Text.Json;
using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Depot;

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class BulkSaleRow
{
    public Guid Id { get; set; }
    public string InvoiceNo { get; set; } = "";
    public string TruckReg { get; set; } = "";
    public string? DriverName { get; set; }
    public string? Destination { get; set; }
    public string CustomerName { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public string TankCode { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal? MeteredLitres { get; set; }
    public decimal? DippedLitres { get; set; }
    public string Basis { get; set; } = "";
    public decimal UnitPrice { get; set; }
    public decimal? UnitCost { get; set; }
    public decimal Amount { get; set; }
    public string PaymentTerms { get; set; } = "";
    public DateTime LoadedAt { get; set; }
    public string RecordedByName { get; set; } = "";
}

public record RecordBulkSale(Guid TankId, Guid CustomerId, string InvoiceNo,
    string TruckReg, string? DriverName, string? Destination,
    decimal? MeteredLitres, decimal? DippedLitres, string Basis,
    decimal UnitPrice, string PaymentTerms, string[]? SealNumbers);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class TransferRow
{
    public Guid Id { get; set; }
    public string Reference { get; set; } = "";
    public string FromSite { get; set; } = "";
    public string FromTank { get; set; } = "";
    public string ToSite { get; set; } = "";
    public string ToTank { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal UnitCost { get; set; }
    public decimal Value { get; set; }
    public string? TruckReg { get; set; }
    public DateTime MovedAt { get; set; }
    public string RecordedByName { get; set; } = "";
}

public record RecordTransfer(string Reference, Guid FromTankId, Guid ToTankId,
    decimal Litres, string? TruckReg);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class SitePerformanceRow
{
    public Guid SiteId { get; set; }
    public string SiteCode { get; set; } = "";
    public string SiteName { get; set; } = "";
    public string SiteKind { get; set; } = "";
    public DateOnly BusinessDate { get; set; }
    public decimal RetailLitres { get; set; }
    public decimal RetailRevenue { get; set; }
    public decimal RetailCost { get; set; }
    public decimal BulkLitres { get; set; }
    public decimal BulkRevenue { get; set; }
    public decimal BulkCost { get; set; }
    public decimal Revenue { get; set; }
    public decimal Cost { get; set; }
    public decimal Margin { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class BelowCostRow
{
    public Guid Id { get; set; }
    public string InvoiceNo { get; set; } = "";
    public string TruckReg { get; set; } = "";
    public string CustomerName { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public DateTime LoadedAt { get; set; }
    public decimal Litres { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal UnitCost { get; set; }
    public decimal MarginPerLitre { get; set; }
    public decimal Margin { get; set; }
}

/// <summary>
/// The depot side of the yard.
///
/// A depot is not a station with bigger numbers. It sells whole loads against a
/// truck registration, on credit, at margins measured in single shillings per
/// litre -- and it can run an entire month below cost without anyone noticing,
/// because the volumes are large and the per-litre gap is small.
///
/// So two things are surfaced hard here that a retail system never needs:
/// whether a load went out under its own cost, and whether the two ways of
/// measuring it agreed.
/// </summary>

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class DepotDayRow
{
    public Guid ShiftId { get; set; }
    public DateOnly BusinessDate { get; set; }
    public string State { get; set; } = "";
    public DateTime OpenedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public int Loads { get; set; }
    public decimal LitresOut { get; set; }
    public decimal Revenue { get; set; }
    public decimal Cost { get; set; }
    public decimal Margin { get; set; }
    public int LoadsBelowCost { get; set; }
    public int TransfersOut { get; set; }
    public decimal TransferLitres { get; set; }
    public int DeliveriesIn { get; set; }
    public decimal DeliveredLitres { get; set; }
}

/// <summary>
/// A depot-day dip, in LITRES. See OpeningDip for why.
///
/// The screen was sending productLitres while this record still bound DipMm,
/// so every depot day opened and closed on a dip of ZERO -- no error, just a
/// tank the books believed was empty.
/// </summary>
public record DepotDip(Guid TankId, decimal ProductLitres, decimal? WaterLitres,
    decimal? DipMm, decimal? WaterDipMm,
    string? VarianceReason);

public record OpenDepotDay(Guid SiteId, List<DepotDip> Dips);

public record CloseDepotDay(List<DepotDip> Dips, string Reason, string? Note);

public sealed class DepotService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public DepotService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    /// <summary>
    /// Record a load going out.
    ///
    /// The price is NOT taken from the shift price table -- wholesale is
    /// negotiated per customer and per load, which is exactly why it needs
    /// watching. What the system does instead is capture the cost at the moment
    /// of sale, so the margin on this load can never be rewritten by a later
    /// delivery changing the weighted average.
    /// </summary>
    public async Task<object> RecordBulkSaleAsync(RecordBulkSale r, CancellationToken ct)
    {
        Require("delivery.receive");

        var litres = r.Basis == "METER" ? r.MeteredLitres : r.DippedLitres;
        if (litres is null or <= 0)
            throw new DomainException("NO_QUANTITY",
                $"Basis is {r.Basis} but no {r.Basis.ToLowerInvariant()} figure was given.");
        if (r.UnitPrice <= 0)
            throw new DomainException("INVALID_PRICE", "A price per litre is required.");
        if (string.IsNullOrWhiteSpace(r.TruckReg))
            throw new DomainException("TRUCK_REQUIRED",
                "A wholesale load needs the truck registration. It is the only thing "
                + "linking the invoice to fuel that physically left the yard.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var ctx = await conn.QuerySingleOrDefaultAsync<TankCostContext>(
                new CommandDefinition(
                    """
                    SELECT t.site_id AS SiteId, t.product_id AS ProductId,
                           COALESCE(fn_weighted_avg_cost(t.id), 0) AS UnitCost,
                           fn_book_stock(t.id) - t.dead_stock      AS Available,
                           t.code                                  AS TankCode
                      FROM tank t WHERE t.id = @tank
                    """,
                    new { tank = r.TankId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            if (ctx is null)
                throw new DomainException("UNKNOWN_TANK", "That tank does not exist.", 404);

            // Refuse here rather than letting the deferred trigger catch it, so
            // the message can say how much is actually available.
            if (litres > ctx.Available)
                throw new DomainException("NOT_ENOUGH_FUEL",
                    $"{ctx.TankCode} holds {ctx.Available:N0} sellable litres and this "
                    + $"load is {litres:N0}. Book the delivery first, or check the "
                    + "quantity -- selling fuel that is not there is how a tank ends "
                    + "up thousands of litres negative on paper.");

            var amount = Math.Round(litres.Value * r.UnitPrice, 2);

            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO bulk_sale
                  (tenant_id, site_id, tank_id, product_id, customer_id, invoice_no,
                   truck_reg, driver_name, destination, metered_litres, dipped_litres,
                   litres, basis, unit_price, amount, unit_cost, payment_terms,
                   seal_numbers, recorded_by)
                VALUES (@tenant, @site, @tank, @product, @customer, @invoiceNo,
                        @truckReg, @driver, @destination, @metered, @dipped,
                        @litres, @basis, @price, @amount, @cost, @terms,
                        @seals, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = ctx.SiteId, tank = r.TankId,
                    product = ctx.ProductId, customer = r.CustomerId,
                    invoiceNo = r.InvoiceNo.Trim(), truckReg = r.TruckReg.Trim().ToUpperInvariant(),
                    driver = r.DriverName, destination = r.Destination,
                    metered = r.MeteredLitres, dipped = r.DippedLitres,
                    litres, basis = r.Basis, price = r.UnitPrice, amount,
                    cost = ctx.UnitCost, terms = r.PaymentTerms,
                    seals = r.SealNumbers, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO fuel_movement
                  (tenant_id, site_id, tank_id, product_id, kind, litres, signed_litres,
                   unit_cost, unit_price, bulk_sale_id, occurred_at, recorded_by)
                VALUES (@tenant, @site, @tank, @product, 'BULK_OUT', @litres, -@litres,
                        @cost, @price, @sale, now(), @actor)
                """,
                new
                {
                    tenant = _user.TenantId, site = ctx.SiteId, tank = r.TankId,
                    product = ctx.ProductId, litres, cost = ctx.UnitCost,
                    price = r.UnitPrice, sale = id, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // A credit load IS a receivable. Done in the database rather than
            // here, so a load recorded by an import or a script cannot skip it
            // and so the credit limit is enforced on every path.
            var creditSaleId = await conn.ExecuteScalarAsync<Guid?>(new CommandDefinition(
                "SELECT fn_record_bulk_credit(@id)", new { id },
                transaction: _uow.Transaction, cancellationToken: ct));

            // Below cost is not an error -- a dealer may sell at a loss to move
            // ageing stock or hold a customer. It is a decision, and a decision
            // that large should be visible to somebody who did not make it.
            var belowCost = r.UnitPrice < ctx.UnitCost;
            if (belowCost)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    SELECT fn_raise_flag(@tenant, @site, NULL, 'bulk_sale', @id::text,
                             'SOLD_BELOW_COST', 'CRITICAL',
                             jsonb_build_object('invoice', @invoiceNo, 'truck', @truckReg,
                               'litres', @litres, 'price', @price, 'cost', @cost,
                               'loss', round((@cost - @price) * @litres, 2)))
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = ctx.SiteId, id,
                        invoiceNo = r.InvoiceNo, truckReg = r.TruckReg,
                        litres, price = r.UnitPrice, cost = ctx.UnitCost
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            // The two measurements disagreeing on a load worth millions is the
            // earliest sign that a gantry meter is drifting.
            decimal? divergence = null;
            if (r.MeteredLitres is > 0 && r.DippedLitres is > 0)
                divergence = r.MeteredLitres.Value - r.DippedLitres.Value;

            return new
            {
                bulkSaleId = id,
                creditSaleId,
                amount,
                unitCost = ctx.UnitCost,
                marginPerLitre = Math.Round(r.UnitPrice - ctx.UnitCost, 4),
                belowCost,
                divergenceLitres = divergence,
            };
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<BulkSaleRow>> BulkSalesAsync(DateOnly from, DateOnly to,
                                                                 CancellationToken ct)
    {
        // Depot trading figures: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view") && !_user.Can("shift.open"))
            throw new DomainException("FORBIDDEN", "This needs report.view or shift.open.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<BulkSaleRow>(new CommandDefinition(
            """
            SELECT bs.id AS Id, bs.invoice_no AS InvoiceNo, bs.truck_reg AS TruckReg,
                   bs.driver_name AS DriverName, bs.destination AS Destination,
                   c.name AS CustomerName, p.code AS ProductCode, t.code AS TankCode,
                   bs.litres AS Litres, bs.metered_litres AS MeteredLitres,
                   bs.dipped_litres AS DippedLitres, bs.basis AS Basis,
                   bs.unit_price AS UnitPrice, bs.unit_cost AS UnitCost,
                   bs.amount AS Amount, bs.payment_terms AS PaymentTerms,
                   bs.loaded_at AS LoadedAt, s.full_name AS RecordedByName
              FROM bulk_sale bs
              JOIN credit_customer c ON c.id = bs.customer_id
              JOIN product p ON p.id = bs.product_id
              JOIN tank t    ON t.id = bs.tank_id
              JOIN staff s   ON s.id = bs.recorded_by
             WHERE bs.loaded_at >= @from::date
               AND bs.loaded_at <  (@to::date + 1)
             ORDER BY bs.loaded_at DESC
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> TransferAsync(RecordTransfer r, CancellationToken ct)
    {
        Require("equipment.manage");
        if (r.Litres <= 0)
            throw new DomainException("INVALID_QUANTITY", "Litres must be more than zero.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_transfer_stock(@reference, @from, @to, @litres, @actor, @truck)",
                new
                {
                    reference = r.Reference.Trim(), from = r.FromTankId, to = r.ToTankId,
                    litres = r.Litres, actor = _user.StaffId, truck = r.TruckReg
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<TransferRow>> TransfersAsync(int days,
                                                                 CancellationToken ct)
    {
        // Depot trading figures: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view") && !_user.Can("shift.open"))
            throw new DomainException("FORBIDDEN", "This needs report.view or shift.open.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<TransferRow>(new CommandDefinition(
            """
            SELECT st.id AS Id, st.reference AS Reference,
                   fs.name AS FromSite, ft.code AS FromTank,
                   ts.name AS ToSite,   tt.code AS ToTank,
                   p.code AS ProductCode, st.litres AS Litres,
                   st.unit_cost AS UnitCost, st.value AS Value,
                   st.truck_reg AS TruckReg, st.moved_at AS MovedAt,
                   s.full_name AS RecordedByName
              FROM stock_transfer st
              JOIN site fs ON fs.id = st.from_site_id
              JOIN site ts ON ts.id = st.to_site_id
              JOIN tank ft ON ft.id = st.from_tank_id
              JOIN tank tt ON tt.id = st.to_tank_id
              JOIN product p ON p.id = st.product_id
              JOIN staff s ON s.id = st.recorded_by
             WHERE st.moved_at > now() - (@days || ' days')::interval
             ORDER BY st.moved_at DESC
            """,
            new { days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<SitePerformanceRow>> PerformanceAsync(DateOnly from,
        DateOnly to, CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<SitePerformanceRow>(new CommandDefinition(
            """
            SELECT site_id AS SiteId, site_code AS SiteCode, site_name AS SiteName,
                   site_kind AS SiteKind, business_date AS BusinessDate,
                   retail_litres AS RetailLitres, retail_revenue AS RetailRevenue,
                   retail_cost AS RetailCost, bulk_litres AS BulkLitres,
                   bulk_revenue AS BulkRevenue, bulk_cost AS BulkCost,
                   revenue AS Revenue, cost AS Cost, margin AS Margin
              FROM v_site_performance
             WHERE business_date BETWEEN @from AND @to
             ORDER BY business_date DESC, site_kind, site_code
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<BelowCostRow>> BelowCostAsync(DateOnly from,
        DateOnly to, CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<BelowCostRow>(new CommandDefinition(
            """
            SELECT id AS Id, invoice_no AS InvoiceNo, truck_reg AS TruckReg,
                   customer_name AS CustomerName, product_code AS ProductCode,
                   loaded_at AS LoadedAt, litres AS Litres, unit_price AS UnitPrice,
                   unit_cost AS UnitCost, margin_per_litre AS MarginPerLitre,
                   margin AS Margin
              FROM v_bulk_sales_below_cost
             WHERE loaded_at >= @from::date AND loaded_at < (@to::date + 1)
             ORDER BY margin ASC
            """,
            new { from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }


    /// <summary>
    /// Open the depot for the day.
    ///
    /// Dips first, before anything can be loaded out, for the same reason a
    /// station dips before assigning nozzles: the closing variance is measured
    /// against these numbers, and a day opened without them can be closed with
    /// any figure at all.
    /// </summary>
    public async Task<Guid> OpenDayAsync(OpenDepotDay r, CancellationToken ct)
    {
        Require("shift.open");
        if (r.Dips.Count == 0)
            throw new DomainException("DIPS_REQUIRED",
                "Dip every tank before opening. The closing variance is measured "
                + "against these.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                "SELECT fn_open_depot_day(@site, @actor, @dips::jsonb, NULL)",
                new
                {
                    site = r.SiteId,
                    actor = _user.StaffId,
                    dips = JsonSerializer.Serialize(r.Dips.Select(d => new
                    {
                        tank_id = d.TankId,
                        product_litres = d.ProductLitres,
                        water_litres = d.WaterLitres,
                        dip_mm = d.DipMm,
                        water_dip_mm = d.WaterDipMm,
                    })),
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Close the depot day.
    ///
    /// Runs the real close inside a SAVEPOINT when previewing, so an operator
    /// can see what the database WOULD say without committing anything. A
    /// preview computed by different code from the commit is a preview that
    /// eventually disagrees with it.
    /// </summary>
    public async Task<JsonDocument> CloseDayAsync(Guid shiftId, CloseDepotDay r,
                                                  bool preview, CancellationToken ct)
    {
        Require("shift.close");
        var conn = await _uow.ConnectionAsync(ct);

        var payload = JsonSerializer.Serialize(r.Dips.Select(d => new
        {
            tank_id = d.TankId,
            product_litres = d.ProductLitres,
            water_litres = d.WaterLitres,
            dip_mm = d.DipMm,
            water_dip_mm = d.WaterDipMm,
            variance_reason = d.VarianceReason,
        }));

        if (preview)
            await conn.ExecuteAsync(new CommandDefinition(
                "SAVEPOINT depot_close_preview",
                transaction: _uow.Transaction, cancellationToken: ct));

        try
        {
            var json = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT fn_close_depot_day(@shift, @actor, @dips::jsonb, "
                + "@reason::close_reason, @note)::text",
                new
                {
                    shift = shiftId, actor = _user.StaffId, dips = payload,
                    reason = r.Reason, note = r.Note
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (preview)
                await conn.ExecuteAsync(new CommandDefinition(
                    "ROLLBACK TO SAVEPOINT depot_close_preview",
                    transaction: _uow.Transaction, cancellationToken: ct));

            return JsonDocument.Parse(json ?? "{}");
        }
        catch (PostgresException ex)
        {
            if (preview)
                await conn.ExecuteAsync(new CommandDefinition(
                    "ROLLBACK TO SAVEPOINT depot_close_preview",
                    transaction: _uow.Transaction, cancellationToken: ct));
            throw PostgresErrors.Translate(ex);
        }
    }

    public async Task<DepotDayRow?> CurrentDayAsync(Guid siteId, CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<DepotDayRow>(new CommandDefinition(
            """
            SELECT shift_id AS ShiftId, business_date AS BusinessDate, state AS State,
                   opened_at AS OpenedAt, closed_at AS ClosedAt, loads AS Loads,
                   litres_out AS LitresOut, revenue AS Revenue, cost AS Cost,
                   margin AS Margin, loads_below_cost AS LoadsBelowCost,
                   transfers_out AS TransfersOut, transfer_litres AS TransferLitres,
                   deliveries_in AS DeliveriesIn, delivered_litres AS DeliveredLitres
              FROM v_depot_day_activity
             WHERE site_id = @site AND state = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1
            """,
            new { site = siteId },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    public async Task<IReadOnlyList<DepotDayRow>> DayHistoryAsync(Guid siteId, int days,
                                                                  CancellationToken ct)
    {
        // Depot trading figures: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view") && !_user.Can("shift.open"))
            throw new DomainException("FORBIDDEN", "This needs report.view or shift.open.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DepotDayRow>(new CommandDefinition(
            """
            SELECT shift_id AS ShiftId, business_date AS BusinessDate, state AS State,
                   opened_at AS OpenedAt, closed_at AS ClosedAt, loads AS Loads,
                   litres_out AS LitresOut, revenue AS Revenue, cost AS Cost,
                   margin AS Margin, loads_below_cost AS LoadsBelowCost,
                   transfers_out AS TransfersOut, transfer_litres AS TransferLitres,
                   deliveries_in AS DeliveriesIn, delivered_litres AS DeliveredLitres
              FROM v_depot_day_activity
             WHERE site_id = @site
               AND business_date > current_date - @days
             ORDER BY business_date DESC
            """,
            new { site = siteId, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>Dapper target: class with settable properties.</summary>
    internal sealed class TankCostContext
    {
        public Guid SiteId { get; set; }
        public Guid ProductId { get; set; }
        public decimal UnitCost { get; set; }
        public decimal Available { get; set; }
        public string TankCode { get; set; } = "";
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

public static class DepotEndpoints
{
    public static void MapDepot(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/depot").RequireAuthorization();

        g.MapGet("/bulk-sales", async (DateOnly from, DateOnly to, DepotService s,
                                       CancellationToken ct) =>
            Results.Ok(await s.BulkSalesAsync(from, to, ct)));

        g.MapPost("/bulk-sales", async (RecordBulkSale r, DepotService s,
                                        CancellationToken ct) =>
            Results.Ok(await s.RecordBulkSaleAsync(r, ct)));

        g.MapGet("/transfers", async (int? days, DepotService s, CancellationToken ct) =>
            Results.Ok(await s.TransfersAsync(days ?? 60, ct)));

        g.MapPost("/transfers", async (RecordTransfer r, DepotService s,
                                       CancellationToken ct) =>
            Results.Ok(new { transferId = await s.TransferAsync(r, ct) }));

        g.MapGet("/performance", async (DateOnly from, DateOnly to, DepotService s,
                                        CancellationToken ct) =>
            Results.Ok(await s.PerformanceAsync(from, to, ct)));


        g.MapGet("/day/current", async (Guid site, DepotService s, CancellationToken ct) =>
        {
            var day = await s.CurrentDayAsync(site, ct);
            return day is null ? Results.NoContent() : Results.Ok(day);
        });

        g.MapGet("/day/history", async (Guid site, int? days, DepotService s,
                                        CancellationToken ct) =>
            Results.Ok(await s.DayHistoryAsync(site, days ?? 30, ct)));

        g.MapPost("/day/open", async (OpenDepotDay r, DepotService s, CancellationToken ct) =>
            Results.Ok(new { shiftId = await s.OpenDayAsync(r, ct) }));

        g.MapPost("/day/{id:guid}/close", async (Guid id, CloseDepotDay r, bool? preview,
                                                 DepotService s, CancellationToken ct) =>
            Results.Ok(await s.CloseDayAsync(id, r, preview ?? false, ct)));

        g.MapGet("/below-cost", async (DateOnly from, DateOnly to, DepotService s,
                                       CancellationToken ct) =>
            Results.Ok(await s.BelowCostAsync(from, to, ct)));
    }
}
