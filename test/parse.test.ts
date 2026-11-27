import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { TokenLogprob } from '../src/confidence.js';
import { openAICompleter, parseSpend, type Completer } from '../src/parse.js';
import { toCents } from '../src/schema.js';
import { PROMPT_VERSION } from '../src/prompt.js';

/** A fake model that always answers with `reply`, so tests run offline and deterministically. */
function fakeModel(reply: unknown) {
  return vi.fn<Completer>(async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)));
}

const uber = { is_expense: true, amount: 25, category: 'Transport', payment_method: 'Credit', description: 'Uber ride' };

describe('parseSpend', () => {
  it('returns a validated movement with the amount in cents', async () => {
    const result = await parseSpend('spent 25 on uber with credit', fakeModel(uber), { today: '2026-11-26' });
    expect(result).toEqual({
      ok: true,
      movement: { amount: 2500, category: 'Transport', payment_method: 'Credit', description: 'Uber ride', date: '2026-11-26' },
      trace: { prompt_version: PROMPT_VERSION, today: '2026-11-26', completion: JSON.stringify(uber) },
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
    expect(result).toMatchObject({ ok: false, reason: 'not_an_expense', detail: 'microphone test' });
  });
});

/** Tokenizes `json` one value at a time, giving each listed value its probability (everything else p = 1). */
function withLogprobs(output: Record<string, unknown>, p: Record<string, number>, top: TokenLogprob['top'] = undefined) {
  const content = JSON.stringify(output);
  const logprobs: TokenLogprob[] = [];
  let rest = content;
  for (const [key, value] of Object.entries(output)) {
    const literal = typeof value === 'string' ? value : JSON.stringify(value);
    const at = rest.indexOf(literal, rest.indexOf(`"${key}"`) + key.length + 2);
    logprobs.push({ token: rest.slice(0, at), logprob: 0 });
    logprobs.push({ token: literal, logprob: Math.log(p[key] ?? 1), ...(key === 'category' && top ? { top } : {}) });
    rest = rest.slice(at + literal.length);
  }
  logprobs.push({ token: rest, logprob: 0 });
  return vi.fn<Completer>(async () => ({ content, logprobs }));
}

describe('parseSpend confidence', () => {
  const playa = { is_expense: true, amount: 500, category: 'Travel', payment_method: 'Cash', description: 'Ida a la playa' };

  it('adds nothing when the completer returns a plain string', async () => {
    const result = await parseSpend('ida a la playa 500', fakeModel(playa));
    expect(result).not.toHaveProperty('confidence');
    expect(result).not.toHaveProperty('needs_review');
  });

  it('returns per-field confidence and flags an unsure category', async () => {
    const top = [{ token: 'Travel', logprob: Math.log(0.62) }, { token: 'Transport', logprob: Math.log(0.31) }];
    const result = await parseSpend('ida a la playa 500', withLogprobs(playa, { category: 0.62, amount: 0.97 }, top));
    if (!result.ok) throw new Error(result.reason);
    expect(result.confidence?.fields.category?.p).toBeCloseTo(0.62);
    expect(result.confidence?.fields.category?.alternatives?.[0]?.value).toBe('Transport');
    expect(result.confidence?.fields.amount?.p).toBeCloseTo(0.97);
    expect(result.needs_review).toEqual(['category']);
  });

  it('flags nothing when the model is sure', async () => {
    const result = await parseSpend('tacos 300', withLogprobs({ ...playa, category: 'Food', amount: 300 }, { category: 0.99 }));
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('needs_review');
  });

  it('respects per-field thresholds', async () => {
    const result = await parseSpend('ida a la playa 500', withLogprobs(playa, { category: 0.62 }), { reviewBelow: { category: 0.5 } });
    expect(result).not.toHaveProperty('needs_review');
    const strict = await parseSpend('ida a la playa 500', withLogprobs(playa, { category: 0.95 }), { reviewBelow: { category: 0.99 } });
    expect(strict).toMatchObject({ needs_review: ['category'] });
  });

  it('never flags the description by default', async () => {
    const result = await parseSpend('ida a la playa 500', withLogprobs(playa, { description: 0.1 }));
    expect(result).not.toHaveProperty('needs_review');
  });

  it('always flags Other: the model is confident about its fallback even when it did not know', async () => {
    const result = await parseSpend('regalo para mi mamá 600', withLogprobs({ ...playa, amount: 600, category: 'Other' }, { category: 0.99 }));
    expect(result).toMatchObject({ ok: true, needs_review: ['category'] });
  });

  it('ignores an unsure first word unless it is very unsure (capitalization doubt)', async () => {
    const transcript: TokenLogprob[] = [{ token: 'Cine', logprob: Math.log(0.24) }, { token: ' trescientos', logprob: Math.log(0.99) }];
    const result = await parseSpend('Tacos trescientos', withLogprobs({ ...playa, category: 'Food', amount: 300 }, {}), { transcript });
    expect(result).toMatchObject({ ok: true, transcript_uncertain: false });
    expect(result).not.toHaveProperty('needs_review');
  });

  it('always flags a missing amount', async () => {
    const result = await parseSpend('spent some money on coffee', fakeModel({ ...playa, amount: 0, category: 'Food' }));
    expect(result).toMatchObject({ ok: true, needs_review: ['amount'] });
  });

  it('flags the amount when the transcript is shaky and the amount was not heard as digits', async () => {
    const transcript: TokenLogprob[] = [
      { token: 'T', logprob: Math.log(0.9) },
      { token: 'uve', logprob: Math.log(0.6) },
      { token: ' lipis', logprob: Math.log(0.2) },
      { token: ' doscientos treinta', logprob: Math.log(0.95) },
    ];
    const food = { ...playa, amount: 230, category: 'Food', description: 'Lipis' };
    const result = await parseSpend('Tuve lipis doscientos treinta', withLogprobs(food, {}), { transcript });
    expect(result).toMatchObject({ ok: true, transcript_uncertain: true });
    if (result.ok) expect(result.needs_review?.sort()).toEqual(['amount', 'category']);
    if (result.ok) expect(result.confidence?.transcript?.uncertain.map((w) => w.text)).toEqual(['lipis']);
  });

  it('flags only the amount when the unsure word is a number', async () => {
    const transcript: TokenLogprob[] = [{ token: 'Pay', logprob: Math.log(0.95) }, { token: ' the bill', logprob: Math.log(0.99) }, { token: ' 850', logprob: Math.log(0.22) }];
    const bill = { ...playa, amount: 850, category: 'Utilities' };
    const result = await parseSpend('Pay the bill 850', withLogprobs(bill, {}), { transcript });
    expect(result).toMatchObject({ ok: true, transcript_uncertain: true, needs_review: ['amount'] });
  });

  it('does not flag a clear transcript', async () => {
    const transcript: TokenLogprob[] = [{ token: 'tacos', logprob: Math.log(0.98) }, { token: ' 300', logprob: Math.log(0.97) }];
    const result = await parseSpend('tacos 300', withLogprobs({ ...playa, category: 'Food', amount: 300 }, {}), { transcript });
    expect(result).toMatchObject({ ok: true, transcript_uncertain: false });
    expect(result).not.toHaveProperty('needs_review');
  });
});

describe('openAICompleter', () => {
  it('asks for logprobs and returns them with the content', async () => {
    const create = vi.fn(async (_req: Record<string, unknown>) => ({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [
        {
          message: { content: '{"amount":1}' },
          logprobs: { content: [{ token: '{"amount":1}', logprob: -0.1, bytes: null, top_logprobs: [{ token: '{"amount":1}', logprob: -0.1, bytes: null }] }] },
        },
      ],
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const answer = await openAICompleter(client)('system', 'user');
    expect(create.mock.calls[0]?.[0]).toMatchObject({ logprobs: true, top_logprobs: 5 });
    expect(answer).toEqual({
      content: '{"amount":1}',
      logprobs: [{ token: '{"amount":1}', logprob: -0.1, bytes: null, top: [{ token: '{"amount":1}', logprob: -0.1, bytes: null }] }],
      model: 'gpt-4o-mini-2024-07-18',
    });
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

describe('parseSpend dates', () => {
  const today = '2026-11-26';
  const tacos = { is_expense: true, amount: 120, category: 'Food', payment_method: 'Cash', description: 'Tacos' };

  it('uses today when no date was said', async () => {
    for (const date of [undefined, null]) {
      const result = await parseSpend('tacos 120', fakeModel({ ...tacos, date }), { today });
      expect(result).toMatchObject({ ok: true, movement: { date: today } });
      expect(result).not.toHaveProperty('needs_review');
    }
  });

  it("keeps the model's date and sends it the calendar", async () => {
    const model = fakeModel({ ...tacos, date: '2026-11-25' });
    const result = await parseSpend('ayer tacos 120', model, { today });
    expect(result).toMatchObject({ ok: true, movement: { date: '2026-11-25' } });
    expect(result).not.toHaveProperty('needs_review');
    expect(model.mock.calls[0]![0]).toContain('2026-11-25  miércoles / Wednesday  (ayer / yesterday)');
  });

  it('replaces a day that does not exist with today, and flags it', async () => {
    const result = await parseSpend('tacos 120', fakeModel({ ...tacos, date: '2026-02-30' }), { today });
    expect(result).toMatchObject({ ok: true, movement: { date: today }, needs_review: ['date'] });
  });

  it('rejects a future date: only money already spent is recorded', async () => {
    const result = await parseSpend('mañana pago el internet 600', fakeModel({ ...tacos, date: '2026-11-27' }), { today });
    expect(result).toMatchObject({ ok: false, reason: 'future_date', detail: '2026-11-27', trace: { today } });
  });

  it('flags dates over a year old', async () => {
    const result = await parseSpend('tacos 120', fakeModel({ ...tacos, date: '2025-11-24' }), { today });
    expect(result).toMatchObject({ ok: true, movement: { date: '2025-11-24' }, needs_review: ['date'] });
    const lastYear = await parseSpend('tacos 120', fakeModel({ ...tacos, date: '2025-11-26' }), { today });
    expect(lastYear).not.toHaveProperty('needs_review');
  });

  it('rejects a malformed date as a schema violation', async () => {
    const result = await parseSpend('tacos 120', fakeModel({ ...tacos, date: 'ayer' }), { today });
    expect(result).toMatchObject({ ok: false, reason: 'schema_violation' });
  });

  it('throws on an invalid today (a caller bug)', async () => {
    await expect(parseSpend('tacos 120', fakeModel(tacos), { today: '26/11/2026' })).rejects.toThrow(/today/);
  });

  it('scores the date and flags an unsure one', async () => {
    const result = await parseSpend('el lunes tacos 120', withLogprobs({ ...tacos, date: '2026-11-23' }, { date: 0.55 }), { today });
    if (!result.ok) throw new Error(result.reason);
    expect(result.confidence?.fields.date?.p).toBeCloseTo(0.55);
    expect(result.needs_review).toEqual(['date']);
  });

  it('gives no date confidence when the date is null', async () => {
    const result = await parseSpend('tacos 120', withLogprobs({ ...tacos, date: null }, {}), { today });
    if (!result.ok) throw new Error(result.reason);
    expect(result.confidence?.fields).not.toHaveProperty('date');
  });
});

describe('parseSpend trace', () => {
  const today = '2026-11-26';
  const tacos = { is_expense: true, amount: 120, category: 'Food', payment_method: 'Cash', description: 'Tacos' };

  it('returns the raw output, logprobs and model whenever the model was called', async () => {
    const logprobs: TokenLogprob[] = [{ token: '{}', logprob: -0.01, top: [{ token: '{}', logprob: -0.01 }] }];
    const content = JSON.stringify(tacos);
    const model = vi.fn<Completer>(async () => ({ content, logprobs, model: 'gpt-4o-mini-2024-07-18' }));
    const result = await parseSpend('tacos 120', model, { today });
    expect(result.trace).toEqual({ prompt_version: PROMPT_VERSION, today, model: 'gpt-4o-mini-2024-07-18', completion: content, logprobs });
  });

  it('keeps the trace on rejections made by the model or by validation', async () => {
    const notExpense = await parseSpend('hola probando', fakeModel({ is_expense: false, reason: 'test' }), { today });
    expect(notExpense).toMatchObject({ ok: false, trace: { completion: '{"is_expense":false,"reason":"test"}' } });
    const badJson = await parseSpend('tacos 120', fakeModel('not json'), { today });
    expect(badJson).toMatchObject({ ok: false, reason: 'invalid_json', trace: { completion: 'not json' } });
    const badSchema = await parseSpend('tacos 120', fakeModel({ ...tacos, category: 'Groceries' }), { today });
    expect(badSchema).toMatchObject({ ok: false, reason: 'schema_violation', trace: { today } });
  });

  it('has no trace when a guard rejected before any model call', async () => {
    const result = await parseSpend('Subtítulos realizados por la comunidad de Amara.org', fakeModel(tacos), { today });
    expect(result).toEqual({ ok: false, reason: 'known_hallucination' });
  });
});
