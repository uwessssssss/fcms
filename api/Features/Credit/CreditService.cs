using Dapper;
using Fcms.Api.Common;
using Fcms.Api.Infrastructure;
using Npgsql;

namespace Fcms.Api.Features.Credit;

// ---------------------------------------------------------------------------
// This is audit finding H1.
//
// v1 had the credit_sale table, and POST /api/credit/sales, and not one line of
// frontend that called it. The balance rule needs credit in the allocation, so
// every station that pumped on credit — which is essentially every commercial
// station in Uganda and Kenya — had an attendant short by exactly the credit
// value, every shift, with no way to declare it. The shift could never balance.
//
// The API and the screen are both built here.
// ---------------------------------------------------------------------------

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class CustomerView
{
    public Guid Id { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? ContactPhone { get; set; }
    public decimal CreditLimit { get; set; }
    public int PaymentTermsDays { get; set; }
    public decimal Balance { get; set; }
    public decimal Headroom { get; set; }
    public DateTime? OldestInvoice { get; set; }
    public bool IsActive { get; set; }
    /// <summary>The site that opened the account.</summary>
    public string SiteName { get; set; } = "";
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class CustomerLedgerRow
{
    public string Id { get; set; } = "";
    public Guid CustomerId { get; set; }
    public DateTime At { get; set; }
    public string Description { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal Amount { get; set; }
    /// <summary>purchase | payment</summary>
    public string Kind { get; set; } = "";
    public string Shift { get; set; } = "";
}

public record UpsertCustomer(string Code, string Name, string? ContactPhone,
    decimal CreditLimit, int PaymentTermsDays);


public record RecordCreditSale(Guid CustomerId, Guid? VehicleId, Guid AttendantId,
    Guid NozzleId, decimal Litres, string? VoucherNo, int? Odometer,
    string? SignedBy, string? EvidenceUrl);

/// <summary>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</summary>
public sealed class CreditSaleView
{
    public Guid Id { get; set; }
    public string CustomerName { get; set; } = "";
    public string? PlateNo { get; set; }
    public string AttendantName { get; set; } = "";
    public string ProductCode { get; set; } = "";
    public decimal Litres { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal Amount { get; set; }
    public string? VoucherNo { get; set; }
    public DateTime RecordedAt { get; set; }
}

public record RecordPayment(Guid CustomerId, decimal Amount, string Method,
    string? Reference, string? EvidenceUrl);


/// <summary>Everything needed to price and validate one credit sale.</summary>
/// <remarks>Dapper target: a class with settable properties, so Dapper
/// assigns column by column instead of matching a whole constructor.
/// See docs/DAPPER.md for why that matters.</remarks>
internal sealed class CreditSaleContext
{
    public Guid ProductId { get; set; }
    /// <summary>What the customer pays: their agreed price, else the pump's.</summary>
    public decimal UnitPrice { get; set; }
    /// <summary>The agreement in force for this customer and grade (600), if any.</summary>
    public Guid? CustomerPriceId { get; set; }
    public Guid SiteId { get; set; }
    public string CustomerName { get; set; } = "";
    public decimal Headroom { get; set; }
    public decimal Balance { get; set; }
}


/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class AgeingRow
{
    /// <summary>Paid beyond everything billed: money the customer has on account (450).</summary>
    public decimal UnappliedCredit { get; set; }
    public Guid CustomerId { get; set; }
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal CreditLimit { get; set; }
    public int PaymentTermsDays { get; set; }
    public decimal Balance { get; set; }
    public decimal Current30 { get; set; }
    public decimal Days31To60 { get; set; }
    public decimal Days61To90 { get; set; }
    public decimal Over90 { get; set; }
    public int? OldestDays { get; set; }
    public decimal PastTerms { get; set; }
    public decimal Headroom { get; set; }
    public bool IsActive { get; set; }
}

/// <summary>Dapper target: class with settable properties. See docs/DAPPER.md.</summary>
public sealed class StatementLineRow
{
    public DateTime At { get; set; }
    public string Kind { get; set; } = "";
    public string Reference { get; set; } = "";
    public string? Vehicle { get; set; }
    public decimal? Litres { get; set; }
    public decimal Debit { get; set; }
    public decimal Credit { get; set; }
    public decimal RunningBalance { get; set; }
}

public sealed class CreditService
{
    private readonly IUnitOfWork _uow;
    private readonly ICurrentUser _user;

    public CreditService(IUnitOfWork uow, ICurrentUser user) => (_uow, _user) = (uow, user);

    private static readonly HashSet<string> Methods =
        new(StringComparer.OrdinalIgnoreCase) { "CASH", "BANK", "MOBILE_MONEY", "CHEQUE", "CONTRA" };

    /// <summary>
    /// One customer's account, as a running list.
    ///
    /// Sales and payments in one sequence, because that is how a customer
    /// argues about a balance -- "I paid you on the 14th" only means something
    /// next to what was drawn on the 12th and the 15th. Two separate lists
    /// force whoever is on the phone to interleave them by eye.
    ///
    /// A payment is shown NEGATIVE. It reduces what is owed, and a statement
    /// where both columns are positive is one somebody has to read twice to
    /// know which way the money went.
    /// </summary>
    public async Task<IReadOnlyList<CustomerLedgerRow>> LedgerAsync(Guid customerId,
        CancellationToken ct)
    {
        Require("credit_customer.manage");
        var conn = await _uow.ConnectionAsync(ct);

        return (await conn.QueryAsync<CustomerLedgerRow>(new CommandDefinition(
            """
            SELECT 'S' || cs.id::text     AS Id,
                   cs.customer_id         AS CustomerId,
                   cs.recorded_at         AS At,
                   COALESCE('Voucher ' || cs.voucher_no, 'Fuel drawn') AS Description,
                   cs.litres              AS Litres,
                   cs.amount              AS Amount,
                   'purchase'             AS Kind,
                   COALESCE(sh.label::text, '') AS Shift
              FROM credit_sale cs
              LEFT JOIN shift sh ON sh.id = cs.shift_id
             WHERE cs.customer_id = @customerId

            UNION ALL

            SELECT 'P' || cp.id::text     AS Id,
                   cp.customer_id         AS CustomerId,
                   cp.received_at         AS At,
                   COALESCE(cp.method::text || ' ' || cp.reference,
                            cp.method::text) AS Description,
                   0                      AS Litres,
                   -cp.amount             AS Amount,
                   'payment'              AS Kind,
                   ''                     AS Shift
              FROM credit_payment cp
             WHERE cp.customer_id = @customerId

             ORDER BY 3 DESC
             LIMIT 200
            """,
            new { customerId },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<IReadOnlyList<CustomerView>> CustomersAsync(bool activeOnly,
                                                                  CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<CustomerView>(new CommandDefinition(
            """
            SELECT c.id, c.code, c.name, c.contact_phone AS ContactPhone,
                   c.credit_limit AS CreditLimit, c.payment_terms_days AS PaymentTermsDays,
                   COALESCE(a.balance, 0)  AS Balance,
                   COALESCE(a.headroom, c.credit_limit) AS Headroom,
                   a.oldest_invoice AS OldestInvoice, c.is_active AS IsActive,
                   COALESCE((SELECT name FROM site WHERE id = c.site_id), '') AS SiteName
              FROM credit_customer c
              LEFT JOIN v_credit_ageing a ON a.customer_id = c.id
             WHERE (@activeOnly = false OR c.is_active)
             ORDER BY c.name
            """,
            new { activeOnly }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> UpsertCustomerAsync(Guid? id, UpsertCustomer req, CancellationToken ct)
    {
        Require("credit_customer.manage");
        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            if (id is null)
                return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                    """
                    INSERT INTO credit_customer
                      (tenant_id, site_id, code, name, contact_phone, credit_limit, payment_terms_days)
                    VALUES (@tenant, @site, @code, @name, @phone, @limit, @terms)
                    RETURNING id
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = _user.SiteId, req.Code, req.Name,
                        phone = req.ContactPhone, limit = req.CreditLimit, terms = req.PaymentTermsDays
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            await conn.ExecuteAsync(new CommandDefinition(
                """
                UPDATE credit_customer
                   SET code = @code, name = @name, contact_phone = @phone,
                       credit_limit = @limit, payment_terms_days = @terms
                 WHERE id = @id
                """,
                new
                {
                    id, req.Code, req.Name, phone = req.ContactPhone,
                    limit = req.CreditLimit, terms = req.PaymentTermsDays
                },
                transaction: _uow.Transaction, cancellationToken: ct));
            return id.Value;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    /// <summary>
    /// Record fuel billed to an account.
    ///
    /// The price comes from shift_price — the figure stamped on the shift when
    /// it opened — not from a live lookup and not from the client. A client that
    /// can name its own price is a client that can under-bill a customer and
    /// leave the attendant carrying the difference.
    ///
    /// The credit limit is checked but NOT enforced as a hard stop. The fuel is
    /// already in the customer's tank by the time a supervisor types this in;
    /// refusing the record would not un-pump it, it would only push the sale
    /// off the books, which is the exact outcome the limit exists to prevent.
    /// Over-limit raises a flag for a manager instead.
    /// </summary>
    public async Task<Guid> RecordSaleAsync(Guid shiftId, RecordCreditSale req,
                                            CancellationToken ct)
    {
        Require("credit_sale.record");

        if (req.Litres <= 0)
            throw new DomainException("INVALID_LITRES", "Litres must be more than zero.");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            var ctx = await conn.QuerySingleOrDefaultAsync<CreditSaleContext>(
                new CommandDefinition(
                    """
                    SELECT t.product_id      AS ProductId,
                           -- (600) An agreed price in force beats the pump's.
                           -- The database checks it is this one, and stores
                           -- the pump price beside it for the cash-up.
                           COALESCE(cp.price, fn_shift_price(@shift, t.product_id)) AS UnitPrice,
                           cp.customer_price_id AS CustomerPriceId,
                           s.site_id         AS SiteId,
                           h.name            AS CustomerName,
                           h.headroom        AS Headroom,
                           h.balance         AS Balance
                      FROM shift s
                      JOIN nozzle n ON n.id = @nozzle
                      JOIN tank t   ON t.id = n.tank_id
                      -- Under a row lock on the customer. Reading the balance
                      -- from the view instead let two attendants selling to the
                      -- same haulier at the same moment BOTH see the headroom
                      -- before either sale existed -- so neither flagged, and
                      -- the customer went over their limit with nobody told.
                      -- A haulier with two trucks on the forecourt is an
                      -- ordinary Tuesday, not a rare interleaving.
                      CROSS JOIN fn_customer_headroom(@customer) h
                      LEFT JOIN LATERAL fn_customer_price(@customer, t.product_id,
                                                          fn_shift_price(@shift, t.product_id), now()) cp ON TRUE
                     WHERE s.id = @shift
                    """,
                    new { shift = shiftId, nozzle = req.NozzleId, customer = req.CustomerId },
                    transaction: _uow.Transaction, cancellationToken: ct));

            if (ctx is null)
                throw new DomainException("UNKNOWN_CONTEXT",
                    "That shift, nozzle or customer could not be found.", 404);

            var amount = Math.Round(req.Litres * ctx.UnitPrice, 2);

            var id = await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO credit_sale
                  (tenant_id, site_id, shift_id, customer_id, vehicle_id, staff_id,
                   attendant_id,
                   nozzle_id, product_id, litres, unit_price, amount, voucher_no,
                   odometer, signed_by, evidence_url, customer_price_id)
                VALUES (@tenant, @site, @shift, @customer, @vehicle, @staff,
                        @attendant,
                        @nozzle, @product, @litres, @price, @amount, @voucher,
                        @odometer, @signedBy, @evidence, @agreement)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, site = ctx.SiteId, shift = shiftId,
                    customer = req.CustomerId, vehicle = req.VehicleId,
                    // staff_id is the SUPERVISOR who recorded it. The composite FK
                    // on credit_sale.staff_id requires an operator, and an
                    // attendant is not one — they cannot author this.
                    staff = _user.StaffId,
                    // The attendant whose nozzle pumped it -- the person the
                    // credit settles against at close (520). It was asked for
                    // and dropped; the database checks they held that nozzle.
                    attendant = req.AttendantId == Guid.Empty ? (Guid?)null : req.AttendantId,
                    nozzle = req.NozzleId, product = ctx.ProductId,
                    litres = req.Litres, price = ctx.UnitPrice, amount,
                    voucher = req.VoucherNo, odometer = req.Odometer,
                    signedBy = req.SignedBy, evidence = req.EvidenceUrl,
                    agreement = ctx.CustomerPriceId
                },
                transaction: _uow.Transaction, cancellationToken: ct));

            if (amount > ctx.Headroom)
                await conn.ExecuteAsync(new CommandDefinition(
                    """
                    SELECT fn_raise_flag(@tenant, @site, @shift, 'credit_sale', @id::text,
                                         'CREDIT_LIMIT_EXCEEDED', 'WARN',
                                         jsonb_build_object('customer', @name,
                                           'balance', @balance, 'headroom', @headroom,
                                           'this_sale', @amount))
                    """,
                    new
                    {
                        tenant = _user.TenantId, site = ctx.SiteId, shift = shiftId,
                        id, name = ctx.CustomerName, balance = ctx.Balance,
                        headroom = ctx.Headroom, amount
                    },
                    transaction: _uow.Transaction, cancellationToken: ct));

            return id;
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }

    public async Task<IReadOnlyList<CreditSaleView>> ForShiftAsync(Guid shiftId,
                                                                   CancellationToken ct)
    {
        var conn = await _uow.ConnectionAsync(ct);
        await StationScope.RequireShiftAsync(conn, _uow, shiftId, ct);
        return (await conn.QueryAsync<CreditSaleView>(new CommandDefinition(
            """
            SELECT cs.id, cc.name AS CustomerName, cv.plate_no AS PlateNo,
                   st.full_name AS AttendantName, p.code AS ProductCode,
                   cs.litres, cs.unit_price AS UnitPrice, cs.amount,
                   cs.voucher_no AS VoucherNo, cs.recorded_at AS RecordedAt
              FROM credit_sale cs
              JOIN credit_customer cc ON cc.id = cs.customer_id
              -- The attendant it is set against, not the supervisor who typed it.
              JOIN staff st ON st.id = COALESCE(cs.attendant_id, cs.staff_id)
              JOIN product p ON p.id = cs.product_id
              LEFT JOIN credit_vehicle cv ON cv.id = cs.vehicle_id
             WHERE cs.shift_id = @shift
             ORDER BY cs.recorded_at
            """,
            new { shift = shiftId }, transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    public async Task<Guid> RecordPaymentAsync(RecordPayment req, CancellationToken ct)
    {
        Require("credit_payment.record");

        if (req.Amount <= 0)
            throw new DomainException("INVALID_AMOUNT", "A payment must be more than zero.");
        if (!Methods.Contains(req.Method))
            throw new DomainException("INVALID_METHOD",
                $"'{req.Method}' is not a payment method. Use one of: {string.Join(", ", Methods)}");

        var conn = await _uow.ConnectionAsync(ct);
        try
        {
            return await conn.ExecuteScalarAsync<Guid>(new CommandDefinition(
                """
                INSERT INTO credit_payment
                  (tenant_id, customer_id, amount, method, reference, evidence_url, received_by)
                VALUES (@tenant, @customer, @amount, @method, @reference, @evidence, @actor)
                RETURNING id
                """,
                new
                {
                    tenant = _user.TenantId, customer = req.CustomerId, amount = req.Amount,
                    method = req.Method.ToUpperInvariant(), reference = req.Reference,
                    evidence = req.EvidenceUrl, actor = _user.StaffId
                },
                transaction: _uow.Transaction, cancellationToken: ct));
        }
        catch (PostgresException ex) { throw PostgresErrors.Translate(ex); }
    }



    /// <summary>
    /// Ageing, FIFO.
    ///
    /// A balance on its own is the least useful thing you can know about a
    /// receivable: 4 million owed since last week and 4 million owed since
    /// March are the same number and completely different problems.
    ///
    /// `PastTerms` respects each customer's own agreed days rather than a
    /// single house rule -- a 30-day customer at 45 days is late, a 60-day
    /// customer at 45 days is not, and treating them alike loses you one of
    /// them.
    /// </summary>
    public async Task<IReadOnlyList<AgeingRow>> AgeingAsync(CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<AgeingRow>(new CommandDefinition(
            """
            SELECT customer_id AS CustomerId, code AS Code, name AS Name,
                   credit_limit AS CreditLimit,
                   payment_terms_days AS PaymentTermsDays,
                   balance AS Balance, current_30 AS Current30,
                   days_31_60 AS Days31To60, days_61_90 AS Days61To90,
                   over_90 AS Over90, oldest_days AS OldestDays,
                   past_terms AS PastTerms, headroom AS Headroom,
                   unapplied_credit AS UnappliedCredit,
                   is_active AS IsActive
              FROM v_credit_ageing_buckets
             WHERE is_active OR balance <> 0
             ORDER BY past_terms DESC, balance DESC, name
            """,
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
    }

    /// <summary>
    /// A full statement with a running balance -- the document that goes to a
    /// transporter who disputes their bill. Every line carries the voucher or
    /// payment reference that backs it, because a statement somebody cannot
    /// check against their own paperwork settles nothing.
    /// </summary>
    public async Task<IReadOnlyList<StatementLineRow>> FullStatementAsync(Guid customerId,
        DateOnly? from, DateOnly? to, CancellationToken ct)
    {
        // A financial report: it had no permission check of its own, so any signed-in
        // user in the company could read it.
        if (!_user.Can("report.view"))
            throw new DomainException("FORBIDDEN", "This needs report.view.", 403);

        var conn = await _uow.ConnectionAsync(ct);
        return (await conn.QueryAsync<StatementLineRow>(new CommandDefinition(
            """
            SELECT at AS At, kind AS Kind, reference AS Reference,
                   vehicle AS Vehicle, litres AS Litres,
                   debit AS Debit, credit AS Credit,
                   running_balance AS RunningBalance
              FROM v_credit_statement
             WHERE customer_id = @customer
               AND (@from::date IS NULL OR at >= @from::date)
               AND (@to::date   IS NULL OR at <  (@to::date + 1))
             ORDER BY at, kind
            """,
            new { customer = customerId, from, to },
            transaction: _uow.Transaction, cancellationToken: ct))).ToList();
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

public static class CreditEndpoints
{
    public static void MapCredit(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/credit").RequireAuthorization();

        g.MapGet("/customers", async (bool? activeOnly, CreditService s, CancellationToken ct) =>
            Results.Ok(await s.CustomersAsync(activeOnly ?? true, ct)));

        g.MapGet("/customers/{id:guid}/ledger",
            async (Guid id, CreditService s, CancellationToken ct) =>
                Results.Ok(await s.LedgerAsync(id, ct)));

        g.MapPost("/customers", async (UpsertCustomer req, CreditService s, CancellationToken ct) =>
            Results.Ok(new { customerId = await s.UpsertCustomerAsync(null, req, ct) }));

        g.MapPut("/customers/{id:guid}",
            async (Guid id, UpsertCustomer req, CreditService s, CancellationToken ct) =>
                Results.Ok(new { customerId = await s.UpsertCustomerAsync(id, req, ct) }));

        // The endpoint v1 never called from anywhere.
        g.MapPost("/shifts/{shiftId:guid}/sales",
            async (Guid shiftId, RecordCreditSale req, CreditService s, CancellationToken ct) =>
                Results.Ok(new { creditSaleId = await s.RecordSaleAsync(shiftId, req, ct) }));

        g.MapGet("/shifts/{shiftId:guid}/sales",
            async (Guid shiftId, CreditService s, CancellationToken ct) =>
                Results.Ok(await s.ForShiftAsync(shiftId, ct)));

        g.MapPost("/payments", async (RecordPayment req, CreditService s, CancellationToken ct) =>
            Results.Ok(new { paymentId = await s.RecordPaymentAsync(req, ct) }));

        g.MapGet("/ageing", async (CreditService s, CancellationToken ct) =>
            Results.Ok(await s.AgeingAsync(ct)));

        g.MapGet("/customers/{id:guid}/full-statement",
            async (Guid id, DateOnly? from, DateOnly? to, CreditService s,
                   CancellationToken ct) =>
                Results.Ok(await s.FullStatementAsync(id, from, to, ct)));

    }
}
