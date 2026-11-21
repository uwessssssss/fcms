/**
 * The one place this application talks to the server.
 *
 * Everything goes through here so that four things are decided once rather
 * than in every screen:
 *
 *   THE TOKEN. Held in sessionStorage, not localStorage. A forecourt office
 *   machine is shared -- a supervisor closes the tab and the next person sits
 *   down, and a token that survives that is a signed-in session they did not
 *   ask for.
 *
 *   THE REFUSAL. This server refuses things on purpose: an unbalanced cash-up,
 *   a dip above a tank's capacity, a credit sale past a limit. Those refusals
 *   carry a code and a sentence written for the person reading it, and they
 *   must reach the screen intact rather than becoming "something went wrong".
 *
 *   THE TRACE. Every response carries an X-Trace-Id. When somebody reports a
 *   failure, that one string finds the exact request in the server log.
 *
 *   EXPIRY. A 401 means the session is gone. Every screen would otherwise have
 *   to handle that, and most would forget.
 */

/**
 * Where the API is.
 *
 * NEXT_PUBLIC_* values are baked in when Next BUILDS, not when it runs. A
 * `.next` folder compiled before `.env.local` existed still holds whatever was
 * there at the time -- so the symptom of a stale cache is a screen that keeps
 * showing old data with no error at all, which is a miserable thing to debug.
 *
 * So it says so, once, in the console.
 */
const BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:5000";

if (typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.info(
    `[FCMS] API: ${BASE}` +
      (process.env.NEXT_PUBLIC_API_URL
        ? ""
        : " (no NEXT_PUBLIC_API_URL — using the default; if this is wrong, " +
          "stop the dev server, delete .next, and start it again)"),
  );
}

const TOKEN_KEY = "fcms_token";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** A refusal the system meant to make, rather than a fault. */
  get isRefusal(): boolean {
    return this.status === 422 || this.status === 409;
  }
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

interface RequestOptions {
  /**
   * A key for a write with a REAL unique identity -- an invoice number, a
   * delivery note, a customer code -- where a repeat IS the same thing.
   *
   * For anything that can legitimately happen twice, use `submission`.
   */
  idempotencyKey?: string;
  /**
   * Names the save this call belongs to: 'credit-sale:<shift>', 'expense'.
   *
   * Two lessons, one each way. A fresh uuid on every ATTEMPT protects
   * nothing -- each retry looks new; that shipped once and cost a week. A key
   * DERIVED FROM CONTENT (customer + litres) cannot tell a retry from a
   * second, genuine, identical sale: two trucks from one fleet taking 100 L
   * each, and the server replayed the first -- the screen said "recorded" and
   * the attendant came up short. That shipped in 16 places.
   *
   * The right unit is the SAVE: one key, kept across retries while the
   * outcome is unknown, retired the moment the server confirms. The next
   * save -- however identical -- gets a new one.
   */
  submission?: string;
  signal?: AbortSignal;
}

// One open key per named save, until the server confirms it.
const openSubmissions = new Map<string, string>();

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function submissionKey(scope: string): string {
  let k = openSubmissions.get(scope);
  if (!k) {
    k = `${scope}:${newId()}`;
    openSubmissions.set(scope, k);
  }
  return k;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const key = opts.idempotencyKey ?? (opts.submission ? submissionKey(opts.submission) : undefined);
  if (key) headers["Idempotency-Key"] = key;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch {
    // The network, not the server. This used to say "Nothing was saved" --
    // not true when it is the REPLY that was lost: the save may have gone
    // through. With a key, a retry is safe either way; without one, say so.
    throw new ApiError(
      0,
      "NO_CONNECTION",
      key
        ? "No connection to the server. It is safe to try again - if the first attempt did go through, it will not be recorded twice."
        : "No connection to the server. It may or may not have been saved - check before trying again.",
    );
  }

  const traceId = res.headers.get("X-Trace-Id") ?? undefined;

  // Confirmed: the server stored this save's key, so the next save needs a
  // new one. Anything else leaves it open -- a retry must reuse it.
  if (res.ok && opts.submission) openSubmissions.delete(opts.submission);

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!res.ok) {
    const p = (payload ?? {}) as { code?: string; message?: string; detail?: unknown };

    // A wrong password is a 401 too, but it is not the end of a session: the
    // login screen must be able to say "that password is not right", and a
    // mistyped CURRENT password while changing it must not sign anyone out.
    // Every 401 used to become SESSION_ENDED, so the login screen told a
    // person with a typo that their session had ended.
    if (res.status === 401 && p.code === "INVALID_CREDENTIALS") {
      throw new ApiError(401, p.code, p.message ?? "That employee number or password is not right.", p.detail, traceId);
    }

    if (res.status === 401) {
      setToken(null);
      throw new ApiError(
        401,
        "SESSION_ENDED",
        "Your session has ended. Sign in again — nothing you entered has been lost from the station's records.",
        undefined,
        traceId,
      );
    }

    // The key was already used for a DIFFERENT save: the earlier attempt went
    // through before its reply was lost, and the form was changed since. Say
    // so plainly, and retire the key so the next save is a new one.
    if (p.code === "IDEMPOTENCY_KEY_REUSED") {
      if (opts.submission) openSubmissions.delete(opts.submission);
      throw new ApiError(
        409,
        "ALREADY_SAVED",
        "The previous attempt was saved before the connection dropped. Check the list before saving again.",
        undefined,
        traceId,
      );
    }

    throw new ApiError(
      res.status,
      p.code ?? "UNKNOWN",
      p.message ?? `The server refused that (${res.status}).`,
      p.detail,
      traceId,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};
