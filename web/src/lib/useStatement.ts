"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { StatementResult } from "@/types/api";

/**
 * Loads a statement and maps its rows into whatever shape a screen wants.
 *
 * Several screens are, underneath, a statement the server already produces:
 * expenses, payments received, deliveries, the shift log. Each has a query
 * that is written once, validated against the schema by `check_sql.py`, and
 * totalled server-side.
 *
 * Giving each of those screens its own endpoint would mean the same figures
 * computed in two places, and the two would disagree the first time one was
 * changed. So they share the registry, and this hook is the join.
 *
 * The `map` turns a generic row into the screen's own interface. Keeping that
 * here rather than in the server means the screen owns its presentation --
 * colours, labels, formatting -- and the server owns the figures. That
 * boundary has held up well: it is why adding a statement is a query.
 */
export function useStatement<T>(
  key: string,
  map: (row: Record<string, unknown>) => T,
  range?: { from?: string; to?: string },
): {
  rows: T[];
  totals: Record<string, number>;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [rows, setRows] = useState<T[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const from = range?.from;
  const to = range?.to;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const suffix = q.toString() ? `?${q.toString()}` : "";

    void api
      .get<StatementResult>(`/api/statements/${key}${suffix}`)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows.map(map));
        setTotals(r.totals);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        // Named, not swallowed. A screen showing an empty table when the
        // server is unreachable reads as "no expenses this month", which is a
        // different and much worse answer than "could not ask".
        setError((e as ApiError).message);
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `map` is a new function on every render in most callers, so it is
    // deliberately not a dependency -- including it would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, from, to, nonce]);

  return { rows, totals, loading, error, reload: () => setNonce((n) => n + 1) };
}

/** Reads a value out of a statement row, whatever the server called it. */
export function field(row: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (v !== null && v !== undefined && v !== "") {
      // A date column arrives as midnight ("2026-11-17T00:00:00"): show the day.
      const t = String(v);
      return /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|[+-]00:00)?$/.test(t) ? t.slice(0, 10) : t;
    }
  }
  return "";
}

/** The same, as a number. Missing reads as zero, which is what a total wants. */
export function num(row: Record<string, unknown>, ...names: string[]): number {
  for (const n of names) {
    const v = Number(row[n]);
    if (Number.isFinite(v)) return v;
  }
  return 0;
}
