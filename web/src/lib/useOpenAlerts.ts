'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';

/**
 * How many alerts are open -- the real number, for the bell and the sidebar.
 * The sidebar's Alerts badge was a hard-coded 7 and the bell's red dot was
 * always lit, whether there were no alerts or fifty. null until known (and if
 * this person cannot see alerts), so nothing claims a count it does not have.
 */
export function useOpenAlerts(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.get<unknown[]>('/api/v1/dashboard/alerts')
        .then((rows) => { if (!cancelled) setN(rows.length); })
        .catch(() => { if (!cancelled) setN(null); });
    void load();
    const t = setInterval(load, 120_000);        // fresh enough for a bell, light on the server
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return n;
}
