using System.Text.RegularExpressions;
using Npgsql;

namespace Fcms.Api.Common;

/// <summary>
/// A refusal the user should read.
/// </summary>
public sealed class DomainException : Exception
{
    public string Code { get; }
    public int Status { get; }
    public object? Detail { get; }

    public DomainException(string code, string message, int status = 422,
                           object? detail = null, Exception? inner = null)
        : base(message, inner) => (Code, Status, Detail) = (code, status, detail);
}

/// <summary>
/// Translates PostgreSQL errors into HTTP responses.
///
/// The schema raises errors in a deliberate shape:
///
///   RAISE EXCEPTION 'UNACCOUNTED_FUEL: meter event % dispensed % L but only
///     % L is classified …'
///
/// CODE first, then a sentence written for the supervisor standing on the
/// forecourt at 6am. That message is passed through UNCHANGED. Rewriting it
/// here would mean maintaining the same explanation in two places, and the two
/// would drift — which is how v1 ended up with a screen that said
/// "An error occurred" for eleven distinct, individually fixable problems.
///
/// The database owns the wording. This class owns the status code.
/// </summary>
public static class PostgresErrors
{
    private static readonly Regex Coded =
        new(@"^(?<code>[A-Z][A-Z0-9_]{3,}):\s*(?<message>.+)$", RegexOptions.Singleline);

    /// <summary>
    /// Constraint names carry no message of their own, so they get one here.
    /// Each maps to a rule a person can act on, not to the constraint's syntax.
    /// </summary>
    private static readonly Dictionary<string, (int Status, string Message)> ByConstraint = new()
    {
        ["one_live_shift_per_site"] = (409,
            "This station already has a shift open. Close it before opening another."),
        ["one_active_holder_per_nozzle"] = (409,
            "That nozzle is already assigned to someone on this shift. Hand it over instead."),
        ["one_opening_per_assignment"] = (409,
            "This assignment already has an opening reading. A meter is read once at each end."),
        ["one_closing_per_assignment"] = (409,
            "This assignment has already been closed."),
        ["shift_segregation"] = (422,
            "The person who closed the shift cannot also approve it."),
        ["cashup_two_pairs_of_eyes"] = (422,
            "A cash-up must be approved by someone other than the person who declared it."),
        ["cash_up_segregation"] = (422,
            "A cash-up cannot be approved by the attendant it belongs to."),
        ["salary_needs_acknowledgement"] = (422,
            "Recovering a shortage from wages needs the attendant's signed acknowledgement attached."),
        ["executed_change_broke_a_shift"] = (422,
            "A price change must close the running shift and open a new one. "
            + "Execute it through the price-break flow."),
        ["closed_needs_reason"] = (422,
            "A closed shift must record why it closed."),
        ["movement_has_exactly_one_source"] = (422,
            "Every fuel movement must trace to exactly one document — a delivery, "
            + "a meter event, a bulk draw or a count."),
        ["movement_sign_correct"] = (422,
            "That movement's direction does not match its kind — a delivery cannot remove fuel."),
        ["discount_not_self_authorised"] = (422,
            "A discount must be authorised by someone other than the attendant who gave it."),
        ["writeoff_needs_note"] = (422,
            "Writing stock off needs a reason recorded against it."),
        ["dry_variance_needs_reason"] = (422,
            "A counted difference needs a reason before the count can be posted."),
        ["staff_shortage_cash_up_id_key"] = (409,
            "A shortage has already been raised for this cash-up. "
            + "Recompute it rather than raising a second one."),
        ["nozzle_site_matches"] = (422,
            "A nozzle, its pump and its tank must all be at the same station."),
    };

    /// <summary>
    /// SQLSTATE fallbacks, for anything that reaches here without a coded
    /// message or a recognised constraint.
    /// </summary>
    private static readonly Dictionary<string, (int Status, string Code, string Message)> BySqlState = new()
    {
        ["23505"] = (409, "DUPLICATE", "That record already exists."),
        ["23503"] = (422, "MISSING_REFERENCE", "That refers to something which does not exist."),
        ["23514"] = (422, "RULE_VIOLATED", "That would break a rule the station relies on."),
        ["23502"] = (422, "MISSING_FIELD", "A required value was not supplied."),
        ["P0002"] = (404, "NOT_FOUND", "That record could not be found."),
        ["40001"] = (409, "CONCURRENT_EDIT", "Someone else changed this at the same moment. Try again."),
        ["40P01"] = (409, "DEADLOCK", "Two operations collided. Try again."),
        ["57014"] = (504, "TIMEOUT", "That took too long and was stopped."),
    };

    public static DomainException Translate(PostgresException ex)
    {
        // 1. A coded message from one of our own RAISE EXCEPTIONs.
        var m = Coded.Match(ex.MessageText);
        if (m.Success)
        {
            var code = m.Groups["code"].Value;
            return new DomainException(code, m.Groups["message"].Value.Trim(),
                                       StatusFor(code), inner: ex);
        }

        // 2. A constraint we have written an explanation for.
        var constraint = ex.ConstraintName ?? "";
        if (ByConstraint.TryGetValue(constraint, out var known))
            return new DomainException(constraint.ToUpperInvariant(), known.Message, known.Status, inner: ex);

        // 3. SQLSTATE.
        if (BySqlState.TryGetValue(ex.SqlState, out var generic))
            return new DomainException(generic.Code, generic.Message, generic.Status, inner: ex);

        // 4. Unknown. Do NOT leak the raw Postgres text to the client — it can
        //    contain column names, table names and sometimes row values.
        // The fallback. Everything above is a refusal the system understands and
        // can explain; reaching here means it does not.
        //
        // So it says what the database said, on screen, rather than hiding it.
        // "Something went wrong saving that" is comforting and useless -- it
        // sent this project through four rounds of relaying log files. A
        // supervisor who reads "column expenses does not exist" cannot fix it
        // either, but they can quote it in one message and it gets fixed today.
        //
        // This is a station's own control system, not a public API. There is no
        // attacker on the other side of it, and the operator is the person who
        // needs the truth most.
        return new DomainException("DATABASE_ERROR",
            $"The database refused that, and this is not a refusal the system "
            + $"recognises: {ex.MessageText}"
            + (ex.ConstraintName is null ? "" : $" (constraint {ex.ConstraintName})")
            + (ex.TableName is null ? "" : $" (table {ex.TableName})")
            + $" [{ex.SqlState}]. Nothing was changed. Quote this whole message.",
            500,
            detail: new
            {
                sqlState = ex.SqlState,
                message = ex.MessageText,
                table = ex.TableName,
                constraint = ex.ConstraintName,
                column = ex.ColumnName,
                where = ex.Where,
            },
            inner: ex);
    }

    /// <summary>
    /// Which of our coded refusals are conflicts, which are bad requests, and
    /// which are the client asking for something that is not there.
    /// </summary>
    private static int StatusFor(string code) => code switch
    {
        // The two invariants. These are the system doing its job, so they are
        // 422 rather than 500: the request was well-formed, the books were not.
        "UNACCOUNTED_FUEL" or "CASH_UP_UNBALANCED" or "DRY_SALE_UNBALANCED"
            or "DISPOSITION_EXCEEDS_METER" => 422,

        // State conflicts.
        "SHIFT_NOT_OPEN" or "ALREADY_RECEIVED" or "PRICE_NOT_PENDING"
            or "COUNT_NOT_APPROVED" or "STOCK_TAKE_POSTED" => 409,

        // Not found.
        "UNKNOWN_SHIFT" or "UNKNOWN_SITE" or "UNKNOWN_NOZZLE" or "UNKNOWN_DELIVERY"
            or "UNKNOWN_ASSIGNMENT" or "UNKNOWN_COUNT" or "NO_CALIBRATION_CHART"
            or "NO_PRICE" or "NO_SHIFT_PRICE" => 404,

        // Everything else is a refusal to accept bad data.
        _ => 422
    };

    /// <summary>
    /// True when retrying the identical request might succeed. The offline
    /// outbox uses this to decide between re-queueing and surfacing the refusal
    /// to the supervisor — a deadlock is worth retrying, an unbalanced cash-up
    /// never is.
    /// </summary>
    public static bool IsTransient(PostgresException ex) =>
        ex.SqlState is "40001" or "40P01" or "55P03" or "57014" or "08006" or "08003";
}
