import { describe, expect, it } from 'vitest';
import { loadCases } from '../evals/cases.js';
import type { EvalCase } from '../evals/cases.js';
import { scoreCase } from '../evals/score.js';
import { checkTranscript } from '../src/guards.js';

describe('eval set', () => {
  const cases = loadCases();

  it('is well-formed and has unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('covers both expenses and rejections', () => {
    expect(cases.some((c) => 'reject' in c.expect)).toBe(true);
    expect(cases.some((c) => !('reject' in c.expect))).toBe(true);
  });

  it('expects every hallucination case to be caught by the guards alone, before any model call', () => {
    for (const c of cases.filter((c) => c.tags.includes('hallucination'))) {
      expect(checkTranscript(c.input).ok, c.id).toBe(false);
    }
  });
});

describe('scoreCase', () => {
  const c: EvalCase = {
    id: 't',
    input: 'tacos 300',
    tags: [],
    expect: { amount: 30000, category: 'Food', payment_method: 'Cash' },
  };

  it('passes an exact match', () => {
    const r = scoreCase(c, {
      ok: true,
      movement: { amount: 30000, category: 'Food', payment_method: 'Cash', description: 'Tacos' },
    });
    expect(r.pass).toBe(true);
  });

  it('lists every field that is wrong', () => {
    const r = scoreCase(c, {
      ok: true,
      movement: { amount: 300, category: 'Shopping', payment_method: 'Cash', description: 'Tacos' },
    });
    expect(r.failures).toEqual(['amount: got 300, want 30000', 'category: got Shopping, want Food']);
  });
});
