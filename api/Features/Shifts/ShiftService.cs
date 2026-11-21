using System.Text.Json;
using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Shifts;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
/// <summary>
/// An opening dip, in LITRES.
///
/// The same shape as ClosingDip and for the same reason: the operator reads
/// the stick, looks the volume up on the chart taped to the office wall, and
/// the figure they carry to the office IS the litres. Asking for millimetres
/// so the server can redo that lookup adds a step and makes every number
/// depend on a calibration chart that shipped as a straight line -- and a real
/// tank is a cylinder, so a straight line is wrong at both ends.
///
/// DipMm stays, optional, for a station that records the stick reading too.
/// fn_dip_litres accepts either and prefers litres.
///
/// This record was missed when ClosingDip was converted. The serialisation
/// below was updated and the record was not, which is a compile error -- and
/// there is no C# compiler in the environment this was written in, so it
/// reached the user's build instead.
/// </summary>
public record OpeningDip(Guid TankId, decimal ProductLitres, decimal? WaterLitres,
    decimal? DipMm, decimal? WaterDipMm,
    decimal? TemperatureC, string? PhotoUrl, DateTime? CapturedAt);

public record RosterLine(Guid NozzleId, Guid AttendantId,
    decimal? VolumeTotalizer, decimal? ElectronicTotalizer, string? PhotoUrl);

public record OpenShiftRequest(string Label, List<OpeningDip> OpeningDips,
    List<RosterLine> Roster, DateOnly? BusinessDate);

public record ClosingReading(Guid AssignmentId, decimal VolumeTotalizer,
    decimal? ElectronicTotalizer, decimal? AmountTotalizer, bool IsRollover,
    string? PhotoUrl, string? EvidenceReason, DateTime? CapturedAt);

/// <summary>
/// A dip, in LITRES.
///
/// The operator already has this figure -- they read the stick and look it up
/// on the chart taped to the office wall. Asking for millimetres so the server
/// could redo that lookup added a step, added a place to mistype, and made
/// every number depend on a calibration chart that shipped as a straight line.
/// A real tank is a cylinder, so a straight line is wrong at both ends, which
/// is exactly where a tank sits after a delivery or before one.
///
/// DipMm is kept and optional, for a station that records the stick reading
/// too. The database accepts either and prefers litres.
/// </summary>
public record ClosingDip(Guid TankId, decimal ProductLitres, decimal? WaterLitres,
    decimal? DipMm, decimal? WaterDipMm,
    decimal? TemperatureC, string? PhotoUrl, DateTime? CapturedAt);

public record TenderLine(string ChannelCode, decimal Amount, string? Reference,
    string? EvidenceUrl);

public record CashUpDeclaration(Guid AttendantId, decimal Cash,
    List<TenderLine>? Tenders, string? ShortageReason, string? Notes);

/// <summary>
/// CloseReason is not cosmetic. A two-hour segment closed for PRICE_CHANGE is
/// normal; the same segment recorded as SCHEDULED looks like a missed handover
/// on every report that follows it.
/// </summary>
public record CloseShiftRequest(string Reason, List<ClosingReading> Readings,
    List<ClosingDip> Dips, List<CashUpDeclaration> CashUps);

public record CloseResult(Guid ShiftId, int MeterEvents, int TanksReconciled,
    int CashUps, int Exceptions);

/// <summary>
/// What the close WOULD do, per attendant and per tank.
///
/// The preview runs the real fn_close_shift inside a savepoint, so while it is
/// running the cash-up rows genuinely exist and can be read. Capturing them
/// before the rollback is what lets a supervisor see each person's position
/// rather than a count of how many were processed.
///
/// It has to be read INSIDE the savepoint. After the rollback these rows are
/// gone, which is the point.
/// </summary>
public record PreviewResult(Guid ShiftId, int MeterEvents, int TanksReconciled,
    int Exceptions,
    List<CashUpView> CashUps,
    List<TankView> Tanks);

/// <summary>A closed shift with its money and tank variance, for the shift report.</summary>
public sealed class ShiftReportRow
{
    public Guid Id { get; set; }
    public DateOnly BusinessDate { get; set; }
    public string Label { get; set; } = "";
    public string State { get; set; } = "";
    public string OpenedByName { get; set; } = "";
    public decimal SalesValue { get; set; }
    public decimal SalesLitres { get; set; }
    public int OpenExceptions { get; set; }
    public decimal CashDeclared { get; set; }
    public decimal ElectronicDeclared { get; set; }
    public decimal CreditTotal { get; set; }
    public decimal DiscountTotal { get; set; }
    public decimal ShortageRaised { get; set; }
    /// <summary>Closing dip minus book as at the close. Negative is fuel missing.</summary>
    public decimal VarianceLitres { get; set; }
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class ShiftSummary
{
    public Guid Id { get; set; }
    public DateOnly BusinessDate { get; set; }
    public string Label { get; set; } = "";
    public int Segment { get; set; }
    public string State { get; set; } = "";
    public string? ClosedReason { get; set; }
    public DateTime OpenedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public string OpenedByName { get; set; } = "";
    public decimal SalesValue { get; set; }
    public decimal SalesLitres { get; set; }
    public int OpenExceptions { get; set; }
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class AssignmentView
{
    public Guid Id { get; set; }
    public Guid NozzleId { get; set; }
    public string NozzleCode { get; set; } = "";
    public string PumpCode { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public Guid AttendantId { get; set; }
    public string AttendantName { get; set; } = "";
    public string EmployeeNo { get; set; } = "";
    public string State { get; set; } = "";
    public decimal? OpeningTotalizer { get; set; }
    public decimal? ClosingTotalizer { get; set; }
    public decimal? GrossLitres { get; set; }
    public decimal? DivergenceLitres { get; set; }
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class TankView
{
    public Guid TankId { get; set; }
    public string Code { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public decimal BookLitres { get; set; }
    public decimal? ActualLitres { get; set; }
    public decimal? VarianceLitres { get; set; }
    public decimal? VariancePct { get; set; }
    public bool? WithinTolerance { get; set; }
    public decimal NominalLitres { get; set; }
    public decimal SafeFill { get; set; }
    public decimal DeadStock { get; set; }
}

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class CashUpView
{
    public Guid CashUpId { get; set; }
    public Guid StaffId { get; set; }
    public string FullName { get; set; } = "";
    public string Status { get; set; } = "";
    public decimal SalesValue { get; set; }
    public decimal CashDeclared { get; set; }
    public decimal ElectronicDeclared { get; set; }
    public decimal CreditTotal { get; set; }
    public decimal DiscountTotal { get; set; }
    public decimal ShortageRaised { get; set; }
    public decimal OverageRaised { get; set; }
    public decimal Unallocated { get; set; }
    public bool IsBalanced { get; set; }
}

public record ShiftDetail(ShiftSummary Shift, List<AssignmentView> Assignments,
    List<TankView> Tanks, List<CashUpView> CashUps);

// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class AttendantTenderRow
{
    public Guid CashUpId { get; set; }
    public string AttendantName { get; set; } = "";
    public string EmployeeNo { get; set; } = "";
    public string Settlement { get; set; } = "";
    public string? ChannelCode { get; set; }
    public string? ChannelName { get; set; }
    public string? TillNumber { get; set; }
    public decimal Amount { get; set; }
    public string? Reference { get; set; }
}

public sealed class ShiftService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public ShiftService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    /// <summary>
    /// Open a shift.
    ///
    /// Everything happens inside fn_open_shift: the shift row, the captured
    /// prices, the opening dips and the roster with each nozzle's carried-forward
    /// opening reading. Splitting that across API calls is how v1 ended up with
    /// shifts that had a roster and no prices.
    /// </summary>
    public async Task<Guid> OpenAsync(OpenShiftRequest req, Guid? predecessorId,
                                      CancellationToken ct)
    {
        Require("shift.open");

        if (req.OpeningDips.Count == 0)
            throw new DomainException("NO_OPENING_DIPS",
                "A shift cannot open without dipping every tank. Without an opening "
                + "position, the closing variance means nothing.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                SELECT fn_open_shift(@site, @label, @actor,
                                     @dips::jsonb, @roster::jsonb,
                                     @predecessor, @businessDate)
                """,
                new
                {
                    site = _user.SiteId,
                    label = req.Label,
                    actor = _user.StaffId,
                    dips = JsonSerializer.Serialize(req.OpeningDips.Select(d => new
                    {
                        tank_id = d.TankId,
                        product_litres = d.ProductLitres,
                        water_litres = d.WaterLitres,
                        dip_mm = d.DipMm,
                        water_dip_mm = d.WaterDipMm,
                        temperature_c = d.TemperatureC,
                        photo_url = d.PhotoUrl,
                        captured_at = d.CapturedAt
                    }), Json),
                    roster = JsonSerializer.Serialize(req.Roster.Select(r => new
                    {
                        nozzle_id = r.NozzleId,
                        attendant_id = r.AttendantId,
                        volume_totalizer = r.VolumeTotalizer,
                        electronic_totalizer = r.ElectronicTotalizer,
                        photo_url = r.PhotoUrl
                    }), Json),
                    predecessor = predecessorId,
                    businessDate = req.BusinessDate
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Close a shift.
    ///
    /// One call, one transaction, both ledgers. The deferred constraint triggers
    /// fire at COMMIT — so this can appear to succeed all the way through and
    /// still be refused if the litres or the shillings do not add up. That is
    /// the intended behaviour, and it is why the whole close is a single
    /// database function rather than an orchestration in C#.
    /// </summary>
    public async Task<CloseResult> CloseAsync(Guid shiftId, CloseShiftRequest req,
                                              CancellationToken ct)
    {
        Require("shift.close");

        if (!AllowedReasons.Contains(req.Reason))
            throw new DomainException("BAD_CLOSE_REASON",
                $"'{req.Reason}' is not a close reason. Use one of: "
                + string.Join(", ", AllowedReasons));

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var raw = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                """
                SELECT fn_close_shift(@shift, @actor, @reason::close_reason,
                                      @readings::jsonb, @dips::jsonb, @cashups::jsonb)::text
                """,
                new
                {
                    shift = shiftId,
                    actor = _user.StaffId,
                    reason = req.Reason,
                    readings = JsonSerializer.Serialize(req.Readings.Select(r => new
                    {
                        assignment_id = r.AssignmentId,
                        volume_totalizer = r.VolumeTotalizer,
                        electronic_totalizer = r.ElectronicTotalizer,
                        amount_totalizer = r.AmountTotalizer,
                        is_rollover = r.IsRollover,
                        photo_url = r.PhotoUrl,
                        evidence_reason = r.EvidenceReason,
                        captured_at = r.CapturedAt
                    }), Json),
                    dips = JsonSerializer.Serialize(req.Dips.Select(d => new
                    {
                        tank_id = d.TankId,
                        product_litres = d.ProductLitres,
                        water_litres = d.WaterLitres,
                        dip_mm = d.DipMm,
                        water_dip_mm = d.WaterDipMm,
                        temperature_c = d.TemperatureC,
                        photo_url = d.PhotoUrl,
                        captured_at = d.CapturedAt
                    }), Json),
                    cashups = JsonSerializer.Serialize(req.CashUps.Select(c => new
                    {
                        attendant_id = c.AttendantId,
                        cash = c.Cash,
                        tenders = (c.Tenders ?? new()).Select(t => new
                        {
                            channel_code = t.ChannelCode,
                            amount = t.Amount,
                            reference = t.Reference,
                            evidence_url = t.EvidenceUrl
                        }),
                        shortage_reason = c.ShortageReason,
                        notes = c.Notes
                    }), Json)
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            using var doc = JsonDocument.Parse(raw ?? "{}");
            var r = doc.RootElement;
            return new CloseResult(shiftId,
                r.GetProperty("meter_events").GetInt32(),
                r.GetProperty("tanks_reconciled").GetInt32(),
                r.GetProperty("cash_ups").GetInt32(),
                r.GetProperty("exceptions").GetInt32());
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// A dry run of the close.
    ///
    /// It executes the real thing inside a SAVEPOINT and rolls back, so the
    /// numbers a supervisor sees on the review screen are produced by exactly
    /// the code that will produce the committed ones. v1 recalculated the
    /// preview in TypeScript, which disagreed with the database by a few litres
    /// on every close — and a manager shown one number and printed another
    /// stops trusting both.
    /// </summary>
    public async Task<PreviewResult> PreviewAsync(Guid shiftId, CloseShiftRequest req,
                                                CancellationToken ct)
    {
        Require("shift.close");
        var conn = await _uow.ConnectionAsync(ct);

        await conn.ExecuteAsync(new CommandDefinition("SAVEPOINT close_preview",
            transaction: _uow.Transaction, cancellationToken: ct));
        try
        {
            var result = await CloseAsync(shiftId, req, ct);

            // Force the deferred triggers to run now. Without this, an
            // unbalanced cash-up would pass the preview and fail the real
            // close — the preview would be a lie in exactly the case where a
            // supervisor most needs the truth.
            await conn.ExecuteAsync(new CommandDefinition("SET CONSTRAINTS ALL IMMEDIATE",
                transaction: _uow.Transaction, cancellationToken: ct));

            // Read the positions while they still exist. After the rollback in
            // the finally below they are gone, so this is the only moment a
            // per-attendant figure can be taken -- and it is the real one,
            // computed by the same function that will run for the commit.
            var detail = await GetAsync(shiftId, ct);

            return new PreviewResult(
                result.ShiftId, result.MeterEvents, result.TanksReconciled,
                result.Exceptions,
                detail?.CashUps.ToList() ?? [],
                detail?.Tanks.ToList() ?? []);
        }
        finally
        {
            await conn.ExecuteAsync(new CommandDefinition(
                "ROLLBACK TO SAVEPOINT close_preview; SET CONSTRAINTS ALL DEFERRED",
                transaction: _uow.Transaction, cancellationToken: ct));
        }
    }

    public async Task ApproveAsync(Guid shiftId, CancellationToken ct)
    {
        Require("shift.approve");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var n = await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE shift SET state = 'APPROVED', approved_by = @actor, approved_at = now()
                 WHERE id = @id AND state = 'DECLARED'
                """,
                new { id = shiftId, actor = _user.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (n == 0)
                throw new DomainException("SHIFT_NOT_DECLARED",
                    "Only a declared shift can be approved. Check whether it has been "
                    + "closed, or already signed off.", 409);
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// The full picture of one shift. Every number here is DERIVED — book stock
    /// from fn_book_stock, the cash position from v_cash_up_position. There is
    /// no stored total to have gone stale since the close.
    /// </summary>
    public async Task<ShiftDetail?> GetAsync(Guid shiftId, CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);

        var shift = await conn.QuerySingleOrDefaultAsync<ShiftSummary>(new CommandDefinition(
            """
            SELECT s.id, s.business_date AS BusinessDate, s.label, s.segment,
                   s.state::text AS State, s.closed_reason::text AS ClosedReason,
                   s.opened_at AS OpenedAt, s.closed_at AS ClosedAt,
                   op.full_name AS OpenedByName,
                   COALESCE(sales.value, 0)  AS SalesValue,
                   COALESCE(sales.litres, 0) AS SalesLitres,
                   COALESCE(ex.n, 0)         AS OpenExceptions
              FROM shift s
              JOIN staff op ON op.id = s.opened_by
              LEFT JOIN (
                SELECT me.shift_id,
                       SUM(md.litres * md.unit_price) AS value,
                       SUM(md.litres)                 AS litres
                  FROM meter_event me
                  JOIN metered_disposition md
                    ON md.meter_event_id = me.id AND md.kind = 'SALE'
                 GROUP BY me.shift_id) sales ON sales.shift_id = s.id
              LEFT JOIN (
                SELECT shift_id, count(*) AS n FROM exception_flag
                 WHERE resolved_at IS NULL GROUP BY shift_id) ex ON ex.shift_id = s.id
             WHERE s.id = @id
            """,
            new { id = shiftId }, transaction: _uow.Transaction, cancellationToken: ct));

        if (shift is null) return null;

        var assignments = (await conn.QueryAsync<AssignmentView>(new CommandDefinition(
            """
            SELECT na.id, na.nozzle_id AS NozzleId, n.code AS NozzleCode,
                   p.code AS PumpCode, pr.code AS ProductCode,
                   na.attendant_id AS AttendantId, st.full_name AS AttendantName,
                   st.employee_no AS EmployeeNo,
                   na.state AS State,
                   mo.volume_totalizer AS OpeningTotalizer,
                   mc.volume_totalizer AS ClosingTotalizer,
                   me.gross_litres     AS GrossLitres,
                   me.divergence_litres AS DivergenceLitres
              FROM nozzle_assignment na
              JOIN nozzle n  ON n.id = na.nozzle_id
              JOIN pump p    ON p.id = n.pump_id
              JOIN tank t    ON t.id = n.tank_id
              JOIN product pr ON pr.id = t.product_id
              JOIN staff st  ON st.id = na.attendant_id
              LEFT JOIN meter_reading mo ON mo.assignment_id = na.id AND mo.is_opening
              LEFT JOIN meter_reading mc ON mc.assignment_id = na.id AND NOT mc.is_opening
              LEFT JOIN meter_event me   ON me.assignment_id = na.id
             WHERE na.shift_id = @id
             ORDER BY p.code, n.code
            """,
            new { id = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var tanks = (await conn.QueryAsync<TankView>(new CommandDefinition(
            """
            SELECT t.id AS TankId, t.code, pr.code AS ProductCode,
                   -- The book AS AT THIS SHIFT'S CLOSE, not now. The close posts
                   -- the shift's sales and stamps closed_at with the same now()
                   -- in one transaction, so this includes them and excludes
                   -- every later shift. It read fn_book_stock(t.id) -- today's
                   -- book -- so every PAST shift compared its old dip against
                   -- the tank as it stands now: a variance of nothing real.
                   fn_book_stock(t.id, COALESCE(s.closed_at, now())) AS BookLitres,
                   -- Capacity, so the close screen can draw a fill bar. A litre
                   -- figure alone cannot say whether a tank is nearly empty, and
                   -- that is the thing the eye should catch before it reads.
                   t.nominal_litres AS NominalLitres,
                   t.safe_fill      AS SafeFill,
                   t.dead_stock     AS DeadStock,
                   d.product_litres    AS ActualLitres,
                   -- The change since this tank's previous close, not the standing gap (430).
                   fn_close_variance(t.id, d.product_litres, COALESCE(s.closed_at, now()), s.id) AS VarianceLitres,
                   CASE WHEN sold.litres > 0
                        THEN round((fn_close_variance(t.id, d.product_litres, COALESCE(s.closed_at, now()), s.id))
                                   / sold.litres * 100, 4) END AS VariancePct,
                   CASE WHEN d.product_litres IS NULL THEN NULL
                        ELSE abs(fn_close_variance(t.id, d.product_litres, COALESCE(s.closed_at, now()), s.id)) <= pol.shift_variance_litres
                   END AS WithinTolerance
              FROM tank t
              JOIN product pr ON pr.id = t.product_id
              JOIN shift s ON s.id = @id
              JOIN tenant_policy pol ON pol.tenant_id = t.tenant_id
              LEFT JOIN LATERAL (
                SELECT product_litres FROM dip_reading
                 WHERE tank_id = t.id AND shift_id = @id AND context = 'SHIFT_CLOSE'
                 ORDER BY captured_at DESC LIMIT 1) d ON TRUE
              LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(md.litres), 0) AS litres
                  FROM meter_event me
                  JOIN metered_disposition md
                    ON md.meter_event_id = me.id AND md.kind = 'SALE'
                 WHERE me.shift_id = @id AND me.tank_id = t.id) sold ON TRUE
             WHERE t.site_id = s.site_id AND t.is_active
             ORDER BY t.code
            """,
            new { id = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        var cashUps = (await conn.QueryAsync<CashUpView>(new CommandDefinition(
            """
            SELECT cash_up_id AS CashUpId, staff_id AS StaffId, full_name AS FullName,
                   status AS Status, sales_value AS SalesValue,
                   cash_declared AS CashDeclared,
                   electronic_declared AS ElectronicDeclared,
                   credit_total AS CreditTotal, discount_total AS DiscountTotal,
                   shortage_raised AS ShortageRaised, overage_raised AS OverageRaised,
                   unallocated AS Unallocated, is_balanced AS IsBalanced
              FROM v_cash_up_position WHERE shift_id = @id ORDER BY full_name
            """,
            new { id = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();

        return new ShiftDetail(shift, assignments, tanks, cashUps);
    }

    /// <summary>
    /// Shifts by state. The approvals queue is the caller that matters — a
    /// manager needs a list of what is waiting on their signature, and without
    /// one, declared shifts sit unapproved until somebody remembers.
    /// </summary>
    public async Task<IReadOnlyList<ShiftSummary>> ListAsync(string? state, int days,
                                                             CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ShiftSummary>(new CommandDefinition(
            """
            SELECT s.id, s.business_date AS BusinessDate, s.label, s.segment,
                   s.state::text AS State, s.closed_reason::text AS ClosedReason,
                   s.opened_at AS OpenedAt, s.closed_at AS ClosedAt,
                   op.full_name AS OpenedByName,
                   COALESCE(sales.value, 0)  AS SalesValue,
                   COALESCE(sales.litres, 0) AS SalesLitres,
                   COALESCE(ex.n, 0)         AS OpenExceptions
              FROM shift s
              JOIN staff op ON op.id = s.opened_by
              -- LATERAL: totals for THESE shifts only. This grouped every
              -- meter event and every exception in the company's history on
              -- every call, then joined the few rows it needed -- a query that
              -- grew slower every day. Per shift it uses meter_event(shift_id)
              -- and exception_flag(shift_id).
              LEFT JOIN LATERAL (
                SELECT SUM(md.litres * md.unit_price) AS value,
                       SUM(md.litres)                 AS litres
                  FROM meter_event me
                  JOIN metered_disposition md
                    ON md.meter_event_id = me.id AND md.kind = 'SALE'
                 WHERE me.shift_id = s.id) sales ON true
              LEFT JOIN LATERAL (
                SELECT count(*) AS n FROM exception_flag
                 WHERE shift_id = s.id AND resolved_at IS NULL) ex ON true
             WHERE s.site_id = @site
               AND (@state::text IS NULL OR s.state::text = @state)
               AND s.business_date > current_date - @days
             ORDER BY s.business_date DESC, s.label, s.segment
             LIMIT 100
            """,
            new { site = _user.SiteId, state, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Every closed shift in a period with its money and its tanks, in ONE
    /// query. The shift report used to fetch each shift's full detail
    /// separately -- forty requests for a fortnight.
    /// </summary>
    /// <remarks>
    /// Variance is dip minus book AS AT THE CLOSE, the same reading as the
    /// shift detail: the close posts the sales and stamps closed_at with one
    /// now(), so the book then includes this shift and excludes later ones.
    /// </remarks>
    /// <param name="days">How far back.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<IReadOnlyList<ShiftReportRow>> ReportAsync(int days, CancellationToken ct)
    {
        // Money by attendant: whoever closes shifts, or can read reports.
        if (!_user.Can("report.view") && !_user.Can("shift.close"))
            throw new DomainException("FORBIDDEN", "This needs report.view or shift.close.", 403);
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<ShiftReportRow>(new CommandDefinition(
            """
            SELECT s.id AS Id, s.business_date AS BusinessDate, s.label AS Label,
                   s.state::text AS State, op.full_name AS OpenedByName,
                   COALESCE(sales.value, 0)  AS SalesValue,
                   COALESCE(sales.litres, 0) AS SalesLitres,
                   COALESCE(ex.n, 0)         AS OpenExceptions,
                   COALESCE(cu.cash, 0)      AS CashDeclared,
                   COALESCE(cu.elec, 0)      AS ElectronicDeclared,
                   COALESCE(cu.credit, 0)    AS CreditTotal,
                   COALESCE(cu.disc, 0)      AS DiscountTotal,
                   COALESCE(cu.short, 0)     AS ShortageRaised,
                   COALESCE(v.variance, 0)   AS VarianceLitres
              FROM shift s
              JOIN staff op ON op.id = s.opened_by
              -- LATERAL: totals for THESE shifts only. This grouped every
              -- meter event and every exception in the company's history on
              -- every call, then joined the few rows it needed -- a query that
              -- grew slower every day. Per shift it uses meter_event(shift_id)
              -- and exception_flag(shift_id).
              LEFT JOIN LATERAL (
                SELECT SUM(md.litres * md.unit_price) AS value,
                       SUM(md.litres)                 AS litres
                  FROM meter_event me
                  JOIN metered_disposition md
                    ON md.meter_event_id = me.id AND md.kind = 'SALE'
                 WHERE me.shift_id = s.id) sales ON true
              LEFT JOIN LATERAL (
                SELECT count(*) AS n FROM exception_flag
                 WHERE shift_id = s.id AND resolved_at IS NULL) ex ON true
              LEFT JOIN LATERAL (
                SELECT SUM(cash_declared) AS cash, SUM(electronic_declared) AS elec,
                       SUM(credit_total) AS credit, SUM(discount_total) AS disc,
                       SUM(shortage_raised) AS short
                  FROM v_cash_up_position WHERE shift_id = s.id) cu ON true
              LEFT JOIN LATERAL (
                -- What THIS shift lost: the change since the tank's previous close (430).
                SELECT SUM(fn_close_variance(d.tank_id, d.product_litres, s.closed_at, s.id)) AS variance
                  FROM dip_reading d
                 WHERE d.shift_id = s.id AND d.context = 'SHIFT_CLOSE') v ON true
             WHERE s.site_id = @site AND s.state <> 'OPEN'
               AND s.business_date > current_date - @days
             ORDER BY s.business_date DESC, s.opened_at DESC
             LIMIT 200
            """,
            new { site = _user.SiteId, days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<ShiftSummary?> CurrentAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<ShiftSummary>(new CommandDefinition(
            """
            SELECT s.id, s.business_date AS BusinessDate, s.label, s.segment,
                   s.state::text AS State, s.closed_reason::text AS ClosedReason,
                   s.opened_at AS OpenedAt, s.closed_at AS ClosedAt,
                   op.full_name AS OpenedByName, 0 AS SalesValue, 0 AS SalesLitres,
                   0 AS OpenExceptions
              FROM shift s JOIN staff op ON op.id = s.opened_by
             WHERE s.site_id = @site AND s.state IN ('OPEN','COUNTING')
            """,
            new { site = _user.SiteId }, transaction: _uow.Transaction, cancellationToken: ct));
    }

    private static readonly HashSet<string> AllowedReasons = new(StringComparer.OrdinalIgnoreCase)
        { "SCHEDULED", "PRICE_CHANGE", "STOCK_TAKE", "DELIVERY", "INCIDENT", "HANDOVER" };


    /// <summary>
    /// Every shilling an attendant handed in, split by how it arrived.
    ///
    /// The close screen already collects this -- cash, MTN, Airtel, Visa -- but
    /// nothing showed it back afterwards, so "what did Moses hand in on Tuesday"
    /// had no answer once the shift was closed. That is the question a dealer
    /// asks when a mobile money statement does not match the books, and the
    /// channel is recorded precisely so it can be answered.
    ///
    /// Grouped by attendant then channel, because reconciling an Airtel
    /// statement means adding up Airtel across attendants, and querying one
    /// attendant means reading down their column.
    /// </summary>
    public async Task<IReadOnlyList<AttendantTenderRow>> TendersAsync(Guid shiftId,
                                                                      CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);
        return (await conn.QueryAsync<AttendantTenderRow>(new CommandDefinition(
            """
            SELECT c.id AS CashUpId, st.full_name AS AttendantName,
                   st.employee_no AS EmployeeNo,
                   st.employee_no AS EmployeeNo,
                   m.settlement::text AS Settlement,
                   pc.code AS ChannelCode, pc.name AS ChannelName,
                   pc.till_number AS TillNumber,
                   -- Settlements are stored negative: they reduce what is owed.
                   -- A person reading a statement wants the amount handed in.
                   abs(m.amount) AS Amount,
                   m.reference AS Reference
              FROM money_movement m
              JOIN cash_up c ON c.id = m.cash_up_id
              JOIN staff st  ON st.id = c.staff_id
              LEFT JOIN payment_channel pc ON pc.id = m.channel_id
             WHERE c.shift_id = @shift AND m.entry = 'SETTLEMENT'
             ORDER BY st.full_name, m.settlement::text, pc.code
            """,
            new { shift = shiftId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    private void Require(string permission)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);

        if (string.IsNullOrEmpty(_user.Role))
            throw new DomainException("NO_ROLE",
                "Your session carries no role, so nothing can be authorised. "
                + "Sign out and in again; if it persists, this is a server fault, "
                + "not a permissions one.", 403);

        if (!_user.Can(permission))
            throw new DomainException("FORBIDDEN",
                string.IsNullOrEmpty(_user.Role)
                    ? "Your session does not carry a role, so nothing can be authorised."
                    : $"A {_user.Role.ToLowerInvariant()} cannot do that.", 403);
    }
}
