import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CATEGORIES, PAYMENT_METHODS } from '../src/schema.js';

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  tags: z.array(z.string()),
  /** The user's "today" for this case; defaults to {@link EVAL_TODAY}. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expect: z.union([
    z.object({ reject: z.literal(true) }),
    z.object({
      amount: z.number().int().nonnegative(), // cents
      category: z.enum(CATEGORIES),
      payment_method: z.enum(PAYMENT_METHODS),
      /** Expected spend date; defaults to the case's today, so every case also checks no date is invented. */
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  ]),
});

/** Fixed "today" for every run (a Thursday), so relative dates have one right answer. */
export const EVAL_TODAY = '2026-11-26';

export const todayFor = (c: { today?: string }) => c.today ?? EVAL_TODAY;

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export function loadCases(path = new URL('./cases.json', import.meta.url)): EvalCase[] {
  return z.array(EvalCaseSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
}
