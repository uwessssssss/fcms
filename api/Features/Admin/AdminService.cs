using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Admin;

// ---------------------------------------------------------------------------
// A note on the D in CRUD.
//
// There isn't one. 080_security.sql revokes DELETE from fcms_app on every
// table, and that is deliberate: a tank with six months of fuel_movement rows
// against it cannot be removed without destroying the ledger those rows prove.
// The same goes for a staff member whose name is on three hundred meter
// readings.
//
// So everything here is Create, Read, Update, Deactivate. An inactive tank
// stops appearing in rosters and dips; its history stays exactly where it was.
// If somebody genuinely needs a row gone, that is a DBA with a reason and an
// audit entry, not a button on a settings screen.
// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class StaffRow
{
    public Guid Id { get; set; }
    public string EmployeeNo { get; set; } = "";
    public string FullName { get; set; } = "";
    public string Role { get; set; } = "";
    public string? Phone { get; set; }
    public DateOnly? HiredOn { get; set; }
    public bool IsActive { get; set; }
    public bool IsOperator { get; set; }
    public bool HasPassword { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public DateTime? LockedUntil { get; set; }
    public int ActiveSessions { get; set; }
    /// <summary>Where they work. Screens filtered and showed people by site
    /// with no site to go on.</summary>
    public string SiteName { get; set; } = "";
}

public record UpsertStaff(string EmployeeNo, string FullName, string Role,
    string? Phone, DateOnly? HiredOn);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class EquipmentRow
{
    public Guid Id { get; set; }
    public string Kind { get; set; } = "";
    public string Code { get; set; } = "";
    public string? Detail { get; set; }
    public string? ParentCode { get; set; }
    public bool IsActive { get; set; }
    public bool InUse { get; set; }
    /// <summary>A nozzle's tank; null for tanks and pumps.</summary>
    public Guid? TankId { get; set; }
    /// <summary>A nozzle's last closing readings, manual and electronic: what
    /// an opening carries when nothing is typed.</summary>
    public decimal? LastManual { get; set; }
    public decimal? LastElectronic { get; set; }
}

public record UpsertTank(string Code, Guid ProductId, decimal NominalLitres,
    decimal SafeFill, decimal DeadStock, decimal MaxDipMm);

/// <summary>Materialised by Dapper, then converted to <see cref="UpsertTank"/>: Dapper
/// builds positional records through their constructor, which has failed before.</summary>
public sealed class TankEditRow
{
    public string Code { get; set; } = "";
    public Guid ProductId { get; set; }
    public decimal NominalLitres { get; set; }
    public decimal SafeFill { get; set; }
    public decimal DeadStock { get; set; }
    public decimal MaxDipMm { get; set; }
}

public record UpsertPump(string Code, string? Make, string? SerialNo);

/// <summary>Materialised by Dapper, then converted to <see cref="UpsertPump"/>: Dapper
/// builds positional records through their constructor, which has failed before.</summary>
public sealed class PumpEditRow
{
    public string Code { get; set; } = "";
    public string? Make { get; set; }
    public string? SerialNo { get; set; }
}

public record UpsertNozzle(string Code, Guid PumpId, Guid TankId,
    int IntegerDigits, decimal MaxFlowLpm);

/// <summary>Materialised by Dapper, then converted to <see cref="UpsertNozzle"/>: Dapper
/// builds positional records through their constructor, which has failed before.</summary>
public sealed class NozzleEditRow
{
    public string Code { get; set; } = "";
    public Guid PumpId { get; set; }
    public Guid TankId { get; set; }
    public int IntegerDigits { get; set; }
    public decimal MaxFlowLpm { get; set; }
}

public record UpsertProduct(string Code, string Name, string Uom, bool IsWetStock);

public record UpsertChannel(string Code, string Name, string Kind, string? TillNumber);

public record UpsertSupplier(string Code, string Name, string? Contact);

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class PolicyRow
{
    public decimal ShiftVariancePct { get; set; }
    public decimal ShiftVarianceLitres { get; set; }
    public decimal MonthlyVariancePct { get; set; }
    public decimal DipAgreementMm { get; set; }
    public decimal WaterAlarmMm { get; set; }
    /// <summary>Water above this many litres alarms too (migration 280). Tune to tank size.</summary>
    public decimal WaterAlarmLitres { get; set; }
    public bool AllowDipAboveChart { get; set; }
    public decimal MeterDivergencePct { get; set; }
    /// <summary>The most the electronic and manual meters' litres may differ at a
    /// close (730); beyond it the close needs a reason. Nullable as the cap is.</summary>
    public decimal? MeterPairToleranceLitres { get; set; }
    public decimal PumpTestTolerancePct { get; set; }
    public decimal TransitLossPct { get; set; }
    public int PostDecantSettleMin { get; set; }
    public decimal CashVarianceAlert { get; set; }
    /// <summary>Most cash an attendant should hold before dropping it in the
    /// safe (migration 580); 0 turns the check off. Nullable so a client that
    /// does not send it leaves the setting alone instead of switching it off.</summary>
    public decimal? AttendantCashCap { get; set; }
    /// <summary>A stock variance this small is inside what a dipstick reads and
    /// is not raised (migration 590). Nullable for the same reason as the cap.</summary>
    public decimal? DipNoiseLitres { get; set; }
    public decimal MaxShortageCarry { get; set; }
    public decimal RequireSecondApproverAbove { get; set; }
    public bool BreakShiftOnPriceChange { get; set; }
    public bool AllowCreditSales { get; set; }
    public int EvidenceGraceHours { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class SessionRow
{
    public Guid Id { get; set; }
    public string FullName { get; set; } = "";
    public string EmployeeNo { get; set; } = "";
    public DateTime IssuedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime LastSeenAt { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class AuditRow
{
    public long Id { get; set; }
    public string? ActorName { get; set; }
    public string Entity { get; set; } = "";
    public string EntityId { get; set; } = "";
    public string Action { get; set; } = "";
    public DateTime OccurredAt { get; set; }
    public string? IpAddress { get; set; }
}

public sealed class AdminService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public AdminService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly HashSet<string> Roles = new(StringComparer.OrdinalIgnoreCase)
        { "ATTENDANT", "SUPERVISOR", "MANAGER", "ACCOUNTANT", "AUDITOR", "ADMIN" };   // no DIRECTOR (690)

    // === STAFF ===============================================================

    public async Task<IReadOnlyList<StaffRow>> StaffAsync(bool includeInactive,
                                                          CancellationToken ct)
    {
        RequireAny("staff.manage", "shift.open", "report.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<StaffRow>(new CommandDefinition(
            """
            SELECT s.id AS Id, s.employee_no AS EmployeeNo, s.full_name AS FullName,
                   s.role::text AS Role, s.phone AS Phone, s.hired_on AS HiredOn,
                   s.is_active AS IsActive, s.is_operator AS IsOperator,
                   (c.staff_id IS NOT NULL) AS HasPassword,
                   c.last_login_at AS LastLoginAt, c.locked_until AS LockedUntil,
                   COALESCE(sess.n, 0) AS ActiveSessions,
                   COALESCE((SELECT name FROM site WHERE id = s.site_id), '') AS SiteName
              FROM staff s
              LEFT JOIN staff_credential c ON c.staff_id = s.id
              LEFT JOIN LATERAL (
                SELECT count(*) AS n FROM staff_session
                 WHERE staff_id = s.id AND revoked_at IS NULL AND expires_at > now()
              ) sess ON TRUE
             WHERE (@includeInactive = true OR s.is_active)
             ORDER BY s.is_active DESC, s.role, s.full_name
            """,
            new { includeInactive },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> SaveStaffAsync(Guid? id, UpsertStaff req, CancellationToken ct)
    {
        Require("staff.manage");

        if (!Roles.Contains(req.Role))
            throw new DomainException("INVALID_ROLE",
                $"'{req.Role}' is not a role. Use one of: {string.Join(", ", Roles)}");

        if (string.IsNullOrWhiteSpace(req.FullName) || string.IsNullOrWhiteSpace(req.EmployeeNo))
            throw new DomainException("MISSING_FIELDS",
                "An employee number and a full name are both required.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO staff (tenant_id, site_id, employee_no, full_name,
                                       role, phone, hired_on)
                    VALUES (@tenant, @site, @employeeNo, @fullName,
                            @role::staff_role, @phone, @hiredOn)
                    RETURNING id
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId,
                        employeeNo = req.EmployeeNo.Trim(), fullName = req.FullName.Trim(),
                        role = req.Role.ToUpperInvariant(), phone = req.Phone,
                        hiredOn = req.HiredOn
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            // Changing a role changes is_operator, and the composite FK will
            // refuse the update while the person still holds a credential.
            // That refusal is correct: demoting someone to attendant while they
            // can still sign in is exactly the state the schema exists to
            // prevent. Say so in words rather than surfacing a constraint name.
            var demoting = req.Role.Equals("ATTENDANT", StringComparison.OrdinalIgnoreCase);
            if (demoting)
            {
                var hasCred = await conn.ExecuteScalarAsync<bool>(new CommandDefinition(
                    "SELECT EXISTS (SELECT 1 FROM staff_credential WHERE staff_id = @id)",
                    new { id },
                    transaction: _uow.Transaction, cancellationToken: ct));
                if (hasCred)
                    throw new DomainException("REVOKE_SIGN_IN_FIRST",
                        "This person can currently sign in. Attendants cannot, so revoke "
                        + "their access before changing the role to attendant.");
            }

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE staff
                   SET employee_no = @employeeNo, full_name = @fullName,
                       role = @role::staff_role, phone = @phone, hired_on = @hiredOn
                 WHERE id = @id
                """,
                new
                {
                    id, employeeNo = req.EmployeeNo.Trim(), fullName = req.FullName.Trim(),
                    role = req.Role.ToUpperInvariant(), phone = req.Phone, hiredOn = req.HiredOn
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Take someone off strength.
    ///
    /// Not a delete: their name is on every reading they ever recorded and every
    /// shift they ever worked. Deactivating stops them appearing in rosters and
    /// kills their sessions immediately, which is what "they left" actually
    /// means operationally.
    /// </summary>
    public async Task DeactivateStaffAsync(Guid id, bool active, CancellationToken ct)
    {
        Require("staff.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var holding = await conn.ExecuteScalarAsync<bool>(new CommandDefinition(
                "SELECT EXISTS (SELECT 1 FROM nozzle_assignment " +
                " WHERE attendant_id = @id AND state = 'ACTIVE')",
                new { id },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (!active && holding)
                throw new DomainException("STILL_ON_A_NOZZLE",
                    "This attendant is currently holding a nozzle. Hand it over or close "
                    + "the shift first -- otherwise the fuel they pumped has nobody to "
                    + "settle against.");

            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE staff SET is_active = @active WHERE id = @id",
                new { id, active },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (!active)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    UPDATE staff_session
                       SET revoked_at = now(), revoked_by = @actor,
                           revoke_reason = 'Staff member deactivated'
                     WHERE staff_id = @id AND revoked_at IS NULL
                    """,
                    new { id, actor = _user.StaffId },
                    transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>Remove sign-in without removing the person.</summary>
    public async Task RevokeAccessAsync(Guid id, CancellationToken ct)
    {
        Require("staff.manage");
        var conn = await _uow.ConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(
            """
            UPDATE staff_session SET revoked_at = now(), revoked_by = @actor,
                   revoke_reason = 'Access revoked by administrator'
             WHERE staff_id = @id AND revoked_at IS NULL;
            DELETE FROM staff_credential WHERE staff_id = @id;
            """,
            new { id, actor = _user.StaffId },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    public async Task UnlockAsync(Guid id, CancellationToken ct)
    {
        Require("staff.manage");
        var conn = await _uow.ConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE staff_credential SET failed_logins = 0, locked_until = NULL " +
            " WHERE staff_id = @id",
            new { id },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    // === EQUIPMENT ===========================================================

    /// <summary>
    /// Everything on the forecourt, in one list.
    ///
    /// `InUse` is the important column: a tank with fuel in it or a nozzle on an
    /// open shift cannot be deactivated without stranding something. Better to
    /// grey the button than to explain a constraint afterwards.
    /// </summary>
    /// <remarks>
    /// Rename a product, or change its unit if nothing has been traded in it.
    /// The unit freeze lives in the database, so it holds for every path.
    /// </remarks>
    public async Task UpdateProductAsync(Guid id, UpsertProduct req, CancellationToken ct)
    {
        // The same permission as creating one. A looser rule for editing would
        // be a second, weaker door into the same room.
        Require("equipment.manage");
        if (string.IsNullOrWhiteSpace(req.Name))
            throw new DomainException("NAME_REQUIRED", "A product needs a name.", 422);
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var n = await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE product SET name = @name, uom = @uom, is_wet_stock = @wet WHERE id = @id",
                new { id, name = req.Name.Trim(), uom = req.Uom, wet = req.IsWetStock },
                transaction: _uow.Transaction, cancellationToken: ct));
            if (n == 0)
                throw new DomainException("NO_SUCH_PRODUCT", "There is no product with that id.", 404);
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<EquipmentRow>> EquipmentAsync(CancellationToken ct)
    {
        RequireAny("equipment.manage", "shift.open", "report.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<EquipmentRow>(new CommandDefinition(
            """
            SELECT t.id AS Id, 'TANK' AS Kind, t.code AS Code,
                   p.code || ' · ' || to_char(t.nominal_litres, 'FM999,999,990') || ' L, safe fill '
                     || to_char(t.safe_fill, 'FM999,999,990') || ' L' AS Detail,
                   NULL::text AS ParentCode, t.is_active AS IsActive,
                   (fn_book_stock(t.id) > t.dead_stock) AS InUse,
                   NULL::uuid AS TankId,
                   NULL::numeric AS LastManual, NULL::numeric AS LastElectronic
              FROM tank t JOIN product p ON p.id = t.product_id
             WHERE t.site_id = @site

            UNION ALL
            SELECT pu.id, 'PUMP', pu.code,
                   COALESCE(pu.make, '') ||
                     COALESCE(' · ' || pu.serial_no, ''),
                   NULL, pu.is_active,
                   EXISTS (SELECT 1 FROM nozzle n
                            JOIN nozzle_assignment na ON na.nozzle_id = n.id
                           WHERE n.pump_id = pu.id AND na.state = 'ACTIVE'),
                   NULL::uuid, NULL::numeric, NULL::numeric
              FROM pump pu WHERE pu.site_id = @site

            UNION ALL
            SELECT n.id, 'NOZZLE', n.code,
                   p.code || ' from ' || t.code || ' · '
                     || n.integer_digits || '-digit meter',
                   pu.code, n.is_active,
                   EXISTS (SELECT 1 FROM nozzle_assignment na
                            WHERE na.nozzle_id = n.id AND na.state = 'ACTIVE'),
                   -- the tank it draws from: the screen matched the tank by this
                   -- row's description, never found it, and said "no tank linked"
                   t.id,
                   -- what an opening carries when nothing is typed (730)
                   lc.volume_totalizer, lc.electronic_totalizer
              FROM nozzle n
              LEFT JOIN LATERAL (
                SELECT mr.volume_totalizer, mr.electronic_totalizer FROM meter_reading mr
                 WHERE mr.nozzle_id = n.id AND NOT mr.is_opening
                 ORDER BY mr.captured_at DESC, mr.id DESC LIMIT 1) lc ON TRUE
              JOIN pump pu ON pu.id = n.pump_id
              JOIN tank t  ON t.id = n.tank_id
              JOIN product p ON p.id = t.product_id
             WHERE n.site_id = @site

             ORDER BY 2, 3
            """,
            new { site = _user.SiteId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// A tank exactly as <see cref="SaveTankAsync"/> accepts it, for editing.
    /// </summary>
    /// <remarks>
    /// Returning the SAME record the save takes is what makes an edit safe:
    /// the screen loads everything, changes what it shows, and sends the rest
    /// back untouched. Without it, an edit form that shows three fields would
    /// save blanks over the other three. What may change on a USED tank is the
    /// database's decision (migration 340), not this method's.
    /// </remarks>
    /// <param name="id">The tank.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<UpsertTank> TankForEditAsync(Guid id, CancellationToken ct)
    {
        // Reading is broader than managing, as for the equipment list: the
        // SAVE still needs equipment.manage.
        RequireAny("equipment.manage", "shift.open", "report.view");
        var conn = await _uow.ConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<TankEditRow>(new CommandDefinition(
            """
            SELECT code AS Code, product_id AS ProductId, nominal_litres AS NominalLitres,
                   safe_fill AS SafeFill, dead_stock AS DeadStock, max_dip_mm AS MaxDipMm
              FROM tank WHERE id = @id
            """,
            new { id }, transaction: _uow.Transaction, cancellationToken: ct));
        if (row is null)
            throw new DomainException("NOT_FOUND", "No such tank.", 404);
        return new UpsertTank(row.Code, row.ProductId, row.NominalLitres, row.SafeFill, row.DeadStock, row.MaxDipMm);
    }

    /// <summary>A pump exactly as <see cref="SavePumpAsync"/> accepts it, for editing.</summary>
    /// <param name="id">The pump.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<UpsertPump> PumpForEditAsync(Guid id, CancellationToken ct)
    {
        // Reading is broader than managing, as for the equipment list: the
        // SAVE still needs equipment.manage.
        RequireAny("equipment.manage", "shift.open", "report.view");
        var conn = await _uow.ConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<PumpEditRow>(new CommandDefinition(
            """
            SELECT code AS Code, make AS Make, serial_no AS SerialNo
              FROM pump WHERE id = @id
            """,
            new { id }, transaction: _uow.Transaction, cancellationToken: ct));
        if (row is null)
            throw new DomainException("NOT_FOUND", "No such pump.", 404);
        return new UpsertPump(row.Code, row.Make, row.SerialNo);
    }

    /// <summary>A nozzle exactly as <see cref="SaveNozzleAsync"/> accepts it, for editing.</summary>
    /// <param name="id">The nozzle.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<UpsertNozzle> NozzleForEditAsync(Guid id, CancellationToken ct)
    {
        // Reading is broader than managing, as for the equipment list: the
        // SAVE still needs equipment.manage.
        RequireAny("equipment.manage", "shift.open", "report.view");
        var conn = await _uow.ConnectionAsync(ct);
        var row = await conn.QuerySingleOrDefaultAsync<NozzleEditRow>(new CommandDefinition(
            """
            SELECT code AS Code, pump_id AS PumpId, tank_id AS TankId,
                   integer_digits AS IntegerDigits, max_flow_lpm AS MaxFlowLpm
              FROM nozzle WHERE id = @id
            """,
            new { id }, transaction: _uow.Transaction, cancellationToken: ct));
        if (row is null)
            throw new DomainException("NOT_FOUND", "No such nozzle.", 404);
        return new UpsertNozzle(row.Code, row.PumpId, row.TankId, row.IntegerDigits, row.MaxFlowLpm);
    }

    public async Task<Guid> SaveTankAsync(Guid? id, UpsertTank r, CancellationToken ct, Guid? site = null)
    {
        Require("equipment.manage");
        if (r.SafeFill > r.NominalLitres)
            throw new DomainException("SAFE_FILL_TOO_HIGH",
                "Safe fill cannot exceed the tank's nominal capacity.");
        if (r.DeadStock >= r.SafeFill)
            throw new DomainException("DEAD_STOCK_TOO_HIGH",
                "Dead stock must be less than safe fill, or the tank has nothing to sell.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO tank (tenant_id, site_id, product_id, code,
                                      nominal_litres, safe_fill, dead_stock, max_dip_mm)
                    VALUES (@tenant, @site, @product, @code, @nominal, @safe, @dead, @maxDip)
                    RETURNING id
                    """,
                    new
                    {
                        // A chosen site (head office equipping its depot), else the caller's own.
                        // Row-level security keeps it inside the company; the database still
                        // refuses a tank at a head office.
                        tenant = _user.TenantId, site = site ?? _user.SiteId, product = r.ProductId,
                        code = r.Code.Trim(), nominal = r.NominalLitres, safe = r.SafeFill,
                        dead = r.DeadStock, maxDip = r.MaxDipMm
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE tank SET code = @code, nominal_litres = @nominal,
                       safe_fill = @safe, dead_stock = @dead, max_dip_mm = @maxDip
                 WHERE id = @id
                """,
                new
                {
                    id, code = r.Code.Trim(), nominal = r.NominalLitres,
                    safe = r.SafeFill, dead = r.DeadStock, maxDip = r.MaxDipMm
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> SavePumpAsync(Guid? id, UpsertPump r, CancellationToken ct)
    {
        Require("equipment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    "INSERT INTO pump (tenant_id, site_id, code, make, serial_no) " +
                    "VALUES (@tenant, @site, @code, @make, @serial) RETURNING id",
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId,
                        code = r.Code.Trim(), make = r.Make, serial = r.SerialNo
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE pump SET code = @code, make = @make, serial_no = @serial WHERE id = @id",
                new { id, code = r.Code.Trim(), make = r.Make, serial = r.SerialNo },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> SaveNozzleAsync(Guid? id, UpsertNozzle r, CancellationToken ct)
    {
        Require("equipment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO nozzle (tenant_id, site_id, pump_id, tank_id, code,
                                        integer_digits, max_flow_lpm)
                    VALUES (@tenant, @site, @pump, @tank, @code, @digits, @flow)
                    RETURNING id
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId, pump = r.PumpId,
                        tank = r.TankId, code = r.Code.Trim(),
                        digits = r.IntegerDigits, flow = r.MaxFlowLpm
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE nozzle SET code = @code, pump_id = @pump, tank_id = @tank,
                       integer_digits = @digits, max_flow_lpm = @flow
                 WHERE id = @id
                """,
                new
                {
                    id, code = r.Code.Trim(), pump = r.PumpId, tank = r.TankId,
                    digits = r.IntegerDigits, flow = r.MaxFlowLpm
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task SetEquipmentActiveAsync(string kind, Guid id, bool active,
                                              CancellationToken ct)
    {
        Require("equipment.manage");
        var table = kind.ToUpperInvariant() switch
        {
            "TANK" => "tank",
            "PUMP" => "pump",
            "NOZZLE" => "nozzle",
            _ => throw new DomainException("UNKNOWN_EQUIPMENT", $"'{kind}' is not equipment.")
        };

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (!active && table == "tank")
            {
                var stock = await conn.ExecuteScalarAsync<decimal>(new CommandDefinition(
                    "SELECT fn_book_stock(@id) - (SELECT dead_stock FROM tank WHERE id = @id)",
                    new { id },
                    transaction: _uow.Transaction, cancellationToken: ct));
                if (stock > 0)
                    throw new DomainException("TANK_NOT_EMPTY",
                        $"That tank still holds {stock:N0} sellable litres. Empty it or "
                        + "transfer the stock before taking it out of service -- otherwise "
                        + "the fuel disappears from the books without ever moving.");
            }

            // One statement per table rather than an interpolated name. The
            // switch above already made this safe, but "safe because of a
            // comment ten lines up" is the kind of safety that survives until
            // somebody adds a fourth case.
            var sql = table switch
            {
                "tank"   => "UPDATE tank   SET is_active = @active WHERE id = @id",
                "pump"   => "UPDATE pump   SET is_active = @active WHERE id = @id",
                "nozzle" => "UPDATE nozzle SET is_active = @active WHERE id = @id",
                _ => throw new DomainException("UNKNOWN_EQUIPMENT", "Not equipment."),
            };

            await conn.ExecuteAsync(new CommandDefinition(
                sql,
                new { id, active },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === CATALOGUES ==========================================================

    public async Task<Guid> SaveProductAsync(Guid? id, UpsertProduct r, CancellationToken ct)
    {
        Require("equipment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    "INSERT INTO product (tenant_id, code, name, uom, is_wet_stock) " +
                    "VALUES (@tenant, @code, @name, @uom, @wet) RETURNING id",
                    new
                    {
                        tenant = _user.TenantId, code = r.Code.Trim().ToUpperInvariant(),
                        name = r.Name.Trim(), uom = r.Uom, wet = r.IsWetStock
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE product SET code = @code, name = @name, uom = @uom WHERE id = @id",
                new
                {
                    id, code = r.Code.Trim().ToUpperInvariant(),
                    name = r.Name.Trim(), uom = r.Uom
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> SaveChannelAsync(Guid? id, UpsertChannel r, CancellationToken ct)
    {
        Require("payment_channel.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO payment_channel (tenant_id, site_id, code, name, kind, till_number)
                    VALUES (@tenant, @site, @code, @name, @kind::settlement_kind, @till)
                    RETURNING id
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId,
                        code = r.Code.Trim().ToUpperInvariant(), name = r.Name.Trim(),
                        kind = r.Kind.ToUpperInvariant(), till = r.TillNumber
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE payment_channel SET code = @code, name = @name, till_number = @till " +
                " WHERE id = @id",
                new
                {
                    id, code = r.Code.Trim().ToUpperInvariant(),
                    name = r.Name.Trim(), till = r.TillNumber
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<Guid> SaveSupplierAsync(Guid? id, UpsertSupplier r, CancellationToken ct)
    {
        Require("equipment.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    "INSERT INTO supplier (tenant_id, code, name, contact) " +
                    "VALUES (@tenant, @code, @name, @contact) RETURNING id",
                    new
                    {
                        tenant = _user.TenantId, code = r.Code.Trim().ToUpperInvariant(),
                        name = r.Name.Trim(), contact = r.Contact
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE supplier SET code = @code, name = @name, contact = @contact WHERE id = @id",
                new
                {
                    id, code = r.Code.Trim().ToUpperInvariant(),
                    name = r.Name.Trim(), contact = r.Contact
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === POLICY ==============================================================

    public async Task<PolicyRow> PolicyAsync(CancellationToken ct)
    {
        Require("policy.configure");
        var conn = await _uow.ConnectionAsync(ct);
        // SingleOrDefault, not Single: a tenant created without a policy row
        // would otherwise fail with "sequence contains no elements", which
        // tells an administrator nothing about what to do.
        return await conn.QuerySingleOrDefaultAsync<PolicyRow>(new CommandDefinition(
            """
            SELECT shift_variance_pct AS ShiftVariancePct,
                   shift_variance_litres AS ShiftVarianceLitres,
                   monthly_variance_pct AS MonthlyVariancePct,
                   dip_agreement_mm AS DipAgreementMm,
                   water_alarm_mm AS WaterAlarmMm,
                   water_alarm_litres AS WaterAlarmLitres,
                   allow_dip_above_chart AS AllowDipAboveChart,
                   meter_divergence_pct AS MeterDivergencePct,
                   meter_pair_tolerance_litres AS MeterPairToleranceLitres,
                   pump_test_tolerance_pct AS PumpTestTolerancePct,
                   transit_loss_pct AS TransitLossPct,
                   post_decant_settle_min AS PostDecantSettleMin,
                   cash_variance_alert AS CashVarianceAlert,
                   attendant_cash_cap AS AttendantCashCap,
                   dip_noise_litres AS DipNoiseLitres,
                   max_shortage_carry AS MaxShortageCarry,
                   require_second_approver_above AS RequireSecondApproverAbove,
                   break_shift_on_price_change AS BreakShiftOnPriceChange,
                   allow_credit_sales AS AllowCreditSales,
                   evidence_grace_hours AS EvidenceGraceHours
              FROM tenant_policy WHERE tenant_id = @tenant
            """,
            new { tenant = _user.TenantId },
            transaction: _uow.Transaction, cancellationToken: ct))
            ?? throw new DomainException("NO_POLICY",
                "This business has no tolerance settings yet. They are created "
                + "with the tenant -- if this is a new database, the seed did "
                + "not finish.", 404);
    }

    public async Task SavePolicyAsync(PolicyRow p, CancellationToken ct)
    {
        Require("policy.configure");

        // These are the numbers that decide what counts as a loss. Loosening
        // them is a legitimate business decision and a serious one, so the
        // obviously-wrong values are refused rather than accepted quietly.
        if (p.ShiftVariancePct <= 0 || p.ShiftVariancePct > 5)
            throw new DomainException("IMPLAUSIBLE_TOLERANCE",
                "A shift variance tolerance above 5% would let a tanker-load "
                + "disappear inside tolerance. Set something between 0.1 and 5.");
        if (p.ShiftVarianceLitres <= 0 || p.ShiftVarianceLitres > 1000)
            throw new DomainException("IMPLAUSIBLE_TOLERANCE",
                "The litre floor should be tens of litres, not thousands.");

        if (p.DipNoiseLitres is < 0 or > 100)
            throw new DomainException("IMPLAUSIBLE_TOLERANCE",
                "Dip noise is a few litres -- what the stick cannot read. Above 100 L it would hide real losses.");
        if (p.MeterPairToleranceLitres is < 0 or > 20)
            throw new DomainException("IMPLAUSIBLE_TOLERANCE",
                "The two meters agree to within a litre or so. Above 20 L the check would let real faults through.");
        if (p.AttendantCashCap is < 0)
            throw new DomainException("IMPLAUSIBLE_TOLERANCE",
                "The cash an attendant may hold cannot be negative. Use 0 to turn the check off.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE tenant_policy SET
                  shift_variance_pct = @ShiftVariancePct,
                  shift_variance_litres = @ShiftVarianceLitres,
                  monthly_variance_pct = @MonthlyVariancePct,
                  dip_agreement_mm = @DipAgreementMm,
                  water_alarm_mm = @WaterAlarmMm,
                  water_alarm_litres = @WaterAlarmLitres,
                  allow_dip_above_chart = @AllowDipAboveChart,
                  meter_divergence_pct = @MeterDivergencePct,
                  meter_pair_tolerance_litres = COALESCE(@MeterPairToleranceLitres, meter_pair_tolerance_litres),
                  pump_test_tolerance_pct = @PumpTestTolerancePct,
                  transit_loss_pct = @TransitLossPct,
                  post_decant_settle_min = @PostDecantSettleMin,
                  cash_variance_alert = @CashVarianceAlert,
                  attendant_cash_cap = COALESCE(@AttendantCashCap, attendant_cash_cap),
                  dip_noise_litres = COALESCE(@DipNoiseLitres, dip_noise_litres),
                  max_shortage_carry = @MaxShortageCarry,
                  require_second_approver_above = @RequireSecondApproverAbove,
                  break_shift_on_price_change = @BreakShiftOnPriceChange,
                  allow_credit_sales = @AllowCreditSales,
                  evidence_grace_hours = @EvidenceGraceHours,
                  updated_at = now()
                 WHERE tenant_id = @tenant
                """,
                new
                {
                    p.ShiftVariancePct, p.ShiftVarianceLitres, p.MonthlyVariancePct,
                    p.DipAgreementMm, p.WaterAlarmMm, p.WaterAlarmLitres, p.AllowDipAboveChart,
                    p.MeterDivergencePct, p.MeterPairToleranceLitres, p.PumpTestTolerancePct, p.TransitLossPct,
                    p.PostDecantSettleMin, p.CashVarianceAlert, p.AttendantCashCap, p.DipNoiseLitres, p.MaxShortageCarry,
                    p.RequireSecondApproverAbove, p.BreakShiftOnPriceChange,
                    p.AllowCreditSales, p.EvidenceGraceHours, tenant = _user.TenantId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    // === SESSIONS AND AUDIT ==================================================

    public async Task<IReadOnlyList<SessionRow>> SessionsAsync(CancellationToken ct)
    {
        Require("session.revoke");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<SessionRow>(new CommandDefinition(
            """
            SELECT ss.id AS Id, s.full_name AS FullName, s.employee_no AS EmployeeNo,
                   ss.issued_at AS IssuedAt, ss.expires_at AS ExpiresAt,
                   ss.last_seen_at AS LastSeenAt,
                   host(ss.ip_address) AS IpAddress, ss.user_agent AS UserAgent
              FROM staff_session ss JOIN staff s ON s.id = ss.staff_id
             WHERE ss.revoked_at IS NULL AND ss.expires_at > now()
             ORDER BY ss.last_seen_at DESC
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task RevokeSessionAsync(Guid sessionId, CancellationToken ct)
    {
        Require("session.revoke");
        var conn = await _uow.ConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE staff_session SET revoked_at = now(), revoked_by = @actor, " +
            "       revoke_reason = 'Revoked by administrator' WHERE id = @id",
            new { id = sessionId, actor = _user.StaffId },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    public async Task<IReadOnlyList<AuditRow>> AuditAsync(int days, CancellationToken ct)
    {
        Require("audit.view");
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<AuditRow>(new CommandDefinition(
            """
            SELECT a.id AS Id, s.full_name AS ActorName, a.entity AS Entity,
                   a.entity_id AS EntityId, a.action AS Action,
                   a.occurred_at AS OccurredAt, host(a.ip_address) AS IpAddress
              FROM audit_log a LEFT JOIN staff s ON s.id = a.actor_id
             WHERE a.occurred_at > now() - (@days || ' days')::interval
             ORDER BY a.occurred_at DESC LIMIT 300
            """,
            new { days },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// Passes if the caller holds ANY of the permissions.
    ///
    /// For READING reference data: who works here, what equipment exists, how
    /// the site is doing. Reading was gated by the MANAGE permission, so the
    /// supervisors and managers who open shifts could not load the equipment
    /// or the staff list they roster from, and a supervisor's own dashboard
    /// refused them. Changing that data still needs the manage permission.
    /// </summary>
    private void RequireAny(params string[] permissions)
    {
        if (!_user.IsAuthenticated)
            throw new DomainException("UNAUTHENTICATED", "Sign in to continue.", 401);
        if (!permissions.Any(_user.Can))
            throw new DomainException("FORBIDDEN",
                $"This needs one of: {string.Join(", ", permissions)}.", 403);
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

public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin").RequireAuthorization();

        g.MapGet("/staff", async (bool? includeInactive, AdminService s, CancellationToken ct) =>
            Results.Ok(await s.StaffAsync(includeInactive ?? true, ct)));
        g.MapPut("/staff/{id:guid}", async (Guid id, UpsertStaff r, AdminService s,
                                            CancellationToken ct) =>
            Results.Ok(new { staffId = await s.SaveStaffAsync(id, r, ct) }));
        g.MapPost("/staff/{id:guid}/active", async (Guid id, bool active, AdminService s,
                                                    CancellationToken ct) =>
        {
            await s.DeactivateStaffAsync(id, active, ct);
            return Results.Ok(new { active });
        });
        g.MapPost("/staff/{id:guid}/revoke-access", async (Guid id, AdminService s,
                                                           CancellationToken ct) =>
        {
            await s.RevokeAccessAsync(id, ct);
            return Results.Ok(new { revoked = true });
        });
        g.MapPost("/staff/{id:guid}/unlock", async (Guid id, AdminService s,
                                                    CancellationToken ct) =>
        {
            await s.UnlockAsync(id, ct);
            return Results.Ok(new { unlocked = true });
        });

        // Renaming a product is harmless. Changing its unit once a tank holds
        // it would reinterpret its whole history, and the database refuses
        // that (PRODUCT_UNIT_FROZEN) -- so this passes the request through and
        // lets the trigger say why.
        g.MapPut("/products/{id:guid}", async (Guid id, UpsertProduct r, AdminService s,
                                               CancellationToken ct) =>
        {
            await s.UpdateProductAsync(id, r, ct);
            return Results.Ok(new { productId = id });
        });

        g.MapGet("/equipment", async (AdminService s, CancellationToken ct) =>
            Results.Ok(await s.EquipmentAsync(ct)));
        g.MapPost("/tanks", async (UpsertTank r, Guid? site, AdminService s, CancellationToken ct) =>
            Results.Ok(new { tankId = await s.SaveTankAsync(null, r, ct, site) }));
        // Load-for-edit: each returns the record its PUT accepts.
        g.MapGet("/tanks/{id:guid}", async (Guid id, AdminService s, CancellationToken ct) =>
            Results.Ok(await s.TankForEditAsync(id, ct)));
        g.MapGet("/pumps/{id:guid}", async (Guid id, AdminService s, CancellationToken ct) =>
            Results.Ok(await s.PumpForEditAsync(id, ct)));
        g.MapGet("/nozzles/{id:guid}", async (Guid id, AdminService s, CancellationToken ct) =>
            Results.Ok(await s.NozzleForEditAsync(id, ct)));
        g.MapPut("/tanks/{id:guid}", async (Guid id, UpsertTank r, AdminService s,
                                            CancellationToken ct) =>
            Results.Ok(new { tankId = await s.SaveTankAsync(id, r, ct) }));
        g.MapPost("/pumps", async (UpsertPump r, AdminService s, CancellationToken ct) =>
            Results.Ok(new { pumpId = await s.SavePumpAsync(null, r, ct) }));
        g.MapPut("/pumps/{id:guid}", async (Guid id, UpsertPump r, AdminService s,
                                            CancellationToken ct) =>
            Results.Ok(new { pumpId = await s.SavePumpAsync(id, r, ct) }));
        g.MapPost("/nozzles", async (UpsertNozzle r, AdminService s, CancellationToken ct) =>
            Results.Ok(new { nozzleId = await s.SaveNozzleAsync(null, r, ct) }));
        g.MapPut("/nozzles/{id:guid}", async (Guid id, UpsertNozzle r, AdminService s,
                                              CancellationToken ct) =>
            Results.Ok(new { nozzleId = await s.SaveNozzleAsync(id, r, ct) }));
        g.MapPost("/equipment/{kind}/{id:guid}/active",
            async (string kind, Guid id, bool active, AdminService s, CancellationToken ct) =>
            {
                await s.SetEquipmentActiveAsync(kind, id, active, ct);
                return Results.Ok(new { active });
            });

        g.MapPost("/products", async (UpsertProduct r, AdminService s, CancellationToken ct) =>
            Results.Ok(new { productId = await s.SaveProductAsync(null, r, ct) }));
        g.MapPost("/channels", async (UpsertChannel r, AdminService s, CancellationToken ct) =>
            Results.Ok(new { channelId = await s.SaveChannelAsync(null, r, ct) }));
        g.MapPost("/suppliers", async (UpsertSupplier r, AdminService s, CancellationToken ct) =>
            Results.Ok(new { supplierId = await s.SaveSupplierAsync(null, r, ct) }));

        g.MapGet("/policy", async (AdminService s, CancellationToken ct) =>
            Results.Ok(await s.PolicyAsync(ct)));
        g.MapPut("/policy", async (PolicyRow r, AdminService s, CancellationToken ct) =>
        {
            await s.SavePolicyAsync(r, ct);
            return Results.Ok(new { saved = true });
        });

        g.MapGet("/sessions", async (AdminService s, CancellationToken ct) =>
            Results.Ok(await s.SessionsAsync(ct)));
        g.MapPost("/sessions/{id:guid}/revoke", async (Guid id, AdminService s,
                                                       CancellationToken ct) =>
        {
            await s.RevokeSessionAsync(id, ct);
            return Results.Ok(new { revoked = true });
        });

        g.MapGet("/audit", async (int? days, AdminService s, CancellationToken ct) =>
            Results.Ok(await s.AuditAsync(days ?? 7, ct)));
    }
}
