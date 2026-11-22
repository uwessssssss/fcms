using System.Text.Json;
using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Features.Shifts;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Operations;

// ---------------------------------------------------------------------------
// Six things the schema supports and nothing could reach. Each was found by
// listing tables and functions with no C# referencing them at all — a gap no
// frontend/backend contract check can see, because both sides agreed on
// nothing existing.
// ---------------------------------------------------------------------------

public record SchedulePriceChange(Guid ProductId, decimal NewPrice,
    DateTime EffectiveFrom, string Source, string? DirectiveRef, string? DocumentUrl);

public record ExecutePriceBreak(List<ClosingReading> Readings, List<ClosingDip> Dips,
    List<CashUpDeclaration> CashUps, List<RosterLine> NextRoster);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class PendingPriceView
{
    public Guid Id { get; set; }
    public string ProductCode { get; set; } = "";
    public decimal? OldPrice { get; set; }
    public decimal NewPrice { get; set; }
    public DateTime EffectiveFrom { get; set; }
    public string Source { get; set; } = "";
    public string? DirectiveRef { get; set; }
}

public record RecordDiscount(Guid AttendantId, decimal Amount, decimal? Litres,
    string Reason, string? CustomerRef);

public record BeginStockCount(string Kind, List<Guid> TankIds, Guid? WitnessedBy);
/// <summary>
/// A tank counted during a stock take, in LITRES.
///
/// Dips are entered as volume throughout -- see 190_dips_in_litres.sql. This
/// record was left on millimetres when the rest was converted, so the screen
/// said "litres" and the server read the number as a stick reading. A tank
/// holding 10,000 litres would have been recorded as 10,000mm, which is deeper
/// than the tank, and the count would have looked like an enormous gain.
/// </summary>
public record CountTank(Guid TankId, decimal ProductLitres, string? VarianceReason);
/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class StockCountLine
{
    public Guid TankId { get; set; }
    public string TankCode { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public decimal BookLitres { get; set; }
    public decimal CountedLitres { get; set; }
    public decimal VarianceLitres { get; set; }
    public string? VarianceReason { get; set; }
}

public record RecordBanking(decimal Amount, string BankName, string? AccountRef,
    string SlipNo, string? SlipUrl, DateOnly BusinessDate);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class CashPositionView
{
    public DateOnly BusinessDate { get; set; }
    public decimal CashCollected { get; set; }
    public decimal CashBanked { get; set; }
    /// <summary>That day's cash collected minus that day's cash banked. Can be negative: the day earlier cash was banked.</summary>
    public decimal OnHand { get; set; }
    /// <summary>
    /// Cash in the station at the end of this day: every shilling ever
    /// collected minus every shilling ever banked. THIS is the figure to
    /// read. Summing OnHand over a window got it wrong both ways -- dropping
    /// the negative day that banked Monday's cash overstated it, and cash
    /// collected before the window but banked inside it understated it.
    /// </summary>
    public decimal RunningOnHand { get; set; }
}

public record RecoverShortage(Guid StaffId, Guid? ShortageId, decimal Amount,
    string Method, bool Acknowledged, string? EvidenceUrl);


public record CalibrationPoint(decimal DipMm, decimal Litres);

// ---------------------------------------------------------------------------
public sealed class OperationsService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;
    private readonly ShiftService _shifts;

    public OperationsService(IUnitOfWork uow, ICurrentUser user, ShiftService shifts)
        => (_uow, _user, _shifts) = (uow, user, shifts);

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    // === PRICE ===============================================================

    public async Task<Guid> SchedulePriceAsync(SchedulePriceChange req, CancellationToken ct)
    {
        Require("price.execute");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO price_change
                  (tenant_id, site_id, product_id, old_price, new_price, effective_from,
                   source, directive_ref, document_url, status, authorised_by)
                SELECT @tenant, @site, @product,
                       (SELECT new_price FROM price_change
                         WHERE site_id = @site AND product_id = @product AND status='EXECUTED'
                         ORDER BY effective_from DESC LIMIT 1),
                       @price, @from, @source, @ref, @doc, 'PENDING', @actor
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, product = req.ProductId,
                    price = req.NewPrice, from = req.EffectiveFrom,
                    source = req.Source, @ref = req.DirectiveRef, doc = req.DocumentUrl,
                    actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<PendingPriceView>> PendingPricesAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<PendingPriceView>(new CommandDefinition(
            """
            SELECT pc.id, p.code AS ProductCode, pc.old_price AS OldPrice,
                   pc.new_price AS NewPrice, pc.effective_from AS EffectiveFrom,
                   pc.source, pc.directive_ref AS DirectiveRef
              FROM price_change pc JOIN product p ON p.id = pc.product_id
             WHERE pc.site_id = @site AND pc.status = 'PENDING'
             ORDER BY pc.effective_from
            """,
            new { site = _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Execute a price change.
    ///
    /// This is your original requirement — a price change closes the running
    /// shift and reopens at the new price — and it is one database call because
    /// it has to be atomic. Closing the shift, moving the price, and opening the
    /// successor as three requests leaves a station that has closed and cannot
    /// reopen, in the middle of the busiest thing that happens to it.
    ///
    /// The price must move BETWEEN the close and the open, so the successor's
    /// captured prices are the new ones. fn_execute_price_break does that
    /// ordering internally; nothing here can get it wrong.
    /// </summary>
    public async Task<object> ExecutePriceBreakAsync(Guid priceChangeId,
        ExecutePriceBreak req, CancellationToken ct)
    {
        Require("price.execute");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var raw = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                """
                SELECT fn_execute_price_break(@id, @actor, @readings::jsonb,
                                              @dips::jsonb, @cashups::jsonb,
                                              @roster::jsonb)::text
                """,
                new
                {
                    id = priceChangeId, actor = _user.StaffId,
                    readings = JsonSerializer.Serialize(req.Readings.Select(r => new
                    {
                        assignment_id = r.AssignmentId,
                        volume_totalizer = r.VolumeTotalizer,
                        electronic_totalizer = r.ElectronicTotalizer,
                        is_rollover = r.IsRollover,
                        photo_url = r.PhotoUrl
                    }), Json),
                    dips = JsonSerializer.Serialize(req.Dips.Select(d => new
                    {
                        tank_id = d.TankId, product_litres = d.ProductLitres,
                        water_litres = d.WaterLitres,
                        dip_mm = d.DipMm, water_dip_mm = d.WaterDipMm
                    }), Json),
                    cashups = JsonSerializer.Serialize(req.CashUps.Select(c => new
                    {
                        attendant_id = c.AttendantId, cash = c.Cash,
                        tenders = (c.Tenders ?? new()).Select(t => new
                        {
                            channel_code = t.ChannelCode, amount = t.Amount,
                            reference = t.Reference
                        }),
                        shortage_reason = c.ShortageReason
                    }), Json),
                    roster = JsonSerializer.Serialize(req.NextRoster.Select(r => new
                    {
                        nozzle_id = r.NozzleId, attendant_id = r.AttendantId,
                        volume_totalizer = r.VolumeTotalizer
                    }), Json)
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            return JsonDocument.Parse(raw ?? "{}").RootElement.Clone();
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === DISCOUNTS ===========================================================

    /// <summary>
    /// Value forgiven at the pump.
    ///
    /// Without this an attendant who was told to give a haulier ten shillings a
    /// litre is short by exactly that amount and cannot balance — the same shape
    /// of failure as the missing credit screen. The schema refuses a
    /// self-authorised discount, so the authoriser is always the signed-in
    /// operator and never the attendant.
    /// </summary>
    public async Task<Guid> RecordDiscountAsync(Guid shiftId, RecordDiscount req,
                                                CancellationToken ct)
    {
        Require("discount.authorise");
        if (req.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "A discount must be more than zero.");
        if ((req.Reason ?? "").Trim().Length < 4)
            throw new DomainException("REASON_REQUIRED",
                "Say why the money was given away. This is a cost the dealer carries.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO discount_grant
                  (tenant_id, site_id, shift_id, staff_id, customer_ref, litres,
                   amount, reason, authorised_by)
                VALUES (@tenant, @site, @shift, @attendant, @customer, @litres,
                        @amount, @reason, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, shift = shiftId,
                    attendant = req.AttendantId, customer = req.CustomerRef,
                    litres = req.Litres, amount = req.Amount,
                    reason = req.Reason!.Trim(), actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === STOCK TAKE ==========================================================

    public async Task<Guid> BeginStockCountAsync(BeginStockCount req, CancellationToken ct)
    {
        Require("stock_count.conduct");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO stock_count
                  (tenant_id, site_id, shift_id, counted_on, kind, counted_by, witnessed_by)
                SELECT @tenant, @site,
                       (SELECT id FROM shift WHERE site_id = @site
                         AND state IN ('OPEN','COUNTING') LIMIT 1),
                       current_date, @kind, @actor, @witness
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, kind = req.Kind,
                    actor = _user.StaffId, witness = req.WitnessedBy
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // Book stock is snapshotted the moment counting starts. Reading it
            // again at approval time would compare the count to a book that has
            // moved since — every litre sold during the count would look like a
            // loss.
            foreach (var tankId in req.TankIds)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO stock_count_tank
                      (tenant_id, count_id, tank_id, book_litres, counted_litres)
                    VALUES (@tenant, @count, @tank, fn_book_stock(@tank), 0)
                    """,
                    new { tenant = _user.TenantId, count = id, tank = tankId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task CountTankAsync(Guid countId, CountTank req, CancellationToken ct)
    {
        Require("stock_count.conduct");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var dipId = await conn.ExecuteScalarAsync<long>(new CommandDefinition(
                """
                -- Litres, entered directly. This used to take a stick reading
                -- and convert through the calibration chart; the chart is no
                -- longer in the flow because a linear placeholder made every
                -- converted litre wrong in a plausible-looking way.
                INSERT INTO dip_reading
                  (tenant_id, site_id, tank_id, context,
                   gross_litres, water_litres, product_litres, evidence,
                   recorded_by, captured_at)
                SELECT @tenant, t.site_id, @tank, 'STOCK_TAKE',
                       @litres, 0, @litres, 'PENDING', @actor, now()
                  FROM tank t WHERE t.id = @tank
                RETURNING id
                """,
                new { tenant = _user.TenantId, tank = req.TankId,
                      litres = req.ProductLitres, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE stock_count_tank
                   SET dip_id = @dip,
                       counted_litres = (SELECT product_litres FROM dip_reading WHERE id = @dip),
                       variance_reason = @reason
                 WHERE count_id = @count AND tank_id = @tank
                """,
                new { dip = dipId, count = countId, tank = req.TankId, reason = req.VarianceReason },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<StockCountLine>> StockCountLinesAsync(Guid countId,
                                                                          CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireStockCountAsync(conn, _uow, countId, ct);
        return (await conn.QueryAsync<StockCountLine>(new CommandDefinition(
            """
            SELECT sct.tank_id AS TankId, t.code AS TankCode, p.code AS ProductCode,
                   sct.book_litres AS BookLitres, sct.counted_litres AS CountedLitres,
                   sct.variance_litres AS VarianceLitres,
                   sct.variance_reason AS VarianceReason
              FROM stock_count_tank sct
              JOIN tank t ON t.id = sct.tank_id
              JOIN product p ON p.id = t.product_id
             WHERE sct.count_id = @id ORDER BY t.code
            """,
            new { id = countId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<object> PostStockCountAsync(Guid countId, CancellationToken ct)
    {
        Require("stock_count.post");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE stock_count SET status='APPROVED', approved_by=@actor, approved_at=now()
                 WHERE id = @id AND status IN ('COUNTING','COUNTED')
                """,
                new { id = countId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            var raw = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT fn_post_stock_count(@id, @actor)::text",
                new { id = countId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            return JsonDocument.Parse(raw ?? "{}").RootElement.Clone();
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === BANKING (audit H2) ==================================================

    /// <summary>
    /// Cash out of the drawer and into a bank.
    ///
    /// The audit called this out and it stayed unbuilt for longer than it should
    /// have: without it the cash trail ends at the supervisor's drawer. Cash is
    /// counted at cash-up, and then nothing in the system ever asks where it
    /// went. v_cash_position closes the loop — collected minus banked is the
    /// float on hand, and a float that grows without explanation is the finding.
    /// </summary>
    public async Task<Guid> RecordBankingAsync(RecordBanking req, CancellationToken ct)
    {
        Require("banking.record");
        if (req.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "A deposit must be more than zero.");
        if (string.IsNullOrWhiteSpace(req.SlipNo))
            throw new DomainException("SLIP_REQUIRED",
                "Record the deposit slip number. A deposit nobody can look up is not evidence.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO banking
                  (tenant_id, site_id, business_date, amount, currency, bank_name,
                   account_ref, slip_no, slip_url, banked_by)
                SELECT @tenant, @site, @date, @amount, t.base_currency, @bank,
                       @account, @slip, @url, @actor
                  FROM tenant t WHERE t.id = @tenant
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, date = req.BusinessDate,
                    amount = req.Amount, bank = req.BankName, account = req.AccountRef,
                    slip = req.SlipNo, url = req.SlipUrl, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<CashPositionView>> CashPositionAsync(int days,
                                                                         CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var wide = _user.Role is "HEAD_OFFICE" or "SYSTEM_ADMIN";
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<CashPositionView>(new CommandDefinition(
            """
            SELECT BusinessDate, CashCollected, CashBanked, OnHand, RunningOnHand
              FROM (
                SELECT business_date                                 AS BusinessDate,
                       SUM(cash_collected)                           AS CashCollected,
                       SUM(cash_banked)                              AS CashBanked,
                       SUM(on_hand)                                  AS OnHand,
                       -- Over ALL history, then windowed: a window-only sum
                       -- misses cash collected before it and banked inside it.
                       SUM(SUM(on_hand)) OVER (ORDER BY business_date) AS RunningOnHand
                  FROM v_cash_position
                 WHERE (@site::uuid IS NULL OR site_id = @site)
                 GROUP BY business_date
              ) x
             WHERE BusinessDate > current_date - @days
             ORDER BY BusinessDate DESC
            """,
            // Head office sits at a head-office site, which holds no cash --
            // filtering on it showed them nothing, always. They see the whole
            // company; a station sees itself.
            new { site = wide ? (Guid?)null : _user.SiteId, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    // === SHORTAGE RECOVERY ===================================================


    /// <summary>
    /// Recover a shortage, or write it off.
    ///
    /// The schema will refuse a salary deduction without a signed
    /// acknowledgement attached. That is an exposure for the dealer as much as
    /// a protection for the attendant — an undocumented wage deduction is the
    /// kind of thing that ends up in front of a labour officer.
    /// </summary>
    public async Task<Guid> RecoverShortageAsync(RecoverShortage req, CancellationToken ct)
    {
        Require(req.Method == "WRITE_OFF" ? "shortage.write_off" : "shortage.approve");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO shortage_recovery
                  (tenant_id, staff_id, shortage_id, amount, method, acknowledged,
                   evidence_url, approved_by)
                VALUES (@tenant, @staff, @shortage, @amount, @method, @ack, @url, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, staff = req.StaffId, shortage = req.ShortageId,
                    amount = req.Amount, method = req.Method.ToUpperInvariant(),
                    ack = req.Acknowledged, url = req.EvidenceUrl, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === CALIBRATION =========================================================

    /// <summary>
    /// Import a tank's calibration chart.
    ///
    /// The seed ships linear placeholders with a warning to replace them. Until
    /// now there was no way to. A real chart is not a straight line — the ends
    /// of a cylindrical tank are curved, so litres per millimetre changes with
    /// depth — and a linear approximation is wrong in a way that looks entirely
    /// plausible on every dip.
    /// </summary>
    public async Task<int> ImportCalibrationAsync(Guid tankId, List<CalibrationPoint> points,
                                                   CancellationToken ct)
    {
        Require("equipment.manage");
        if (points.Count < 2)
            throw new DomainException("CHART_TOO_SHORT",
                "A calibration chart needs at least two points.");

        var sorted = points.OrderBy(p => p.DipMm).ToList();
        for (var i = 1; i < sorted.Count; i++)
            if (sorted[i].Litres < sorted[i - 1].Litres)
                throw new DomainException("CHART_NOT_MONOTONIC",
                    $"Volume falls between {sorted[i - 1].DipMm}mm and {sorted[i].DipMm}mm. "
                    + "A deeper dip cannot hold less fuel — check the certificate.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                "DELETE FROM tank_calibration WHERE tank_id = @tank",
                new { tank = tankId },
                transaction: _uow.Transaction, cancellationToken: ct));

            // ONE statement for the whole chart. This inserted a row per round
            // trip -- a certificate read every millimetre on a 3 m tank is
            // 3,000 of them for one upload. Dapper passes C# arrays to Npgsql
            // as native PostgreSQL arrays, which unnest turns back into rows.
            return await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO tank_calibration (tenant_id, tank_id, dip_mm, litres)
                SELECT @tenant, @tank, u.dip, u.litres
                  FROM unnest(@dips::numeric[], @litres::numeric[]) AS u(dip, litres)
                """,
                new
                {
                    tenant = _user.TenantId, tank = tankId,
                    dips = sorted.Select(p => p.DipMm).ToArray(),
                    litres = sorted.Select(p => p.Litres).ToArray(),
                },
                transaction: _uow.Transaction, cancellationToken: ct));
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

public static class OperationsEndpoints
{
    public static void MapOperations(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/ops").RequireAuthorization();

        g.MapGet("/prices/pending", async (OperationsService s, CancellationToken ct) =>
            Results.Ok(await s.PendingPricesAsync(ct)));

        g.MapPost("/prices", async (SchedulePriceChange req, OperationsService s,
                                    CancellationToken ct) =>
            Results.Ok(new { priceChangeId = await s.SchedulePriceAsync(req, ct) }));

        g.MapPost("/prices/{id:guid}/execute",
            async (Guid id, ExecutePriceBreak req, OperationsService s, CancellationToken ct) =>
                Results.Ok(await s.ExecutePriceBreakAsync(id, req, ct)));

        g.MapPost("/shifts/{shiftId:guid}/discounts",
            async (Guid shiftId, RecordDiscount req, OperationsService s, CancellationToken ct) =>
                Results.Ok(new { discountId = await s.RecordDiscountAsync(shiftId, req, ct) }));

        g.MapPost("/stock-counts", async (BeginStockCount req, OperationsService s,
                                          CancellationToken ct) =>
            Results.Ok(new { countId = await s.BeginStockCountAsync(req, ct) }));

        g.MapGet("/stock-counts/{id:guid}/lines",
            async (Guid id, OperationsService s, CancellationToken ct) =>
                Results.Ok(await s.StockCountLinesAsync(id, ct)));

        g.MapPost("/stock-counts/{id:guid}/tanks",
            async (Guid id, CountTank req, OperationsService s, CancellationToken ct) =>
            {
                await s.CountTankAsync(id, req, ct);
                return Results.Ok(new { counted = true });
            });

        g.MapPost("/stock-counts/{id:guid}/post",
            async (Guid id, OperationsService s, CancellationToken ct) =>
                Results.Ok(await s.PostStockCountAsync(id, ct)));

        g.MapPost("/banking", async (RecordBanking req, OperationsService s, CancellationToken ct) =>
            Results.Ok(new { bankingId = await s.RecordBankingAsync(req, ct) }));

        g.MapGet("/cash-position", async (int? days, OperationsService s, CancellationToken ct) =>
            Results.Ok(await s.CashPositionAsync(days ?? 30, ct)));


        g.MapPost("/shortages/recover", async (RecoverShortage req, OperationsService s,
                                               CancellationToken ct) =>
            Results.Ok(new { recoveryId = await s.RecoverShortageAsync(req, ct) }));

        g.MapPost("/tanks/{id:guid}/calibration",
            async (Guid id, List<CalibrationPoint> points, OperationsService s,
                   CancellationToken ct) =>
                Results.Ok(new { points = await s.ImportCalibrationAsync(id, points, ct) }));
    }
}
