using System.Text;
using System.Threading.RateLimiting;
using Fcms.Api.Features.Accounts;
using Fcms.Api.Features.Admin;
using Fcms.Api.Features.Auth;
using Fcms.Api.Features.Catalogue;
using Fcms.Api.Features.Credit;
using Fcms.Api.Features.Deliveries;
using Fcms.Api.Features.Depot;
using Fcms.Api.Features.DryStock;
using Fcms.Api.Features.Forecourt;
using Fcms.Api.Features.Operations;
using Fcms.Api.Features.Organisation;
using Fcms.Api.Features.Reports;
using Fcms.Api.Features.Setup;
using Fcms.Api.Features.Shifts;
using Fcms.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

// ---------------------------------------------------------------------------
// Load .env from the project directory, before anything reads configuration.
//
// Requiring `set -a; source .env; set +a` in every terminal was a bad design:
// environment variables live only in the shell that set them, so opening a
// second terminal - or closing and reopening one - silently loses the database
// connection and the API dies with "No database connection string".
//
// Reading the file directly makes `dotnet run` work from anywhere, every time.
// Real environment variables still win, so containers and CI can override
// without editing files.
// ---------------------------------------------------------------------------
// Search order, widest net first: the working directory dotnet run was
// launched from, the project directory relative to the built assembly, and one
// level above each. Every path tried is remembered so a failure can say where
// it looked rather than leaving you to guess.
var envSearched = new List<string>();
string? envUsed = null;
var envKeys = new List<string>();

// If there is no .env but there is a template, create one. This has cost five
// separate debugging rounds - the file is deliberately not in the archive, so
// every fresh extraction loses it, and the failure it produces looks like a
// configuration bug rather than a missing copy step.
//
// The generated file gets a REAL random signing key rather than the template's
// placeholder, so first run is also more secure than following the README.
// An existing .env is never touched.
{
    var here = Directory.GetCurrentDirectory();
    var envFile = Path.Combine(here, ".env");
    var template = Path.Combine(here, ".env.example");

    if (!File.Exists(envFile) && File.Exists(template))
    {
        var key = Convert.ToBase64String(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(48));

        var lines = File.ReadAllLines(template)
            .Select(l => l.TrimStart().StartsWith("Auth__SigningKey")
                ? $"Auth__SigningKey=\"{key}\""
                : l)
            .ToArray();

        File.WriteAllLines(envFile, lines);
        Console.WriteLine($"  Created {envFile} from .env.example, with a fresh signing key.");
        Console.WriteLine("  Check the port and password in it match your database.");
    }
}

foreach (var candidate in new[]
{
    Path.Combine(Directory.GetCurrentDirectory(), ".env"),
    Path.Combine(Directory.GetCurrentDirectory(), "..", ".env"),
    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".env")),
    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".env")),
})
{
    var full = Path.GetFullPath(candidate);
    if (envSearched.Contains(full)) continue;
    envSearched.Add(full);
    if (!File.Exists(full)) continue;

    foreach (var raw in File.ReadAllLines(full))
    {
        var line = raw.Trim();
        if (line.Length == 0 || line.StartsWith('#')) continue;

        var eq = line.IndexOf('=');
        if (eq <= 0) continue;

        var key = line[..eq].Trim();
        var value = line[(eq + 1)..].Trim().Trim('"', '\'');

        envKeys.Add(key);
        // An actual environment variable always wins over the file.
        if (Environment.GetEnvironmentVariable(key) is null)
            Environment.SetEnvironmentVariable(key, value);
    }
    envUsed = full;
    break;
}

// ---------------------------------------------------------------------------
// Password tooling.
//
// The seed deliberately ships NO credential rows. A hash written by hand into a
// SQL file is a hash nobody has verified, and the failure it produces --
// BCrypt.Net.SaltParseException: Invalid salt version -- looks like a bug in
// the application rather than a bad literal in a fixture.
//
//   dotnet run -- --hash 'ChangeMe123!'
//   dotnet run -- --set-password ALL 'ChangeMe123!'
//   dotnet run -- --set-password SUP01 'somethingelse'
// ---------------------------------------------------------------------------
if (args.Length >= 1 && args[0].StartsWith("--"))
{
    var stamp = File.GetLastWriteTime(
        System.Reflection.Assembly.GetExecutingAssembly().Location);
    Console.WriteLine($"  FCMS API, built {stamp:yyyy-MM-dd HH:mm}");
}

if (args.Length == 2 && args[0] == "--hash")
{
    Console.WriteLine(BCrypt.Net.BCrypt.HashPassword(args[1], 12));
    return;
}

if (args.Length == 3 && args[0] == "--set-password")
{
    var who = args[1];
    var hash = BCrypt.Net.BCrypt.HashPassword(args[2], 12);

    var cs = Environment.GetEnvironmentVariable("FCMS_DB");
    if (string.IsNullOrWhiteSpace(cs))
    {
        ReportMissingConnectionString();
        return;
    }

    await using var setup = new NpgsqlConnection(cs);
    await setup.OpenAsync();

    // Through fn_set_password, not raw SQL. The tool connects as fcms_app with
    // no tenant context - nobody has signed in yet - so RLS hides every staff
    // row and a direct statement silently matches nothing.
    await using var cmd = setup.CreateCommand();
    cmd.CommandText = "SELECT fn_set_password($1, $2)";
    cmd.Parameters.AddWithValue(who);
    cmd.Parameters.AddWithValue(hash);

    // Say WHICH database, and what is actually in it.
    //
    // "The database is reachable but has no schema" was the old advice when
    // this call failed, and it can be wrong: a missing function is not the same
    // as a missing schema, and the two need different fixes. Worse, a fresh
    // .env points wherever .env.example pointed -- so the API may be talking to
    // a perfectly healthy server that is not the one the migrations ran
    // against, and no amount of re-running them would help.
    await using (var probe = setup.CreateCommand())
    {
        probe.CommandText =
            "SELECT current_database() || ' on ' || inet_server_port() "
            + "|| ' as ' || current_user "
            + "|| ' | tables=' || (SELECT count(*) FROM information_schema.tables "
            + "                    WHERE table_schema = 'public') "
            + "|| ' | migrations=' || COALESCE((SELECT count(*)::text FROM "
            + "     information_schema.tables WHERE table_name = 'schema_migration'), '0')";
        Console.WriteLine($"  Connected to: {await probe.ExecuteScalarAsync()}");
    }

    var n = Convert.ToInt32(await cmd.ExecuteScalarAsync());
    Console.WriteLine(n == 0
        ? $"  No active operator matched '{who}'. Attendants have no sign-in, by design."
        : $"  Password set for {n} operator(s). They will be asked to change it at first login.");
    return;
}

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
// Configuration. Secrets come from environment or a secret store, never from a
// checked-in file. v1 shipped its database password and JWT signing key in
// appsettings.json, which means both are in the git history permanently.
// ---------------------------------------------------------------------------
var connectionString = builder.Configuration.GetConnectionString("Fcms")
    ?? Environment.GetEnvironmentVariable("FCMS_DB");

if (string.IsNullOrWhiteSpace(connectionString))
{
    ReportMissingConnectionString();
    return;
}


var signingKey = builder.Configuration["Auth:SigningKey"]
    ?? throw new InvalidOperationException(
        "Auth:SigningKey is not set. There is deliberately no default: a signing "
        + "key baked into source is a signing key every deployment shares.");

// HS256 needs a key of at least 256 bits. A shorter one is accepted here and
// then throws on the FIRST sign-in (IDX10720), which looks like a login bug. The
// placeholder in .env.example is shorter than that, on purpose: it must fail.
if (Encoding.UTF8.GetByteCount(signingKey) < 32)
    throw new InvalidOperationException(
        "Auth:SigningKey is too short: it needs at least 32 characters. "
        + "Generate one with:  openssl rand -base64 48");

Fcms.Api.Infrastructure.ErrorMiddleware.ShowDatabaseDetail =
    builder.Configuration.GetValue("Errors:ShowDatabaseDetail", false);

// ---------------------------------------------------------------------------
// Data source. One per process, with the schema's enums mapped once so they
// round-trip as strongly-typed values rather than strings.
// ---------------------------------------------------------------------------
var dataSourceBuilder = new NpgsqlDataSourceBuilder(connectionString);

// Npgsql's DEFAULT name translator is snake_case, which would map the C# member
// OPEN to the Postgres label "open". Every label in this schema is UPPERCASE,
// so the default silently produces a mismatch that only surfaces at runtime,
// on the first query that touches an enum — i.e. the first time anyone opens a
// shift. Passing an identity translator keeps the two sides literal.
var asWritten = new IdentityNameTranslator();

dataSourceBuilder.MapEnum<ShiftState>("shift_state", asWritten);
dataSourceBuilder.MapEnum<CloseReasonEnum>("close_reason", asWritten);
dataSourceBuilder.MapEnum<MovementKind>("movement_kind", asWritten);
dataSourceBuilder.MapEnum<DispositionKind>("disposition_kind", asWritten);
dataSourceBuilder.MapEnum<SettlementKind>("settlement_kind", asWritten);
dataSourceBuilder.MapEnum<ReadingSource>("reading_source", asWritten);
dataSourceBuilder.MapEnum<DipContext>("dip_context", asWritten);
dataSourceBuilder.MapEnum<EvidenceState>("evidence_state", asWritten);
dataSourceBuilder.MapEnum<Severity>("severity", asWritten);
dataSourceBuilder.MapEnum<StaffRole>("staff_role", asWritten);
dataSourceBuilder.MapEnum<DryMovementKind>("dry_movement_kind", asWritten);
builder.Services.AddSingleton(dataSourceBuilder.Build());

// Dapper does not bridge DateOnly/TimeOnly to Npgsql's DateTime/TimeSpan.
// Register before anything queries, or the first business date fails with
// "Invalid cast from 'System.DateTime' to 'System.DateOnly'".
Dapper.SqlMapper.AddTypeHandler(new DateOnlyTypeHandler());
Dapper.SqlMapper.AddTypeHandler(new NullableDateOnlyTypeHandler());
Dapper.SqlMapper.AddTypeHandler(new TimeOnlyTypeHandler());

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();
builder.Services.AddScoped<IUnitOfWork, UnitOfWork>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<ShiftService>();
builder.Services.AddScoped<ShiftActivityService>();
builder.Services.AddScoped<CashDropService>();
builder.Services.AddScoped<CustomerPriceService>();
builder.Services.AddScoped<BooksService>();
builder.Services.AddScoped<MoneyAccountService>();
builder.Services.AddScoped<CreditService>();
builder.Services.AddScoped<ForecourtService>();
builder.Services.AddScoped<DeliveryService>();
builder.Services.AddScoped<DryStockService>();
builder.Services.AddScoped<SetupService>();
builder.Services.AddScoped<OperationsService>();
builder.Services.AddScoped<ReportsService>();
builder.Services.AddScoped<StockLossService>();
builder.Services.AddScoped<AdminService>();
builder.Services.AddScoped<AccountsService>();
builder.Services.AddScoped<DepotService>();
builder.Services.AddScoped<DirectorsService>();
builder.Services.AddScoped<StatementService>();
builder.Services.AddScoped<DashboardService>();
builder.Services.AddScoped<TankInventoryService>();
builder.Services.AddScoped<AnalyticsService>();
builder.Services.AddScoped<OrganisationService>();
builder.Services.AddScoped<CatalogueService>();
builder.Services.AddScoped<ShiftClosureService>();

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        // JwtSecurityTokenHandler rewrites inbound claim names by default:
        // "role" becomes a schema URI, "name" likewise. FindFirst("role") then
        // returns null, ICurrentUser.Role is empty, and every request is
        // refused with "A  cannot do that." - a permissions message with a
        // hole where the role should be.
        //
        // Turning the mapping off means the claims arrive named as they were
        // issued, which is the only sane contract between two halves of the
        // same codebase.
        o.MapInboundClaims = false;

        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Auth:Issuer"] ?? "fcms",
            ValidAudience = builder.Configuration["Auth:Audience"] ?? "fcms",
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
            // No tolerance for clock skew beyond a minute. Station tablets drift,
            // but a token that outlives its expiry by five minutes is five minutes
            // a revoked session keeps working.
            ClockSkew = TimeSpan.FromMinutes(1),
            RoleClaimType = "role",
            NameClaimType = "name"
        };
    });
builder.Services.AddAuthorization();

// Login is the one endpoint an attacker can call without credentials, so it is
// the one that needs a limit. v1 had failed_logins and locked_until columns and
// nothing ever wrote to them.
builder.Services.AddRateLimiter(o =>
{
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(5),
            QueueLimit = 0
        }));
    o.RejectionStatusCode = 429;
});

// CORS.
//
// The configured list is exact, which is right for a deployed station. In
// DEVELOPMENT it also accepts any localhost port, because Next silently starts
// on 3001 when 3000 is taken and the only symptom is every request failing
// with a network error that names nothing -- the browser refuses the response
// before any of our code sees it.
//
// That cost an evening once. It should not cost another.
// ---------------------------------------------------------------------------
// Swagger.
//
// Worth more here than on a typical API, because this one REFUSES things on
// purpose -- an unbalanced cash-up, a dip above a tank's capacity, a second
// manager who turns out to be the same person. Those refusals are the product,
// not error handling, so the documented responses list them and a reader can
// see what the system will not let them do before they write a line.
// ---------------------------------------------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new()
    {
        Title = "FCMS — Forecourt Control",
        Version = "v1",
        Description =
            "Fuel station control: shifts, wet stock, cash-up, credit and the "
            + "statements behind them.\n\n"
            + "**Sign in with an employee number, not an email.** Attendants "
            + "have no sign-in at all by design — they are subjects of the "
            + "record, not authors of it, and the schema enforces that with a "
            + "composite key rather than a convention.\n\n"
            + "A 422 is a refusal the system meant to make. It carries a code "
            + "and a sentence written for the person reading it; show that "
            + "sentence rather than replacing it with one of your own.",
    });

    c.AddSecurityDefinition("bearer", new()
    {
        Type = Microsoft.OpenApi.Models.SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        Description = "The token from POST /api/auth/login.",
    });

    c.AddSecurityRequirement(new()
    {
        {
            new Microsoft.OpenApi.Models.OpenApiSecurityScheme
            {
                Reference = new Microsoft.OpenApi.Models.OpenApiReference
                {
                    Type = Microsoft.OpenApi.Models.ReferenceType.SecurityScheme,
                    Id = "bearer",
                },
            },
            Array.Empty<string>()
        },
    });

    var xml = Path.Combine(AppContext.BaseDirectory, "Fcms.Api.xml");
    if (File.Exists(xml)) c.IncludeXmlComments(xml);
});

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .SetIsOriginAllowed(origin =>
    {
        var configured = builder.Configuration.GetSection("Cors:Origins").Get<string[]>()
                         ?? new[] { "http://localhost:3000" };
        if (configured.Contains(origin, StringComparer.OrdinalIgnoreCase))
            return true;

        // Any localhost origin is accepted, in EVERY environment, and that is
        // deliberate rather than lax.
        //
        // An origin of "localhost" can only come from a browser running on this
        // same machine -- another computer cannot make its browser claim it.
        // So this widens nothing an attacker can reach; it only stops the case
        // where Next starts on 3001 because 3000 was taken and every request
        // then fails with a network error that names nothing.
        //
        // This was gated on IsDevelopment() first, which was worse than
        // useless: the API runs as Production unless ASPNETCORE_ENVIRONMENT is
        // set, so the gate would have been shut on exactly the machine that
        // needed it open.
        return Uri.TryCreate(origin, UriKind.Absolute, out var u)
               && (u.Host is "localhost" or "127.0.0.1" or "[::1]");
    })
    .AllowAnyHeader().AllowAnyMethod().AllowCredentials()
    // A response header is invisible to browser JavaScript unless it is
    // exposed. Without this the client reads X-Trace-Id as undefined on every
    // response, and the reference code a person is asked to quote is blank --
    // which is worse than not offering one.
    .WithExposedHeaders("X-Trace-Id")));

builder.Services.AddHealthChecks().AddNpgSql(connectionString);

var app = builder.Build();

// ---------------------------------------------------------------------------
// Middleware order. This sequence is load-bearing, so it is written out rather
// than left to be inferred:
//
//   1. Errors      outermost, so everything below produces a readable refusal
//   2. CORS        before auth, so a 401 still carries CORS headers
//   3. AuthN/AuthZ populates ICurrentUser
//   4. Session     the token is valid; is the session still live?
//   5. Idempotency needs the tenant, so it must follow auth
//   6. Transaction innermost: commits only if everything above succeeded
// ---------------------------------------------------------------------------
// Swagger is served in every environment on purpose. This runs on a station's
// own machine, not the public internet, and the person most likely to need the
// documentation is the one debugging at eleven at night.
app.UseSwagger();
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/swagger/v1/swagger.json", "FCMS v1");
    c.DocumentTitle = "FCMS API";
    c.DisplayRequestDuration();
});

// Behind a reverse proxy (deploy/: Caddy), every request arrives from the
// proxy's address, so the per-address sign-in limit would be ONE limit shared
// by every visitor. Proxy__TrustForwardedFor=true takes the client's address
// from X-Forwarded-For instead. Off by default: without a proxy in front, a
// client could write that header itself and dodge the limit. Turn it on only
// where the API is reachable through the proxy alone.
if (builder.Configuration.GetValue<bool>("Proxy:TrustForwardedFor"))
{
    var fwd = new Microsoft.AspNetCore.Builder.ForwardedHeadersOptions
    {
        ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor
                         | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto,
        ForwardLimit = 1,
    };
    fwd.KnownNetworks.Clear();
    fwd.KnownProxies.Clear();
    app.UseForwardedHeaders(fwd);
}

app.UseMiddleware<ErrorMiddleware>();
app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.UseMiddleware<SessionCheckMiddleware>();
// TRANSACTION OUTSIDE IDEMPOTENCY, and the order matters.
//
// Registered the other way round, the idempotency record was written AFTER the
// transaction had already committed -- and set_config('app.tenant_id', ..., true)
// is transaction-local, so app_tenant() was NULL and the insert died on
// "new row violates row-level security policy for table idempotency_record".
//
// It also broke the guarantee the record exists for: a key written outside the
// transaction survives work that rolled back, and then blocks the retry
// forever. The comment in IdempotencyMiddleware claimed the record was written
// in the same transaction as the work. This registration is what makes that
// true.
app.UseMiddleware<TransactionMiddleware>();
app.UseMiddleware<IdempotencyMiddleware>();

// ---------------------------------------------------------------------------
// Prove the database is reachable BEFORE serving anything.
//
// Without this, a wrong password or port surfaces as a 500 on the first login
// attempt, buried in a forty-line Npgsql stack trace. On a forecourt at six in
// the morning that is indistinguishable from "the system is broken". Fail at
// boot, say exactly what is wrong, and say how to fix it.
// ---------------------------------------------------------------------------
await using (var probe = app.Services.GetRequiredService<NpgsqlDataSource>()
                            .CreateConnection())
{
    try
    {
        await probe.OpenAsync();

        await using var check = probe.CreateCommand();
        check.CommandText =
            "SELECT count(*) FROM information_schema.tables " +
            " WHERE table_schema = 'public' AND table_name = 'shift'";
        var migrated = Convert.ToInt32(await check.ExecuteScalarAsync()) == 1;

        if (!migrated)
        {
            Console.Error.WriteLine(
                "\n  The database is reachable but has no schema.\n" +
                "  Run the migrations first:  cd ../db && ./migrate.sh test\n");
            return;
        }

        // Print when this binary was built. Two separate debugging sessions
        // have now been spent on a stale build behaving like a bug that was
        // already fixed; a timestamp on startup makes that obvious in one
        // glance instead of three round trips.
        var built = File.GetLastWriteTime(
            System.Reflection.Assembly.GetExecutingAssembly().Location);
        Console.WriteLine($"  FCMS API, built {built:yyyy-MM-dd HH:mm}");
        Console.WriteLine($"  Database OK: {probe.Host}:{probe.Port}/{probe.Database} " +
                          $"as {probe.UserName}");

        // Nobody can sign in without a credential row. Say so at boot, where it
        // is actionable, rather than letting it surface as a failed login.
        await using var pw = probe.CreateCommand();
        pw.CommandText = "SELECT fn_operators_without_password()";
        var noPassword = Convert.ToInt32(await pw.ExecuteScalarAsync());
        if (noPassword > 0)
        {
            Console.WriteLine(
                $"  {noPassword} operator(s) have no password yet. Set one with:\n" +
                "      dotnet run -- --set-password ALL 'ChangeMe123!'");
        }
    }
    catch (PostgresException ex) when (ex.SqlState == "28P01")
    {
        Console.Error.WriteLine(
            $"\n  Password rejected for user '{new NpgsqlConnectionStringBuilder(connectionString).Username}'.\n" +
            "\n  The migrations create the fcms_app role WITHOUT a password. Set one" +
            "\n  that matches FCMS_DB in your .env:\n" +
            "\n      psql -d fcms -c \"ALTER ROLE fcms_app WITH PASSWORD 'your_password';\"\n");
        return;
    }
    catch (PostgresException ex) when (ex.SqlState == "3D000")
    {
        Console.Error.WriteLine(
            "\n  That database does not exist. Create it:  createdb fcms\n");
        return;
    }
    catch (Exception ex)
    {
        var b = new NpgsqlConnectionStringBuilder(connectionString);
        Console.Error.WriteLine(
            $"\n  Cannot reach Postgres at {b.Host}:{b.Port}.\n" +
            $"  {ex.Message}\n" +
            "\n  Check the port in FCMS_DB matches your server. If you are using the" +
            "\n  setup in START-HERE.md it is 5544, not 5432.\n");
        return;
    }
}

app.MapHealthChecks("/health");
app.MapAuth();
app.MapShifts();
app.MapShiftActivity();
app.MapCashDrops();
app.MapCustomerPrices();
app.MapBooks();
app.MapMoneyAccounts();
app.MapCredit();
app.MapForecourt();
app.MapDeliveries();
app.MapDryStock();
app.MapSetup();
app.MapOperations();
app.MapReports();
app.MapStockLoss();
app.MapAdmin();
app.MapAccounts();
app.MapDepot();
app.MapDirectors();
app.MapStatements();
app.MapDashboard();
app.MapTankInventory();
app.MapAnalytics();
app.MapOrganisation();
app.MapCatalogue();
app.MapShiftClosure();

app.Run();

// ---------------------------------------------------------------------------
// One place that explains a missing connection string.
//
// "Set ConnectionStrings:Fcms or FCMS_DB" is true and useless. The question is
// always whether the .env file was found and what was in it, so answer that.
// ---------------------------------------------------------------------------
void ReportMissingConnectionString()
{
    Console.Error.WriteLine("\n  No database connection string.\n");

    if (envUsed is null)
    {
        Console.Error.WriteLine("  No .env file was found. Looked in:");
        foreach (var path in envSearched) Console.Error.WriteLine($"      {path}");
        Console.Error.WriteLine(
            "\n  Create one from the template, then set the port and password:\n" +
            "      cp .env.example .env\n");
    }
    else
    {
        Console.Error.WriteLine($"  Read {envUsed}");
        Console.Error.WriteLine(envKeys.Count == 0
            ? "  ...but it contained no KEY=VALUE lines."
            : $"  ...which set: {string.Join(", ", envKeys)}");
        Console.Error.WriteLine(
            "\n  It needs a line starting FCMS_DB= with no space before the '=':\n" +
            "      FCMS_DB=\"Host=localhost;Port=5544;Database=fcms;" +
            "Username=fcms_app;Password=change_this_now\"\n");
    }
}
