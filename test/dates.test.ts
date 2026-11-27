import { describe, expect, it } from 'vitest';
import { addDays, dateContext, daysBetween, isIsoDate, utcToday } from '../src/dates.js';
import { systemPrompt, SYSTEM_PROMPT } from '../src/prompt.js';

describe('dates', () => {
  it('accepts only real calendar days', () => {
    expect(isIsoDate('2026-11-26')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-11-2026')).toBe(false);
    expect(isIsoDate('ayer')).toBe(false);
  });

  it('does day arithmetic across month and year boundaries', () => {
    expect(addDays('2026-12-01', -1)).toBe('2026-11-30');
    expect(addDays('2027-01-02', -3)).toBe('2026-12-30');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-11-23', '2026-11-26')).toBe(3);
    expect(daysBetween('2026-11-27', '2026-11-26')).toBe(-1);
  });

  it('takes the UTC date as a fallback', () => {
    expect(utcToday(new Date('2026-11-27T01:30:00Z'))).toBe('2026-11-27');
  });

  it('builds a calendar of today and the previous week, with weekdays in both languages', () => {
    const ctx = dateContext('2026-11-26');
    const lines = ctx.split('\n').slice(1);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('  2026-11-26  jueves / Thursday  (hoy / today)');
    expect(lines[1]).toBe('  2026-11-25  miércoles / Wednesday  (ayer / yesterday)');
    expect(lines[3]).toBe('  2026-11-23  lunes / Monday');
    expect(lines[7]).toBe('  2026-11-19  jueves / Thursday');
  });

  it('crosses the year in the calendar', () => {
    expect(dateContext('2027-01-02')).toContain('2026-12-31  jueves / Thursday');
  });

  it('rejects a bad today', () => {
    expect(() => dateContext('2026-02-30')).toThrow();
  });

  it('appends the calendar to the static prompt', () => {
    expect(systemPrompt('2026-11-26').startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt('2026-11-26')).toContain('2026-11-26  jueves / Thursday');
  });
});
