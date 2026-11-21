using Dapper;
using Npgsql;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;

namespace Fcms.Api.Features.Organisation;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// <summary>
/// A company, its head office and the person who runs it, created together.
/// </summary>
/// <param name="Name">The trading name.</param>
/// <param name="LegalName">The registered name, if it differs.</param>
/// <param name="RegistrationNo">Company registration number.</param>
/// <param name="TaxId">Tax identification number.</param>
/// <param name="CountryCode">Two letters, e.g. UG.</param>
/// <param name="BaseCurrency">Three letters, e.g. UGX. Every figure is held in it.</param>
/// <param name="Timezone">
/// Where the fuel is sold, which decides the business date a shift belongs to.
/// </param>
/// <param name="HeadOfficeName">
/// The head office site. It trades nothing; it is who appoints the managers.
/// </param>
/// <param name="HeadOfficeAddress">Postal or physical address, optional.</param>
/// <param name="HeadOfficeEmployeeNo">
/// The sign-in for the person who will run this company. Required: a company
/// with nobody in it cannot be signed into, and nobody can be added to it
/// afterwards -- appointing into another company is the write row-level
/// security refuses.
/// </param>
/// <param name="HeadOfficeManagerName">That person's full name.</param>
/// <param name="HeadOfficePhone">That person's phone, optional.</param>
public record CreateCompany(
    string Name, string? LegalName, string? RegistrationNo, string? TaxId,
    string CountryCode, string BaseCurrency, string Timezone,
    string HeadOfficeName, string? HeadOfficeAddress,
    string HeadOfficeEmployeeNo, string HeadOfficeManagerName, string? HeadOfficePhone);

/// <summary>A trading site under an existing company.</summary>
public record CreateSite(
    Guid CompanyId, string Code, string Name, string Kind,
    string? Address, string Timezone, TimeOnly DayStartsAt,
    decimal? RevenueTarget);

/// <summary>A depot added by the company itself.</summary>
/// <param name="Code">Short code, unique in the company.</param>
/// <param name="Name">The depot's name.</param>
/// <param name="Address">Where it is, if known.</param>
public record AddDepot(string Code, string Name, string? Address);

/// <summary>A person, with the role they will hold.</summary>
public record CreatePerson(
    Guid SiteId, string EmployeeNo, string FullName, string Role,
    string? Phone, DateOnly? HiredOn);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class CompanyRow
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string? LegalName { get; set; }
    public string? RegistrationNo { get; set; }
    public string CountryCode { get; set; } = "";
    public string BaseCurrency { get; set; } = "";
    public Guid? HeadOfficeId { get; set; }
    public string? HeadOfficeName { get; set; }
    public int SiteCount { get; set; }
    public int StaffCount { get; set; }
    public bool IsActive { get; set; }
}

/// <summary>Dapper target: class with settable properties.</summary>
public sealed class SiteApprovalRow
{
    public Guid SiteId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public int ManagerCount { get; set; }
    public bool CanSelfApprove { get; set; }
    public string Note { get; set; } = "";
}

/// <summary>
/// The organisation: companies, the sites under them, and who staffs them.
///
/// WHY THIS IS A SEPARATE SERVICE from Admin.
///
/// Admin manages things WITHIN a company -- its tanks, its pumps, its price
/// channels. This manages the company itself and who may act on it, and the
/// two answer to different people. Mixing them would put "create a company"
/// behind the same permission as "add a nozzle", and the person who adds a
/// nozzle should not be able to create a company.
///
/// EVERY CREATION HERE IS ROLE-GATED, and the gate is the database function
/// fn_may_create_staff rather than a check written here. That is deliberate:
/// an endpoint is one path to a table, and the rule has to hold for the psql
/// session somebody opens at eleven at night as well.
/// </summary>
public sealed class OrganisationService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public OrganisationService(IUnitOfWork uow, ICurrentUser user)
        => (_uow, _user) = (uow, user);

    private void Require(string permission)
    {
        if (!_user.Can(permission))
            throw new DomainException("NOT_PERMITTED",
                $"This needs the {permission} permission.", 403);
    }

    /// <summary>Every company. System administrators only.</summary>
    public async Task<IReadOnlyList<CompanyRow>> CompaniesAsync(CancellationToken ct)
    {
        Require("system.admin");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<CompanyRow>(new CommandDefinition(
            // Through fn_platform_companies, not FROM tenant: row-level security
            // shows a caller only their own company, so a direct query here
            // returned one row and looked like it worked.
            """
            SELECT id               AS Id,
                   name             AS Name,
                   legal_name       AS LegalName,
                   registration_no  AS RegistrationNo,
                   country_code     AS CountryCode,
                   base_currency    AS BaseCurrency,
                   head_office_id   AS HeadOfficeId,
                   head_office_name AS HeadOfficeName,
                   site_count       AS SiteCount,
                   staff_count      AS StaffCount,
                   is_active        AS IsActive
              FROM fn_platform_companies()
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// A company and its head office, created together.
    ///
    /// TOGETHER, not as two calls. A company without a head office has nobody
    /// who may appoint its managers, so it cannot be staffed -- and a system
    /// that lets you create one and then discover it is unusable has simply
    /// moved the error somewhere less helpful.
    /// </summary>
    public async Task<CompanyRow> CreateCompanyAsync(CreateCompany req, CancellationToken ct)
    {
        Require("system.admin");

        if (string.IsNullOrWhiteSpace(req.Name))
            throw new DomainException("NAME_REQUIRED", "A company needs a name.", 422);
        if (string.IsNullOrWhiteSpace(req.HeadOfficeName))
            throw new DomainException("HEAD_OFFICE_REQUIRED",
                "A company is created with its head office. Without one there is "
                + "nobody who may appoint its managers.", 422);

        var conn = await _uow.ConnectionAsync(ct);

        // One function does the company, its policy, its head office and its
        // income categories. It checks that the caller is a system
        // administrator in the database, and it is the only path past the
        // row-level security that refuses creating a tenant not your own.
        Guid companyId;
        try
        {
            companyId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                SELECT company_id
                  FROM fn_platform_create_company(@Name, @LegalName, @RegistrationNo,
                         @TaxId, @CountryCode, @BaseCurrency, @Timezone,
                         @HeadOfficeName, @HeadOfficeAddress,
                         @HeadOfficeEmployeeNo, @HeadOfficeManagerName, @HeadOfficePhone)
                """,
                new
                {
                    req.Name, req.LegalName, req.RegistrationNo, req.TaxId,
                    req.CountryCode, req.BaseCurrency, req.Timezone,
                    req.HeadOfficeName, req.HeadOfficeAddress,
                    req.HeadOfficeEmployeeNo, req.HeadOfficeManagerName, req.HeadOfficePhone,
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }

        return (await CompaniesAsync(ct)).First(c => c.Id == companyId);
    }

    /// <summary>
    /// Head office adds a DEPOT to its own company.
    /// </summary>
    /// <remarks>
    /// Most companies have no depot, a few do, so it is set up from the
    /// company's own settings rather than asked of the platform. Only a DEPOT,
    /// only in the caller's company: a plain insert that row-level security
    /// scopes to their tenant -- the platform function is for creating sites
    /// in OTHER companies. Stations are still added by the platform. The depot
    /// takes the head office's timezone and day start, so its business days
    /// line up with the stations'.
    /// </remarks>
    /// <param name="req">The depot.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<Guid> AddDepotAsync(AddDepot req, CancellationToken ct)
    {
        Require("equipment.manage");
        if (string.IsNullOrWhiteSpace(req.Code) || string.IsNullOrWhiteSpace(req.Name))
            throw new DomainException("DEPOT_NEEDS_A_NAME", "A depot needs a code and a name.", 422);
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO site (tenant_id, code, name, kind, address, timezone, day_starts_at)
                VALUES (@tenant, upper(@code), @name, 'DEPOT', @address,
                        COALESCE((SELECT timezone FROM site WHERE tenant_id = @tenant
                                   AND kind = 'HEAD_OFFICE' LIMIT 1), 'Africa/Kampala'),
                        COALESCE((SELECT day_starts_at FROM site WHERE tenant_id = @tenant
                                   AND kind = 'HEAD_OFFICE' LIMIT 1), '06:00'::time))
                RETURNING id
                """,
                new { tenant = _user.TenantId, code = req.Code.Trim(), name = req.Name.Trim(), address = req.Address },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>A trading site under a company.</summary>
    public async Task<Guid> CreateSiteAsync(CreateSite req, CancellationToken ct)
    {
        Require("system.admin");

        if (req.Kind.Equals("HEAD_OFFICE", StringComparison.OrdinalIgnoreCase))
            throw new DomainException("HEAD_OFFICE_ALREADY_EXISTS",
                "A company has exactly one head office, created with the company. "
                + "This endpoint adds trading sites: STATION or DEPOT.", 422);

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            // Through fn_platform_create_site: a site for another company is a
            // row row-level security would refuse, so it goes the one checked way.
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                SELECT fn_platform_create_site(@CompanyId, @Code, @Name, @Kind,
                         @Address, @Timezone, @DayStartsAt, @RevenueTarget)
                """,
                new
                {
                    req.CompanyId, req.Code, req.Name, req.Kind, req.Address,
                    req.Timezone, req.DayStartsAt, req.RevenueTarget,
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// A person, if the caller is allowed to appoint that role.
    ///
    /// The gate is fn_may_create_staff in the database, asked here so the
    /// refusal carries a sentence rather than a constraint violation. The
    /// constraint is still there underneath -- this is the courtesy, not the
    /// control.
    /// </summary>
    public async Task<Guid> CreatePersonAsync(CreatePerson req, CancellationToken ct)
    {
        Require("staff.manage");
        var conn = await _uow.ConnectionAsync(ct);

        var allowed = await conn.ExecuteScalarAsync<bool>(new CommandDefinition(
            "SELECT fn_may_create_staff(@actor, @role::staff_role)",
            new { actor = _user.StaffId, role = req.Role.ToUpperInvariant() },
            transaction: _uow.Transaction, cancellationToken: ct));

        if (!allowed)
            throw new DomainException("MAY_NOT_APPOINT_THIS_ROLE",
                req.Role.Equals("MANAGER", StringComparison.OrdinalIgnoreCase)
                    ? "A manager cannot appoint another manager. The second manager "
                      + "is who approves your shifts, and appointing your own "
                      + "reviewer defeats the segregation. Ask head office."
                    : $"Your role cannot appoint a {req.Role.ToLowerInvariant()}.",
                403);

        return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
            """
            INSERT INTO staff (tenant_id, site_id, employee_no, full_name,
                               role, phone, hired_on, is_active)
            VALUES (@tenant, @SiteId, @EmployeeNo, @FullName,
                    @Role::staff_role, @Phone, @HiredOn, true)
            RETURNING id
            """,
            new
            {
                tenant = _user.TenantId,
                req.SiteId, req.EmployeeNo, req.FullName,
                Role = req.Role.ToUpperInvariant(), req.Phone, req.HiredOn,
            },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    /// <summary>
    /// Which sites have enough managers to approve their own shifts.
    ///
    /// The list a head office should look at before a month-end: a site with
    /// one manager is not broken, but every shift it closes needs head office
    /// to approve, and discovering that at eleven at night is nobody's idea of
    /// a control.
    /// </summary>
    public async Task<IReadOnlyList<SiteApprovalRow>> ApprovalReadinessAsync(
        CancellationToken ct)
    {
        Require("report.view");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<SiteApprovalRow>(new CommandDefinition(
            """
            SELECT site_id          AS SiteId,
                   code             AS Code,
                   name             AS Name,
                   kind::text       AS Kind,
                   manager_count::int AS ManagerCount,
                   can_self_approve AS CanSelfApprove,
                   note             AS Note
              FROM v_site_approval_readiness
             ORDER BY can_self_approve, name
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }
}

/// <summary>Routes for the organisation.</summary>
public static class OrganisationEndpoints
{
    public static void MapOrganisation(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/organisation")
                   .RequireAuthorization()
                   .WithTags("Organisation");

        g.MapGet("/companies",
            async (OrganisationService s, CancellationToken ct) =>
                Results.Ok(await s.CompaniesAsync(ct)))
         .WithSummary("Every company")
         .WithDescription("System administrators only.");

        g.MapPost("/companies",
            async (CreateCompany req, OrganisationService s, CancellationToken ct) =>
                Results.Ok(await s.CreateCompanyAsync(req, ct)))
         .WithSummary("Create a company and its head office")
         .WithDescription(
             "Created together: a company without a head office has nobody who "
             + "may appoint its managers.");

        g.MapPost("/depots", async (AddDepot req, OrganisationService s, CancellationToken ct) =>
            Results.Ok(new { id = await s.AddDepotAsync(req, ct) }));
        g.MapPost("/sites",
            async (CreateSite req, OrganisationService s, CancellationToken ct) =>
                Results.Ok(new { id = await s.CreateSiteAsync(req, ct) }))
         .WithSummary("Add a trading site")
         .WithDescription("STATION or DEPOT. The head office already exists.");

        g.MapPost("/people",
            async (CreatePerson req, OrganisationService s, CancellationToken ct) =>
                Results.Ok(new { id = await s.CreatePersonAsync(req, ct) }))
         .WithSummary("Appoint somebody")
         .WithDescription(
             "Role-gated. A manager may staff their station but may not appoint "
             + "another manager — that second manager is who approves their shifts.");

        g.MapGet("/approval-readiness",
            async (OrganisationService s, CancellationToken ct) =>
                Results.Ok(await s.ApprovalReadinessAsync(ct)))
         .WithSummary("Which sites can approve their own shifts")
         .WithDescription("A site with one manager needs head office to approve.");
    }
}
