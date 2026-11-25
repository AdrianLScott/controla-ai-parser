import { describe, expect, it } from 'vitest';
import { loadCases } from '../evals/cases.js';
import type { EvalCase } from '../evals/cases.js';
import { fieldInstances, scoreCase, suggestThreshold, thresholdTable } from '../evals/score.js';
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

describe('confidence scoring', () => {
  const c: EvalCase = { id: 'playa', input: 'ida a la playa 500', tags: [], expect: { amount: 50000, category: 'Travel', payment_method: 'Cash' } };
  const movement = { amount: 50000, category: 'Transport' as const, payment_method: 'Cash' as const, description: 'Playa' };
  const fields = { amount: { p: 0.99 }, category: { p: 0.55 }, payment_method: { p: 0.9 } };

  it('marks each field with its probability and correctness', () => {
    const list = fieldInstances(c, { ok: true, movement, confidence: { fields } });
    expect(list).toEqual([
      { id: 'playa', field: 'amount', value: '50000', p: 0.99, correct: true },
      { id: 'playa', field: 'category', value: 'Transport', p: 0.55, correct: false },
      { id: 'playa', field: 'payment_method', value: 'Cash', p: 0.9, correct: true },
    ]);
  });

  it('counts false alarms and caught errors per threshold, and suggests one', () => {
    const list = fieldInstances(c, { ok: true, movement, confidence: { fields } });
    expect(thresholdTable(list).find((r) => r.threshold === 0.6)).toEqual({ threshold: 0.6, falseAlarms: 0, correct: 2, caught: 1, wrong: 1 });
    expect(suggestThreshold(list)).toBe(0.9);
  });
});
