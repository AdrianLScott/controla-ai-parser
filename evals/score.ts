import type { ParseResult } from '../src/parse.js';
import { todayFor, type EvalCase } from './cases.js';

export interface CaseScore {
  id: string;
  pass: boolean;
  /** Which checks failed, e.g. ["category: got Shopping, want Food"]. Empty when passing. */
  failures: string[];
  tags: string[];
}

export function scoreCase(c: EvalCase, result: ParseResult): CaseScore {
  const failures: string[] = [];

  if ('reject' in c.expect) {
    if (result.ok) failures.push(`expected a rejection, got ${JSON.stringify(result.movement)}`);
  } else if (!result.ok) {
    failures.push(`rejected (${result.reason}${result.detail ? `: ${result.detail}` : ''})`);
  } else {
    const got = result.movement;
    const want = c.expect;
    if (got.amount !== want.amount) failures.push(`amount: got ${got.amount}, want ${want.amount}`);
    if (got.category !== want.category) failures.push(`category: got ${got.category}, want ${want.category}`);
    if (got.payment_method !== want.payment_method)
      failures.push(`payment_method: got ${got.payment_method}, want ${want.payment_method}`);
    const date = want.date ?? todayFor(c);
    if (got.date !== date) failures.push(`date: got ${got.date}, want ${date}`);
  }

  return { id: c.id, pass: failures.length === 0, failures, tags: c.tags };
}

/** Pass rate per tag, so a regression in e.g. "words" or "hallucination" is visible at a glance. */
export function byTag(scores: CaseScore[]): Record<string, { pass: number; total: number }> {
  const out: Record<string, { pass: number; total: number }> = {};
  for (const s of scores) {
    for (const t of s.tags) {
      const bucket = (out[t] ??= { pass: 0, total: 0 });
      bucket.total++;
      if (s.pass) bucket.pass++;
    }
  }
  return out;
}

/** Fields whose confidence the eval can check against an expected value. */
export const CHECKED_FIELDS = ['amount', 'category', 'payment_method', 'date'] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];

export interface FieldInstance {
  id: string;
  field: CheckedField;
  value: string;
  p: number;
  correct: boolean;
}

/** One entry per scored field of a parsed expense, with the model's probability and whether the value was right. */
export function fieldInstances(c: EvalCase, result: ParseResult): FieldInstance[] {
  if ('reject' in c.expect || !result.ok || !result.confidence) return [];
  const want = c.expect;
  const got = result.movement;
  const out: FieldInstance[] = [];
  for (const field of CHECKED_FIELDS) {
    const p = result.confidence.fields[field]?.p;
    if (p === undefined) continue;
    const expected = field === 'date' ? (want.date ?? todayFor(c)) : want[field];
    out.push({ id: c.id, field, value: String(got[field]), p, correct: got[field] === expected });
  }
  return out;
}

export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const;

/** For each threshold: how many correct fields it would flag (false alarms) and how many wrong ones (caught). */
export function thresholdTable(instances: FieldInstance[]) {
  const correct = instances.filter((i) => i.correct);
  const wrong = instances.filter((i) => !i.correct);
  return THRESHOLDS.map((t) => ({
    threshold: t,
    falseAlarms: correct.filter((i) => i.p < t).length,
    correct: correct.length,
    caught: wrong.filter((i) => i.p < t).length,
    wrong: wrong.length,
  }));
}

/** Highest threshold that flags at most `maxFalseAlarmRate` of the correct fields. */
export function suggestThreshold(instances: FieldInstance[], maxFalseAlarmRate = 0.05): number | undefined {
  const ok = thresholdTable(instances).filter((r) => r.correct > 0 && r.falseAlarms / r.correct <= maxFalseAlarmRate);
  return ok.at(-1)?.threshold;
}
