/**
 * Head office's WORKING SITE: the station or depot its station screens act on.
 *
 * Head office holds no stock and runs no shifts at its own site, so screens
 * that show one site (pumps, losses, shop stock, prices) read nothing there.
 * The top bar chooses a site; every API call carries it as X-Site-Id; the
 * server checks it belongs to the company and ignores it for station staff.
 * Unset, the server takes the company's first station.
 */
const KEY = 'fcms_site';

export function getWorkingSite(): string | null {
  try { return typeof window === 'undefined' ? null : sessionStorage.getItem(KEY); } catch { return null; }
}

export function setWorkingSite(id: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY);
  } catch { /* storage refused: the server's default stands */ }
}
