# The frontend now talks to the API

## What is wired

| | |
|---|---|
| **Sign in** | `POST /api/auth/login` — real credentials, real token |
| **Dashboard** | `GET /api/v1/dashboard/overview` — live sites, revenue, litres, alerts |

Everything else still renders its mock data. Each unwired screen carries a
comment naming the endpoint it wants.

## Running both

```bash
# terminal 1
cd api && dotnet run          # prints the port it is listening on

# terminal 2
cd web && npm install && npm run dev
```

Then <http://localhost:3000> and sign in with an **employee number**, not an
email — `SUP01`, `MGR01`, `ACC01`. The field is labelled Email because that is
what the design shipped with; the value is passed through untouched.

Attendants have no sign-in at all. That is deliberate: they are subjects of the
record, not authors of it, and the database makes it structurally impossible
for one to author a reading.

## If the dashboard says it cannot reach the server

Check `web/.env.local` against the port the API printed. They must match. The
API's own startup line now names the database, port and user it connected to,
so a mismatch is visible in one glance rather than after an hour.

## Wiring the next screen

1. Find its `// Backend: GET …` comment. That is the contract, already written.
2. Add the response shape to `src/types/api.ts`.
3. Replace the mock array with `api.get<T>(path)` and a loading state.
4. Run `./verify.sh` — `check_types.py` will tell you if the C# record and your
   TypeScript interface disagree.

That last step is worth not skipping. A renamed field renders as a blank cell,
and a blank money column looks like a zero rather than an error.
