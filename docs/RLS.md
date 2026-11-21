# Row-level security, and the one request that starts outside it

Every tenant-scoped table has the same policy:

```sql
USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())
```

`app_tenant()` reads `app.tenant_id`, which `UnitOfWork` sets
**transaction-locally** at the start of each request:

```csharp
set_config('app.tenant_id', $1, true)   // true = transaction-local
```

The `true` is the whole point. v1 passed `false` -- session scope -- on a pooled
connection, so the setting either vanished between queries (every screen blank,
no error) or survived into the next request (one tenant reading another's data).

## Login is the exception, and it has to be

Login begins without knowing its tenant: the employee number has to be looked up
before anyone can say which business it belongs to. So:

1. `fn_auth_lookup` is `SECURITY DEFINER`, owned by `fcms_auth`, which holds
   `BYPASSRLS`. It is deliberately the narrowest hole that can exist -- it
   returns credential fields for one employee number and can read nothing else.
   `fcms_auth` has `SELECT` on `staff` and `staff_credential` and nothing more.

2. **The moment the lookup returns, the tenant is known**, and
   `SetTenantContextAsync` establishes it for the rest of the transaction.

Step 2 was missing at first, and login failed with:

```
new row violates row-level security policy for table "staff_session"
```

That was RLS working correctly on a request that had never told it who it was.
Writing the session row through another `BYPASSRLS` function would also have
"fixed" it -- and would have widened the hole for no reason. Setting the context
is the honest fix: after authentication, login is an ordinary tenant-scoped
request and should be subject to the same rules as every other one.

## Two rules the checkers enforce

- **Every `INSERT` into a tenant-scoped table supplies `tenant_id`.** The
  `WITH CHECK` clause refuses one that does not, and the error reads like a
  permissions fault rather than a missing column.
- **A `SECURITY DEFINER` function's owner must hold grants on what it reads.**
  `BYPASSRLS` gets you past row policies; it does not get you into the table.
  Confusing the two produced `permission denied for table staff` on the first
  login attempt.

Both live in `tools/check_seams.py`.

## Why the integrity suite switches role

`db/test/integrity.sql` does `SET LOCAL ROLE fcms_app` before its isolation
tests, because **a superuser bypasses RLS entirely**. The suite runs as
`postgres`, so every tenant assertion made without that switch would pass while
proving nothing. The test helpers stay `SECURITY INVOKER` for the same reason --
making them `DEFINER` would silence grant errors and run every test body as
`postgres`.
