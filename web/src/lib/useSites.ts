'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { DashboardOverview } from '@/types/api';

/**
 * The company's real trading sites, by name.
 *
 * Twelve screens carried the same constant -- Kampala Central, Nairobi West,
 * Dar es Salaam, Juba North, Mombasa Road -- in their site dropdowns. None of
 * those stations exist in this company. A filter offering them selects
 * nothing; a form defaulting to one files a record against a site that is not
 * there.
 *
 * Head offices are excluded by the endpoint: they trade nothing, so they are
 * never a site you filter sales or stock by.
 */
export function useSites(): string[] {
  const [sites, setSites] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<DashboardOverview>('/api/v1/dashboard/overview')
      .then((o) => {
        if (!cancelled) setSites(o.sites.map((s) => s.name));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return sites;
}
