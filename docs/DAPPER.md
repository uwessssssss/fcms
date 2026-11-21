# Why Dapper targets are classes, not records

Every type Dapper materialises in this codebase is a `sealed class` with
settable properties. That is deliberate, and it cost a live failure to learn.

## What went wrong

Query targets were positional records. Dapper materialises a record by finding
a **constructor whose entire signature matches the result set**. One parameter
of the wrong CLR type fails the whole thing:

```
A parameterless default constructor or one matching signature
(System.Guid staffid, ..., System.DateTime lockeduntil, System.Boolean isactive)
is required for AuthRow materialization
```

The signature in that message is the one Dapper *wants*, not the one you wrote,
which makes the real difference easy to miss. Here it was `DateTime` where the
record said `DateTimeOffset`.

## The underlying cause

**Npgsql maps `timestamptz` to `DateTime` with `Kind=Utc`, not
`DateTimeOffset`.** Every record carrying a timestamp was therefore broken --
one error surfaced, and the next twenty were waiting behind it.

It matters on the write side too: Npgsql refuses to write a `DateTimeOffset`
with a non-zero offset to `timestamptz`.

## The rule

- Dapper targets are **classes with `{ get; set; }` properties**. Dapper then
  assigns column by column and converts each value independently, so a near-miss
  on one column stays a problem with that column.
- **No `DateTimeOffset`.** Use `DateTime` for `timestamptz`, `DateOnly` for
  `date`.
- Non-nullable reference properties need an initialiser (`= ""`), because
  `TreatWarningsAsErrors` is on and CS8618 would fail the build.

`tools/check_seams.py` enforces the first two.

## What stays a record

Request DTOs and API response shapes -- anything constructed in C# and
serialised to JSON. Those never pass through Dapper, and records are the better
tool for them.
