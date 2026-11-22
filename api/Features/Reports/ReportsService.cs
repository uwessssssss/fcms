using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Reports;

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class StockCardRow
{
    public long MovementId { get; set; }
    public DateTime OccurredAt { get; set; }
    public string Kind { get; set; } = "";
    public decimal SignedLitres { get; set; }
    public decimal RunningLitres { get; set; }
    public string TankCode { get; set; } = "";
    public string ProductCode { get; set; } = "";
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class DutyPeriodRow
{
    public DateOnly BusinessDate { get; set; }
    public string Label { get; set; } = "";
    public int Segments { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public string[]? CutReasons { get; set; }
    public bool FullySignedOff { get; set; }
    public Guid? FirstShiftId { get; set; }
    public Guid[] ShiftIds { get; set; } = [];
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class AttendantScoreRow
{
    public Guid StaffId { get; set; }
    public string FullName { get; set; } = "";
    public int Shifts { get; set; }
    public decimal LitresSold { get; set; }
    public decimal SalesValue { get; set; }
    public decimal ShortagesRaised { get; set; }
    public decimal ShortageRate { get; set; }
    public int ExceptionsAgainst { get; set; }
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
internal sealed class TemplateHeader
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string? Label { get; set; }
}

public record RosterTemplateView(Guid Id, string Name, string? Label,
    List<RosterTemplateLine> Lines);
/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class RosterTemplateLine
{
    public Guid NozzleId { get; set; }
    public string NozzleCode { get; set; } = "";
    public string PumpCode { get; set; } = "";
    public Guid AttendantId { get; set; }
    public string AttendantName { get; set; } = "";
}
public record SaveRosterTemplate(string Name, string? Label,
    List<RosterTemplateLineInput> Lines);
public record RosterTemplateLineInput(Guid NozzleId, Guid AttendantId);

public record BeginDryCount(string Scope, string? Category);
public record CountDryItem(Guid ItemId, decimal CountedQty, string? VarianceReason);
/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class DryCountLineView
{
    public Guid ItemId { get; set; }
    public string Sku { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal BookQty { get; set; }
    public decimal CountedQty { get; set; }
    public decimal VarianceQty { get; set; }
    public string? VarianceReason { get; set; }
}

public sealed class ReportsService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public ReportsService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    /// <summary>
    /// The tank stock card.
    ///
    /// This is the document an auditor actually asks for, and the reason the
    /// ledger design earns its keep: a running position after every single
    /// movement. When the books and the dipstick disagree, this shows WHERE they
    /// parted company, not merely that they did. In v1 there was no equivalent —
    /// book stock was a stored column, so the only answer to "when did we lose
    /// it" was "sometime this month".
    /// </summary>
    public async Task<IReadOnlyList<StockCardRow>> StockCardAsync(Guid tankId,
        DateOnly from, DateOnly to, CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<StockCardRow>(new CommandDefinition(
            """
            SELECT movement_id AS MovementId, occurred_at AS OccurredAt,
                   kind::text AS Kind, signed_litres AS SignedLitres,
                   running_litres AS RunningLitres, tank_code AS TankCode,
                   product_code AS ProductCode
              FROM v_tank_stock_card
             WHERE tank_id = @tank
               AND occurred_at >= @from::date
               AND occurred_at < (@to::date + 1)
             ORDER BY occurred_at, movement_id
            """,
            new { tank = tankId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Shifts as a human recognises them — segments folded back into one line
    /// per duty period, with the reasons any cuts happened.
    /// </summary>
    public async Task<IReadOnlyList<DutyPeriodRow>> DutyPeriodsAsync(int days,
                                                                     CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DutyPeriodRow>(new CommandDefinition(
            """
            SELECT business_date AS BusinessDate, label, segments,
                   started_at AS StartedAt, ended_at AS EndedAt,
                   -- cut_reasons is close_reason[], an ENUM array. Npgsql hands
                   -- back CloseReasonEnum[] and Dapper cannot cast that to
                   -- string[]. The screen renders text, so ask for text.
                   cut_reasons::text[] AS CutReasons,
                   fully_signed_off AS FullySignedOff,
                   first_shift_id AS FirstShiftId,
                   shift_ids AS ShiftIds
              FROM v_duty_period
             WHERE site_id = @site AND business_date > current_date - @days
             ORDER BY business_date DESC, label
            """,
            new { site = _user.SiteId, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Attendant scorecard.
    ///
    /// Deliberately reports a RATE, not a total. An attendant on the busy island
    /// will always have the largest absolute shortage simply because they handle
    /// the most money, and ranking on that punishes them for working hard. The
    /// shortage rate — shillings short per shilling sold — is the number that
    /// actually distinguishes carelessness from volume.
    ///
    /// It is still only a prompt for a conversation. Somebody being consistently
    /// short is worth asking about; it is not proof of anything.
    /// </summary>
    public async Task<IReadOnlyList<AttendantScoreRow>> ScorecardAsync(int days,
                                                                       CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<AttendantScoreRow>(new CommandDefinition(
            """
            WITH sold AS (
              SELECT na.attendant_id,
                     count(DISTINCT me.shift_id)          AS shifts,
                     SUM(md.litres)                       AS litres,
                     SUM(round(md.litres * md.unit_price, 2))       AS value
                FROM meter_event me
                JOIN nozzle_assignment na ON na.id = me.assignment_id
                JOIN metered_disposition md
                  ON md.meter_event_id = me.id AND md.kind = 'SALE'
                JOIN shift s ON s.id = me.shift_id
               WHERE s.site_id = @site AND s.business_date > current_date - @days
               GROUP BY na.attendant_id
            ), shorts AS (
              SELECT ss.staff_id, SUM(ss.amount) AS raised
                FROM staff_shortage ss
                JOIN shift s ON s.id = ss.shift_id
               WHERE s.site_id = @site AND s.business_date > current_date - @days
               GROUP BY ss.staff_id
            )
            SELECT st.id AS StaffId, st.full_name AS FullName,
                   COALESCE(sold.shifts, 0)  AS Shifts,
                   COALESCE(sold.litres, 0)  AS LitresSold,
                   COALESCE(sold.value, 0)   AS SalesValue,
                   COALESCE(shorts.raised, 0) AS ShortagesRaised,
                   CASE WHEN COALESCE(sold.value, 0) > 0
                        THEN round(COALESCE(shorts.raised,0) / sold.value * 100, 4)
                        ELSE 0 END AS ShortageRate,
                   0 AS ExceptionsAgainst
              FROM staff st
              LEFT JOIN sold   ON sold.attendant_id = st.id
              LEFT JOIN shorts ON shorts.staff_id  = st.id
             WHERE st.site_id = @site AND st.role = 'ATTENDANT' AND st.is_active
             ORDER BY ShortageRate DESC, FullName
            """,
            new { site = _user.SiteId, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    // === ROSTER TEMPLATES ====================================================

    /// <summary>
    /// Saved rosters. Assigning eight nozzles at six in the morning, one at a
    /// time, on a tablet, is where a shift open goes wrong — and a rushed
    /// assignment is an attendant settling for someone else's fuel.
    /// </summary>
    public async Task<IReadOnlyList<RosterTemplateView>> TemplatesAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        var templates = (await conn.QueryAsync<TemplateHeader>(
            new CommandDefinition(
                """
                SELECT id AS Id, name AS Name, label AS Label FROM roster_template
                 WHERE site_id = @site AND is_active ORDER BY name
                """,
                new { site = _user.SiteId },
                transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        // ALL lines in one query, grouped here. This ran one query per saved
        // roster -- the list grew a round trip with every template anyone saved.
        var lines = (await conn.QueryAsync<TemplateLineRow>(new CommandDefinition(
            """
            SELECT rtl.template_id AS TemplateId,
                   rtl.nozzle_id AS NozzleId, n.code AS NozzleCode,
                   p.code AS PumpCode, rtl.attendant_id AS AttendantId,
                   s.full_name AS AttendantName
              FROM roster_template_line rtl
              JOIN roster_template t ON t.id = rtl.template_id
              JOIN nozzle n ON n.id = rtl.nozzle_id
              JOIN pump p   ON p.id = n.pump_id
              JOIN staff s  ON s.id = rtl.attendant_id
             WHERE t.site_id = @site AND t.is_active
             ORDER BY p.code, n.code
            """,
            new { site = _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var byTemplate = lines.ToLookup(l => l.TemplateId);
        return templates
            .Select(t => new RosterTemplateView(t.Id, t.Name, t.Label, byTemplate[t.Id]
                .Select(l => new RosterTemplateLine
                {
                    NozzleId = l.NozzleId, NozzleCode = l.NozzleCode, PumpCode = l.PumpCode,
                    AttendantId = l.AttendantId, AttendantName = l.AttendantName,
                })
                .ToList()))
            .ToList();
    }

    /// <summary>A roster line with the template it belongs to, for grouping.</summary>
    private sealed class TemplateLineRow
    {
        public Guid TemplateId { get; set; }
        public Guid NozzleId { get; set; }
        public string NozzleCode { get; set; } = "";
        public string PumpCode { get; set; } = "";
        public Guid AttendantId { get; set; }
        public string AttendantName { get; set; } = "";
    }

    public async Task<Guid> SaveTemplateAsync(SaveRosterTemplate req, CancellationToken ct)
    {
        Require("assignment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO roster_template (tenant_id, site_id, name, label)
                VALUES (@tenant, @site, @name, @label)
                ON CONFLICT (site_id, name) DO UPDATE SET label = EXCLUDED.label
                RETURNING id
                """,
                new { tenant = _user.TenantId, site = _user.SiteId, req.Name, req.Label },
                transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                "DELETE FROM roster_template_line WHERE template_id = @id",
                new { id }, transaction: _uow.Transaction, cancellationToken: ct));

            foreach (var line in req.Lines)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    INSERT INTO roster_template_line (template_id, nozzle_id, attendant_id)
                    VALUES (@id, @nozzle, @attendant)
                    """,
                    new { id, nozzle = line.NozzleId, attendant = line.AttendantId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === DRY STOCK COUNT =====================================================

    /// <summary>
    /// Counting the shop.
    ///
    /// The fuel stock take was built and this was not, which left dry stock with
    /// a ledger nobody ever reconciled against a shelf. Units are exact — there
    /// is no calibration chart and no measurement error — so any difference is
    /// theft, breakage or a miskey, and the schema refuses to post one without a
    /// reason.
    /// </summary>
    public async Task<Guid> BeginDryCountAsync(BeginDryCount req, CancellationToken ct)
    {
        Require("stock_count.conduct");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO dry_count
                  (tenant_id, site_id, shift_id, counted_on, scope, category, counted_by)
                SELECT @tenant, @site,
                       (SELECT id FROM shift WHERE site_id = @site
                         AND state IN ('OPEN','COUNTING') LIMIT 1),
                       current_date, @scope, @category, @actor
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = _user.SiteId, req.Scope,
                    req.Category, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            // Book quantity is snapshotted now. Reading it again at approval
            // would compare the count to a shelf that has moved since, and every
            // bottle sold during the count would look like a loss.
            await conn.ExecuteAsync(new CommandDefinition(
                """
                INSERT INTO dry_count_line (tenant_id, count_id, item_id, book_qty, counted_qty)
                SELECT @tenant, @count, i.id,
                       COALESCE(fn_dry_on_hand(i.id, @site), 0), 0
                  FROM dry_item i
                 WHERE i.tenant_id = @tenant AND i.is_active
                   AND (@category::text IS NULL OR i.category = @category)
                """,
                new
                {
                    tenant = _user.TenantId, count = id, site = _user.SiteId,
                    req.Category
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<DryCountLineView>> DryCountLinesAsync(Guid countId,
                                                                          CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<DryCountLineView>(new CommandDefinition(
            """
            SELECT dcl.item_id AS ItemId, i.sku, i.name,
                   dcl.book_qty AS BookQty, dcl.counted_qty AS CountedQty,
                   dcl.variance_qty AS VarianceQty, dcl.variance_reason AS VarianceReason
              FROM dry_count_line dcl JOIN dry_item i ON i.id = dcl.item_id
             WHERE dcl.count_id = @id ORDER BY i.category, i.name
            """,
            new { id = countId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task CountDryItemAsync(Guid countId, CountDryItem req, CancellationToken ct)
    {
        Require("stock_count.conduct");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE dry_count_line
                   SET counted_qty = @qty, variance_reason = @reason
                 WHERE count_id = @count AND item_id = @item
                """,
                new { qty = req.CountedQty, reason = req.VarianceReason,
                      count = countId, item = req.ItemId },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<object> PostDryCountAsync(Guid countId, CancellationToken ct)
    {
        Require("stock_count.post");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE dry_count SET status='APPROVED', approved_by=@actor, approved_at=now()
                 WHERE id = @id AND status IN ('COUNTING','COUNTED')
                """,
                new { id = countId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            var raw = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT fn_post_dry_count(@id, @actor)::text",
                new { id = countId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            return System.Text.Json.JsonDocument.Parse(raw ?? "{}").RootElement.Clone();
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

public static class ReportsEndpoints
{
    public static void MapReports(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/reports").RequireAuthorization();

        g.MapGet("/stock-card", async (Guid tankId, DateOnly from, DateOnly to,
                                       ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.StockCardAsync(tankId, from, to, ct)));

        g.MapGet("/duty-periods", async (int? days, ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.DutyPeriodsAsync(days ?? 30, ct)));

        g.MapGet("/scorecard", async (int? days, ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.ScorecardAsync(days ?? 30, ct)));

        var r = app.MapGroup("/api/rosters").RequireAuthorization();

        r.MapGet("/", async (ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.TemplatesAsync(ct)));

        r.MapPost("/", async (SaveRosterTemplate req, ReportsService s, CancellationToken ct) =>
            Results.Ok(new { templateId = await s.SaveTemplateAsync(req, ct) }));

        var d = app.MapGroup("/api/dry-counts").RequireAuthorization();

        d.MapPost("/", async (BeginDryCount req, ReportsService s, CancellationToken ct) =>
            Results.Ok(new { countId = await s.BeginDryCountAsync(req, ct) }));

        d.MapGet("/{id:guid}/lines", async (Guid id, ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.DryCountLinesAsync(id, ct)));

        d.MapPost("/{id:guid}/items", async (Guid id, CountDryItem req, ReportsService s,
                                             CancellationToken ct) =>
        {
            await s.CountDryItemAsync(id, req, ct);
            return Results.Ok(new { counted = true });
        });

        d.MapPost("/{id:guid}/post", async (Guid id, ReportsService s, CancellationToken ct) =>
            Results.Ok(await s.PostDryCountAsync(id, ct)));
    }
}
