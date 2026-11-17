import type { ParseResult } from '../src/parse.js';
import type { EvalCase } from './cases.js';

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
