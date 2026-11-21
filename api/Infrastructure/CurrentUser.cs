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
/// integrity suite asserts the two agree, so drift is caught by a test rather
/// than by a supervisor who cannot close a shift.
///
/// ATTENDANT appears nowhere. Attendants do not sign in, so they hold no
/// permissions at all.
/// </summary>
public static class RolePermissions
{
    private static readonly Dictionary<string, HashSet<string>> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        ["SUPERVISOR"] = new(StringComparer.OrdinalIgnoreCase)
        {
            // The forecourt. Everything between the canopy and the office.
            "shift.open", "shift.close", "assignment.manage",
            "reading.record", "dip.record", "pump_test.record",
            "cashup.declare", "credit_sale.record",
            "delivery.receive", "dry_sale.record",
            // Counting the shelf and receiving what filled it is ordinary
            // forecourt work. Needing a manager for it means fetching one on a
            // Tuesday afternoon.
            "dry_stock.manage", "stock_count.conduct",
            // Answering an exception the system raised on their own shift.
            "exception.resolve",
        },
        ["MANAGER"] = new(StringComparer.OrdinalIgnoreCase)
        {
            // A MANAGER IS A SUPERVISOR AND MORE.
            //
            // They cover a shift when a supervisor is away, and a system that
            // will not let them is a system that gets shared passwords. So
            // every forecourt permission is repeated here deliberately, and
            // 200_supervisor_manager.sql enforces the relationship in the
            // database so the two cannot drift apart.
            "shift.open", "shift.close", "assignment.manage",
            "reading.record", "dip.record", "pump_test.record",
            "cashup.declare", "credit_sale.record",
            "delivery.receive", "dry_sale.record",
            "dry_stock.manage", "stock_count.conduct", "exception.resolve",

            // Oversight: signing off work somebody else did. The segregation
            // constraint still refuses an approval by whoever closed the
            // shift, so covering a shift does not let them sign off their own.
            "shift.approve", "cashup.approve", "delivery.approve",
            "shortage.approve", "stock_count.approve",

            // Overall sight. A manager who cannot open a report manages from a
            // week-old spreadsheet somebody else printed.
            "report.view",

            // Taking the cash to the bank. This is the job.
            "banking.record",

            // The customer side, which at a station is most of marketing.
            "credit_customer.manage", "credit_payment.record",

            // Setting the price and authorising a discount.
            "price.execute", "discount.authorise",
        },
        ["ACCOUNTANT"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "shift.approve", "cashup.approve", "banking.record",
            "credit_payment.record", "shortage.approve", "shortage.write_off",
            "stock_count.approve", "stock_count.post", "report.view",
            "exception.resolve"
        },
        ["AUDITOR"] = new(StringComparer.OrdinalIgnoreCase) { "report.view", "audit.view" },

        // A director owns the business: reads everything, signs off the big
        // numbers, never touches a forecourt screen. Deliberately distinct from
        // ADMIN, which is configuration and has no business seeing money.
        ["DIRECTOR"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "report.view", "audit.view", "shift.approve", "cashup.approve",
            "shortage.approve", "shortage.write_off", "stock_count.approve",
            "price.execute", "discount.authorise", "credit_customer.manage",
            "exception.resolve"
        },
        ["ADMIN"] = new(StringComparer.OrdinalIgnoreCase)
        {
            "staff.manage", "equipment.manage", "site.configure", "policy.configure",
            "payment_channel.manage", "session.revoke", "report.view"
        }
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
