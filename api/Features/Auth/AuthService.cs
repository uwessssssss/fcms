using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Fcms.Api.Features.Auth;

public record LoginRequest(string EmployeeNo, string Password);
public record LoginResponse(string Token, DateTime ExpiresAt, Guid StaffId,
    string FullName, string Role, Guid SiteId, bool MustChangePassword,
    IReadOnlyCollection<string> Permissions);
public record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public sealed class AuthService
{
    private readonly IUnitOfWork _uow;
    private readonly IConfiguration _cfg;
    private readonly ICurrentUser _user;
    private readonly ILogger<AuthService> _log;

    public AuthService(IUnitOfWork uow, IConfiguration cfg, ICurrentUser user,
                       ILogger<AuthService> log)
        => (_uow, _cfg, _user, _log) = (uow, cfg, user, log);

    /// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
internal sealed class AuthRow
{
    public Guid StaffId { get; set; }
    public Guid TenantId { get; set; }
    public Guid? SiteId { get; set; }
    public string FullName { get; set; } = "";
    public string Role { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public bool MustChange { get; set; }
    public int FailedLogins { get; set; }
    public DateTime? LockedUntil { get; set; }
    public bool IsActive { get; set; }
}

    public async Task<LoginResponse> LoginAsync(LoginRequest req, string? ip, string? agent,
                                                CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);

        // fn_auth_lookup is SECURITY DEFINER, owned by fcms_auth. Login is the
        // one request that runs before a tenant is known, so it cannot be
        // filtered by tenant and therefore cannot run under RLS. That function
        // is deliberately the narrowest possible hole: it returns credential
        // fields for one employee number and can read nothing else.
        var row = await conn.QuerySingleOrDefaultAsync<AuthRow>(new CommandDefinition(
            """
            SELECT staff_id AS StaffId, tenant_id AS TenantId, site_id AS SiteId,
                   full_name AS FullName, role::text AS Role,
                   password_hash AS PasswordHash, must_change AS MustChange,
                   failed_logins AS FailedLogins, locked_until AS LockedUntil,
                   is_active AS IsActive
              FROM fn_auth_lookup(@employeeNo)
            """,
            new { employeeNo = req.EmployeeNo },
            transaction: _uow.Transaction, cancellationToken: ct));

        // One message for "no such employee" and "wrong password". Telling them
        // apart lets anyone enumerate who works at the station.
        var invalid = new DomainException("INVALID_CREDENTIALS",
            "That employee number or password is not right.", 401);

        if (row is null || !row.IsActive)
        {
            // The REPLY stays vague on purpose. The LOG does not: an account
            // that has never been given a password looks exactly like a typo
            // otherwise, and that is what a freshly seeded database is.
            var why = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
                "SELECT fn_auth_diagnose(@employeeNo)",
                new { employeeNo = req.EmployeeNo },
                transaction: _uow.Transaction, cancellationToken: ct));
            _log.LogInformation("Login failed for {EmployeeNo}: {Why}", req.EmployeeNo, why);
            throw invalid;
        }

        if (row.LockedUntil is { } until && until > DateTime.UtcNow)
            throw new DomainException("ACCOUNT_LOCKED",
                $"Too many failed attempts. Try again after {DateTime.SpecifyKind(until, DateTimeKind.Utc).ToLocalTime():HH:mm}, "
                + "or ask a manager to reset it.", 423);

        bool ok;
        try
        {
            ok = BCrypt.Net.BCrypt.Verify(req.Password, row.PasswordHash);
        }
        catch (BCrypt.Net.SaltParseException)
        {
            // The stored hash is not a bcrypt hash at all. That is a setup
            // fault, not a wrong password, and it must not surface as a 500 --
            // an unhandled exception here tells an attacker the account exists
            // and tells the operator nothing useful.
            _log.LogError("Stored password hash for {EmployeeNo} is malformed. "
                        + "Reset it with: dotnet run -- --set-password {EmployeeNo} '<password>'",
                          req.EmployeeNo, req.EmployeeNo);
            throw new DomainException("CREDENTIAL_CORRUPT",
                "This account's password needs to be reset before you can sign in. "
                + "Ask an administrator.", 409);
        }

        if (!ok)
        {
            // Recorded through a SECURITY DEFINER function so the lockout
            // counter increments even though no tenant context is set yet.
            await conn.ExecuteAsync(new CommandDefinition(
                "SELECT fn_auth_record_attempt(@id, false)", new { id = row.StaffId },
                transaction: _uow.Transaction, cancellationToken: ct));
            throw invalid;
        }

        await conn.ExecuteAsync(new CommandDefinition(
            "SELECT fn_auth_record_attempt(@id, true)", new { id = row.StaffId },
            transaction: _uow.Transaction, cancellationToken: ct));

        // The tenant is known from here on, so the rest of this request runs
        // under the same isolation as every other request. Without this the
        // session insert below is refused by the staff_session policy -- which
        // is RLS working correctly, on a request that had simply never told it
        // who it was.
        await _uow.SetTenantContextAsync(row.TenantId, row.StaffId, ct);

        var hours = _cfg.GetValue("Auth:SessionHours", 12);
        var expires = DateTime.UtcNow.AddHours(hours);   // Kind = Utc

        var sessionId = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
            """
            INSERT INTO staff_session (tenant_id, staff_id, expires_at, ip_address, user_agent)
            VALUES (@tenant, @staff, @expires, @ip::inet, @agent)
            RETURNING id
            """,
            new { tenant = row.TenantId, staff = row.StaffId, expires, ip, agent },
            transaction: _uow.Transaction, cancellationToken: ct));

        return new LoginResponse(
            IssueToken(row, sessionId, expires), expires, row.StaffId, row.FullName,
            row.Role, row.SiteId ?? Guid.Empty, row.MustChange,
            RolePermissions.For(row.Role).ToArray());
    }

    private string IssueToken(AuthRow row, Guid sessionId, DateTime expires)
    {
        var secret = _cfg["Auth:SigningKey"]
            ?? throw new InvalidOperationException(
                "Auth:SigningKey is not configured. Set it via environment or a secret "
                + "store — the API will not start with a built-in default, because a "
                + "default signing key in source is a signing key everyone has.");

        if (secret.Length < 32)
            throw new InvalidOperationException("Auth:SigningKey must be at least 32 characters.");

        var creds = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
            SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: _cfg["Auth:Issuer"] ?? "fcms",
            audience: _cfg["Auth:Audience"] ?? "fcms",
            claims: new[]
            {
                new Claim("staff_id",   row.StaffId.ToString()),
                new Claim("tenant_id",  row.TenantId.ToString()),
                new Claim("site_id",    (row.SiteId ?? Guid.Empty).ToString()),
                new Claim("session_id", sessionId.ToString()),
                new Claim("role",       row.Role),
                new Claim("name",       row.FullName),
            },
            expires: expires,
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public async Task ChangePasswordAsync(ChangePasswordRequest req, CancellationToken ct)
    {
        if (req.NewPassword.Length < 10)
            throw new DomainException("WEAK_PASSWORD",
                "Use at least 10 characters.");

        var conn = await _uow.ConnectionAsync(ct);
        var hash = await conn.ExecuteScalarAsync<string>(new CommandDefinition(
            "SELECT password_hash FROM staff_credential WHERE staff_id = @id",
            new { id = _user.StaffId },
            transaction: _uow.Transaction, cancellationToken: ct));

        if (hash is null || !BCrypt.Net.BCrypt.Verify(req.CurrentPassword, hash))
            // 422, not 401: the person IS signed in; only the old password was wrong.
            throw new DomainException("INVALID_CREDENTIALS", "Your current password is not right.", 422);

        await conn.ExecuteAsync(new CommandDefinition(
            """
            UPDATE staff_credential
               SET password_hash = @hash, must_change = false, password_set_at = now()
             WHERE staff_id = @id
            """,
            new { id = _user.StaffId, hash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword, 12) },
            transaction: _uow.Transaction, cancellationToken: ct));

        // Every other session for this person dies. If the password was changed
        // because it leaked, leaving the old sessions alive defeats the change.
        await conn.ExecuteAsync(new CommandDefinition(
            """
            UPDATE staff_session
               SET revoked_at = now(), revoke_reason = 'Password changed'
             WHERE staff_id = @id AND id <> @session AND revoked_at IS NULL
            """,
            new { id = _user.StaffId, session = _user.SessionId },
            transaction: _uow.Transaction, cancellationToken: ct));
    }

    public async Task LogoutAsync(CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE staff_session SET revoked_at = now(), revoke_reason = 'Signed out' " +
            " WHERE id = @id AND revoked_at IS NULL",
            new { id = _user.SessionId },
            transaction: _uow.Transaction, cancellationToken: ct));
    }
}

public static class AuthEndpoints
{
    public static void MapAuth(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth");

        g.MapPost("/login", async (LoginRequest req, AuthService svc, HttpContext ctx,
                                   CancellationToken ct) =>
            Results.Ok(await svc.LoginAsync(req,
                ctx.Connection.RemoteIpAddress?.ToString(),
                ctx.Request.Headers.UserAgent.ToString(), ct)))
         .RequireRateLimiting("login");

        g.MapPost("/change-password", async (ChangePasswordRequest req, AuthService svc,
                                             CancellationToken ct) =>
        {
            await svc.ChangePasswordAsync(req, ct);
            return Results.Ok(new { changed = true });
        }).RequireAuthorization()
          // Guessing the current password from an open session is guessing a
          // password: limited like sign-in.
          .RequireRateLimiting("login");

        g.MapPost("/logout", async (AuthService svc, CancellationToken ct) =>
        {
            await svc.LogoutAsync(ct);
            return Results.Ok(new { signedOut = true });
        }).RequireAuthorization();

        g.MapGet("/me", (ICurrentUser u) => u.IsAuthenticated
            ? Results.Ok(new
            {
                staffId = u.StaffId, name = u.FullName, role = u.Role,
                siteId = u.SiteId, permissions = RolePermissions.For(u.Role)
            })
            : Results.Unauthorized()).RequireAuthorization();
    }
}
