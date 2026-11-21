using System.Data;
using Dapper;

namespace Fcms.Api.Infrastructure;

/// <summary>
/// Teaches Dapper about DateOnly.
///
/// Npgsql hands back a DateTime for a `date` column, and Dapper has no built-in
/// conversion to DateOnly, so a business date fails in both directions:
///
///   reading:  Invalid cast from 'System.DateTime' to 'System.DateOnly'
///   writing:  The member from of type System.DateOnly cannot be used as a
///             parameter value
///
/// The alternative was to replace DateOnly with DateTime everywhere, as was
/// done for DateTimeOffset. That would work, but it is the wrong trade here: a
/// business date genuinely has no time component, and modelling it as a
/// DateTime invites exactly the timezone confusion that makes a night shift
/// land on the wrong day. Twenty lines of handler keeps the domain honest.
/// </summary>
public sealed class DateOnlyTypeHandler : SqlMapper.TypeHandler<DateOnly>
{
    public override DateOnly Parse(object value) => value switch
    {
        DateOnly d  => d,
        DateTime dt => DateOnly.FromDateTime(dt),
        string s    => DateOnly.Parse(s),
        _ => throw new DataException(
            $"Cannot convert {value?.GetType().Name ?? "null"} to DateOnly.")
    };

    public override void SetValue(IDbDataParameter parameter, DateOnly value)
    {
        // DbType.Date, not DateTime: Postgres `date` has no time part, and
        // sending one invites an off-by-one when the server timezone differs
        // from the station's.
        parameter.DbType = DbType.Date;
        parameter.Value = value.ToDateTime(TimeOnly.MinValue);
    }
}

/// <summary>
/// The nullable case. Dapper resolves handlers by exact type, so DateOnly? does
/// not fall back to the DateOnly handler and needs its own.
/// </summary>
public sealed class NullableDateOnlyTypeHandler : SqlMapper.TypeHandler<DateOnly?>
{
    public override DateOnly? Parse(object value) => value switch
    {
        null        => null,
        DateOnly d  => d,
        DateTime dt => DateOnly.FromDateTime(dt),
        string s    => DateOnly.Parse(s),
        _ => throw new DataException(
            $"Cannot convert {value.GetType().Name} to DateOnly?.")
    };

    public override void SetValue(IDbDataParameter parameter, DateOnly? value)
    {
        parameter.DbType = DbType.Date;
        parameter.Value = value.HasValue
            ? value.Value.ToDateTime(TimeOnly.MinValue)
            : DBNull.Value;
    }
}

/// <summary>
/// TimeOnly, for shift_pattern.starts_at. Same reasoning.
/// </summary>
public sealed class TimeOnlyTypeHandler : SqlMapper.TypeHandler<TimeOnly>
{
    public override TimeOnly Parse(object value) => value switch
    {
        TimeOnly t  => t,
        TimeSpan ts => TimeOnly.FromTimeSpan(ts),
        DateTime dt => TimeOnly.FromDateTime(dt),
        string s    => TimeOnly.Parse(s),
        _ => throw new DataException(
            $"Cannot convert {value?.GetType().Name ?? "null"} to TimeOnly.")
    };

    public override void SetValue(IDbDataParameter parameter, TimeOnly value)
    {
        parameter.DbType = DbType.Time;
        parameter.Value = value.ToTimeSpan();
    }
}
