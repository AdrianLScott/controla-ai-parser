/**
 * Calendar-day helpers. Dates are plain `YYYY-MM-DD` strings with no time or time zone: the caller decides what
 * "today" is for the user (see `ParseOptions.today`), and the parser only does day arithmetic on it, in UTC.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Days shown before today in the prompt's calendar: enough for "el lunes" or "last Friday". */
const CALENDAR_DAYS = 7;

function toUtc(date: string): Date | undefined {
  const m = ISO_DATE.exec(date);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Rejects days that don't exist (2026-02-30 would roll over to March 2).
  return d.toISOString().slice(0, 10) === date ? d : undefined;
}

/** True for a real calendar day in `YYYY-MM-DD` form. */
export function isIsoDate(date: string): boolean {
  return toUtc(date) !== undefined;
}

/** The current UTC date. Only a fallback: the user's local date is often different. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  if (!d) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = toUtc(from);
  const b = toUtc(to);
  if (!a || !b) throw new Error(`Not a YYYY-MM-DD date: ${!a ? from : to}`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function weekday(date: string): number {
  return toUtc(date)!.getUTCDay();
}

/**
 * The date block appended to the system prompt: today plus the previous week, each day with its weekday in Spanish
 * and English. The model looks a date up here instead of counting backwards, which small models get wrong.
 */
export function dateContext(today: string): string {
  if (!isIsoDate(today)) throw new Error(`Not a YYYY-MM-DD date: ${today}`);
  const labels = ['hoy / today', 'ayer / yesterday', 'antier / day before yesterday'];
  const lines: string[] = [];
  for (let i = 0; i <= CALENDAR_DAYS; i++) {
    const day = addDays(today, -i);
    const w = weekday(day);
    const label = labels[i] ? `  (${labels[i]})` : '';
    lines.push(`  ${day}  ${WEEKDAYS_ES[w]} / ${WEEKDAYS_EN[w]}${label}`);
  }
  return `Calendar (the user's local dates, most recent first):\n${lines.join('\n')}`;
}
