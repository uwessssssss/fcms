using System.Security.Claims;

namespace Fcms.Api.Infrastructure;

/// <summary>
/// Who is making this request. Read from claims, never from a query string or
/// a request body — v1 had endpoints that took stationId as a parameter and
/// trusted it.
/// </summary>
public interface ICurrentUser
{
    bool IsAuthenticated { get; }
    Guid TenantId { get; }
    Guid StaffId { get; }
    Guid SiteId { get; }
    Guid SessionId { get; }
    string Role { get; }
    string FullName { get; }
    bool Can(string permission);
}

public sealed class CurrentUser : ICurrentUser
{
    private readonly ClaimsPrincipal? _principal;

    public CurrentUser(IHttpContextAccessor accessor) => _principal = accessor.HttpContext?.User;

    public bool IsAuthenticated => _principal?.Identity?.IsAuthenticated == true;
    public Guid TenantId  => Guid.TryParse(Claim("tenant_id"),  out var g) ? g : Guid.Empty;
    public Guid StaffId   => Guid.TryParse(Claim("staff_id"),   out var g) ? g : Guid.Empty;
    public Guid SiteId    => Guid.TryParse(Claim("site_id"),    out var g) ? g : Guid.Empty;
    public Guid SessionId => Guid.TryParse(Claim("session_id"), out var g) ? g : Guid.Empty;
    public string FullName => Claim("name") ?? "";

    /// <summary>
    /// No fallback role. v1 defaulted a missing role claim to Attendant, which
    /// sounds fail-safe but made a claim-MAPPING bug look identical to a
    /// permissions bug: administrators arrived with no rights and the cause
    /// took days to find. An absent role is now an empty string that matches no
    /// permission, and the request is refused with a message that says so.
    /// </summary>
    public string Role => Claim("role") ?? "";

    /// <summary>True for the unrestricted role. See RolePermissions.Grants.</summary>
    public bool IsSystemAdmin =>
        string.Equals(Role, RolePermissions.Unrestricted, StringComparison.OrdinalIgnoreCase);

    public bool Can(string permission) =>
        RolePermissions.Grants(Role, permission);

    private string? Claim(string type) => _principal?.FindFirst(type)?.Value;
}

/// <summary>
/// A mirror of the role_permission table.
///
/// Duplicating it here is a considered trade: the database is the source of
/// truth and enforces what it can, but an authorisation check that needs a
/// round trip on every request is a check people eventually cache badly. The
/// two must agree, and tools/dbrun/permissions.py checks that they do (CI and
/// check-all), so drift is caught by a test rather than by a supervisor who
/// cannot close a shift. (This comment once claimed such a test; none existed,
/// and HEAD_OFFICE was missing here -- head office was refused almost every
/// screen until the first full-stack run found it. Nov 2026.) The map below is
/// generated: python3 tools/dbrun/permissions.py DB --write.
///
/// ATTENDANT appears nowhere. Attendants do not sign in, so they hold no
/// permissions at all.
/// </summary>
public static class RolePermissions
{
    private static readonly Dictionary<string, HashSet<string>> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        // Generated from role_permission by tools/dbrun/permissions.py --write;
        // CI fails if the two differ.
        ["ACCOUNTANT"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "banking.record", "cashup.approve", "credit_payment.record", "exception.resolve",
            "report.view", "shortage.approve", "shortage.write_off", "stock_count.approve",
            "stock_count.post"
        },
        ["ADMIN"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "equipment.manage", "payment_channel.manage", "policy.configure", "report.view",
            "session.revoke", "site.configure", "staff.manage"
        },
        ["AUDITOR"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "audit.view", "report.view"
        },
        ["DIRECTOR"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "audit.view", "cashup.approve", "credit_customer.manage", "discount.authorise",
            "exception.resolve", "price.execute", "report.view", "shortage.approve",
            "shortage.write_off", "stock_count.approve"
        },
        ["HEAD_OFFICE"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "assignment.manage", "banking.record", "cashup.approve", "cashup.declare",
            "credit_customer.manage", "credit_payment.record", "credit_sale.record",
            "delivery.approve", "delivery.receive", "dip.record", "discount.authorise",
            "dry_sale.record", "dry_stock.manage", "equipment.manage", "exception.resolve",
            "policy.configure", "price.execute", "pump_test.record", "reading.record",
            "report.view", "session.revoke", "shift.approve", "shift.close", "shift.open",
            "shortage.approve", "staff.manage", "stock_count.approve", "stock_count.conduct"
        },
        ["MANAGER"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "assignment.manage", "banking.record", "cashup.approve", "cashup.declare",
            "credit_customer.manage", "credit_payment.record", "credit_sale.record",
            "delivery.approve", "delivery.receive", "dip.record", "discount.authorise",
            "dry_sale.record", "dry_stock.manage", "exception.resolve", "price.execute",
            "pump_test.record", "reading.record", "report.view", "shift.approve",
            "shift.close", "shift.open", "shortage.approve", "staff.manage",
            "stock_count.approve", "stock_count.conduct"
        },
        ["SUPERVISOR"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "assignment.manage", "cashup.declare", "credit_sale.record", "delivery.receive",
            "dip.record", "dry_sale.record", "dry_stock.manage", "exception.resolve",
            "pump_test.record", "reading.record", "shift.close", "shift.open",
            "stock_count.conduct"
        },
    };

    /// <summary>
    /// SYSTEM_ADMIN is a wildcard, not an entry in the map above.
    ///
    /// A copied list of every permission would fall behind the day somebody
    /// adds one and forgets this file, and "can do everything" would quietly
    /// become "could do everything as of last March".
    ///
    /// This bypasses PERMISSIONS only. It does not bypass the append-only rules
    /// on the ledgers, the segregation constraint on shift approval, or the
    /// refusal to close on an unexplained variance. Those live in the database,
    /// apply to every connection equally, and are the properties that make the
    /// numbers mean anything -- an administrator who needs to change a posted
    /// figure writes a reversal with a reason, exactly like anyone else.
    /// </summary>
    public const string Unrestricted = "SYSTEM_ADMIN";

    public static bool Grants(string role, string permission) =>
        !string.IsNullOrEmpty(role)
        && (string.Equals(role, Unrestricted, StringComparison.OrdinalIgnoreCase)
            || (Map.TryGetValue(role, out var set) && set.Contains(permission)));

    /// <summary>
    /// Every permission a role holds, for the client to build its navigation
    /// from. The unrestricted role is a wildcard in Grants() rather than an
    /// entry in the map, so it would report NOTHING here -- and a system
    /// administrator would be shown a menu with nothing on it.
    /// </summary>
    public static IReadOnlyCollection<string> For(string role)
    {
        if (string.Equals(role, Unrestricted, StringComparison.OrdinalIgnoreCase))
            return Map.Values.SelectMany(v => v).Distinct().ToArray();

        return Map.TryGetValue(role ?? "", out var set) ? set : Array.Empty<string>();
    }

    /// <summary>Every permission this file knows about, for the drift test.</summary>
    public static IEnumerable<(string Role, string Permission)> All() =>
        Map.SelectMany(kv => kv.Value.Select(p => (kv.Key, p)));
}
