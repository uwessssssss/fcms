'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { DashboardOverview } from '@/types/api';

/**
 * Whether this company runs a depot: true once it has a site of kind DEPOT.
 *
 * Most companies have no depot and a few do. Rather than a switch that could
 * disagree with reality, the answer IS the sites: add a depot (Administration
 * -> Depot) and the depot screens appear. null while it is being found out,
 * so nothing depot-shaped flashes up and then vanishes.
 */
export function useHasDepot(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get<DashboardOverview>('/api/v1/dashboard/overview')
      .then((ov) => { if (!cancelled) setHas(ov.sites.some((s) => s.kind === 'DEPOT')); })
      .catch(() => { if (!cancelled) setHas(false); });
    return () => {
      cancelled = true;
    };
  }, []);
  return has;
}
