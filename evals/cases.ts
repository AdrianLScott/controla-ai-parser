import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CATEGORIES, PAYMENT_METHODS } from '../src/schema.js';

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  tags: z.array(z.string()),
  expect: z.union([
    z.object({ reject: z.literal(true) }),
    z.object({
      amount: z.number().int().nonnegative(), // cents
      category: z.enum(CATEGORIES),
      payment_method: z.enum(PAYMENT_METHODS),
    }),
  ]),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export function loadCases(path = new URL('./cases.json', import.meta.url)): EvalCase[] {
  return z.array(EvalCaseSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
}
