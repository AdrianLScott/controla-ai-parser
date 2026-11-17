import { describe, expect, it, vi } from 'vitest';
import { parseSpend, type Completer } from '../src/parse.js';
import { toCents } from '../src/schema.js';

/** A fake model that always answers with `reply`, so tests run offline and deterministically. */
function fakeModel(reply: unknown) {
  return vi.fn<Completer>(async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)));
}

const uber = { is_expense: true, amount: 25, category: 'Transport', payment_method: 'Credit', description: 'Uber ride' };

describe('parseSpend', () => {
  it('returns a validated movement with the amount in cents', async () => {
    const result = await parseSpend('spent 25 on uber with credit', fakeModel(uber));
    expect(result).toEqual({
      ok: true,
      movement: { amount: 2500, category: 'Transport', payment_method: 'Credit', description: 'Uber ride' },
    });
  });

  it('never calls the model when a guard rejects the transcript', async () => {
    const model = fakeModel(uber);
    const result = await parseSpend('Subtítulos realizados por la comunidad de Amara.org', model);
    expect(result).toEqual({ ok: false, reason: 'known_hallucination' });
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects output that is not JSON', async () => {
    const result = await parseSpend('tacos 300', fakeModel('Sure! Here is your expense: tacos, 300'));
    expect(result).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('rejects a category outside the closed list', async () => {
    const result = await parseSpend('tacos 300', fakeModel({ ...uber, category: 'Groceries' }));
    expect(result).toMatchObject({ ok: false, reason: 'schema_violation' });
  });

  it('rejects a negative amount', async () => {
    const result = await parseSpend('tacos 300', fakeModel({ ...uber, amount: -300 }));
    expect(result).toMatchObject({ ok: false, reason: 'schema_violation' });
  });

  it('respects the model saying the text is not an expense', async () => {
    const result = await parseSpend(
      'hola probando probando',
      fakeModel({ is_expense: false, reason: 'microphone test' }),
    );
    expect(result).toEqual({ ok: false, reason: 'not_an_expense', detail: 'microphone test' });
  });
});

describe('toCents', () => {
  it.each([
    [25, 2500],
    [19.99, 1999], // 19.99 * 100 is 1998.9999... in floating point
    [345.5, 34550],
    [0, 0],
  ])('%d -> %d', (amount, cents) => {
    expect(toCents(amount)).toBe(cents);
  });
});
