// =============================================================================
// SchemaTypes.cs
//
// The C# side of every enum the database declares.
//
// Lifted out of Program.cs, which had grown to 635 lines doing five unrelated
// jobs: environment loading, service registration, middleware, route mapping
// and these. A reader looking for "what are the shift states" had to scroll
// past the JWT configuration to find out.
//
// These matter more than they look. `check_seams.py` compares every member
// here against the schema's labels on every run, so a value added to a
// Postgres enum without a matching member is a build-time finding rather than
// an InvalidCastException the first time a row with that value is read.
// =============================================================================

// ---------------------------------------------------------------------------
// Enum mirrors of the schema's types. Kept in one place so a rename in the
// database is a compile error here rather than a runtime cast failure.
// ---------------------------------------------------------------------------
namespace Fcms.Api.Infrastructure
{
    /// <summary>
    /// Uses enum member names exactly as written, with no case transformation.
    /// The schema's labels are UPPERCASE and so are the C# members; anything
    /// clever in between is a bug waiting for production.
    /// </summary>
    public sealed class IdentityNameTranslator : Npgsql.INpgsqlNameTranslator
    {
        public string TranslateTypeName(string clrName) => clrName;
        public string TranslateMemberName(string clrName) => clrName;
    }

    public enum StaffRole
    {
        ATTENDANT, SUPERVISOR, MANAGER, ACCOUNTANT, AUDITOR, ADMIN, DIRECTOR,
        SYSTEM_ADMIN,
        // Runs a company: appoints its managers, approves any of its sites.
        // Not a trading role -- head office holds no tanks and closes no shifts.
        HEAD_OFFICE
    }
    public enum ShiftState { OPEN, COUNTING, DECLARED, APPROVED, POSTED, VOID }
    public enum CloseReasonEnum { SCHEDULED, PRICE_CHANGE, STOCK_TAKE, DELIVERY, INCIDENT, HANDOVER }
    public enum MovementKind
    {
        OPENING_BALANCE, DELIVERY_IN, METER_OUT, TEST_RETURN_IN, BULK_OUT, BULK_IN,
        WATER_DRAW_OUT, STOCK_TAKE_ADJUST, CORRECTION,
        // Return-to-tank litres coming back into the book. Positive: without
        // it the meter takes them off and nothing puts them back, and the next
        // dip shows a gain of exactly the returned amount.
        RTT_IN
    }
    public enum DispositionKind
    {
        SALE, PUMP_TEST, OWN_USE,
        // Metered, then returned to the tank. Not owed by the attendant, and
        // must point at a return_to_tank row -- RTT is where theft hides.
        RTT
    }
    public enum SettlementKind
    {
        CASH, MOBILE_MONEY, CARD, VOUCHER, CREDIT, DISCOUNT, SHORTAGE, OVERAGE,
        PRICE_AGREEMENT   // (600) agreed customer price against the pump
    }
    public enum ReadingSource { MANUAL, ELECTRONIC, ATG, IMPORT }
    public enum DipContext { SHIFT_OPEN, SHIFT_CLOSE, PRE_DELIVERY, POST_DELIVERY, STOCK_TAKE, SPOT_CHECK }
    public enum EvidenceState { PRESENT, PENDING, WAIVED }
    public enum Severity { INFO, WARN, CRITICAL }
    public enum DryMovementKind
    {
        OPENING_BALANCE, PURCHASE_IN, SALE_OUT, EXCHANGE_IN, CUSTOMER_RETURN_IN,
        DAMAGE_OUT, EXPIRY_OUT, OWN_USE_OUT, TRANSFER_IN, TRANSFER_OUT,
        COUNT_ADJUST, CORRECTION
    }
}
