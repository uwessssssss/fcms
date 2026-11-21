/**
 * What is missing or does not add up on a form -- said where it is, before
 * saving, rather than as a toast after the server refuses.
 *
 *   ERRORS block saving: a blank required field, a figure that cannot be true.
 *   WARNINGS do not: a figure that is possible but worth a second look -- a
 *   dip above safe fill, an opening dip far from the book.
 *
 * A form builds its issues from its current values on every render; nothing
 * is stored. Errors are shown once the person tries to save (an empty form is
 * not a wall of red); warnings show as soon as the figure is there.
 */
export type Level = 'error' | 'warning';
export interface Issue { field: string; level: Level; message: string }

export const blank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export class Checker {
  readonly issues: Issue[] = [];

  error(field: string, message: string): this { this.issues.push({ field, level: 'error', message }); return this; }
  warn(field: string, message: string): this { this.issues.push({ field, level: 'warning', message }); return this; }

  /** Present, or an error naming what is missing. */
  required(field: string, value: unknown, what: string): boolean {
    if (blank(value)) { this.error(field, `${what} is needed`); return false; }
    return true;
  }

  /** A number from a text box: blank is MISSING, not zero. Returns it, or null. */
  number(field: string, value: string | undefined, what: string,
         opts: { min?: number; max?: number; positive?: boolean; optional?: boolean } = {}): number | null {
    if (blank(value)) { if (!opts.optional) this.error(field, `${what} is needed`); return null; }
    const n = Number(value);
    if (!Number.isFinite(n)) { this.error(field, `${what} must be a number`); return null; }
    if (opts.positive && !(n > 0)) { this.error(field, `${what} must be more than 0`); return null; }
    if (opts.min !== undefined && n < opts.min) { this.error(field, `${what} cannot be below ${opts.min.toLocaleString()}`); return null; }
    if (opts.max !== undefined && n > opts.max) { this.error(field, `${what} cannot be above ${opts.max.toLocaleString()}`); return null; }
    return n;
  }
}

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.level === 'error');
export const errorCount = (issues: Issue[]): number => issues.filter((i) => i.level === 'error').length;

/** Border colour for a field: red for an error (once tried), amber for a warning. */
export function fieldStyle(issues: Issue[], field: string, tried: boolean): React.CSSProperties {
  const mine = issues.filter((i) => i.field === field);
  if (tried && mine.some((i) => i.level === 'error')) return { borderColor: '#ef4444', boxShadow: '0 0 0 1px #ef4444' };
  if (mine.some((i) => i.level === 'warning')) return { borderColor: '#F59E0B' };
  return {};
}
