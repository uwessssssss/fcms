/**
 * Dates as the station means them.
 *
 * `new Date().toISOString().slice(0, 10)` -- used for "today" in 26 places --
 * is the date in UTC. Kampala is UTC+3, so from midnight to 03:00 it said
 * YESTERDAY. And a business day starts at 06:00 (site.day_starts_at), so from
 * 03:00 to 06:00 it was wrong the other way: those hours belong to the
 * previous business day. A car wash rung up at 01:00, a deposit banked on the
 * night shift, a depot's "loads today" -- all dated by accident.
 *
 * The browser is assumed to be in the station's timezone (Kampala and Nairobi
 * are both UTC+3). A site whose day starts at another hour passes it in.
 */
export const DAY_STARTS_AT_HOUR = 6;

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The business date now: local time, less the start of the business day. */
export function businessToday(dayStartsAtHour: number = DAY_STARTS_AT_HOUR, now: Date = new Date()): string {
  return ymd(new Date(now.getTime() - dayStartsAtHour * 3_600_000));
}

/** The local calendar date -- for things a person names by the calendar, like a file. */
export function localDate(now: Date = new Date()): string {
  return ymd(now);
}

/** The first day of the month a date falls in. */
export function monthStartOf(date: string): string {
  return date.slice(0, 8) + '01';
}
