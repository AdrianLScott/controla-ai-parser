import { describe, expect, it } from 'vitest';
import { fieldConfidence, transcriptConfidence, valueSpans, type TokenLogprob } from '../src/confidence.js';

const lp = (p: number) => Math.log(p);

/** Tokens from (text, p) pairs, with optional top alternatives as (text, p) pairs. */
function tokens(...parts: [string, number, [string, number][]?][]): TokenLogprob[] {
  return parts.map(([token, p, top]) => ({
    token,
    logprob: lp(p),
    ...(top ? { top: top.map(([t, q]) => ({ token: t, logprob: lp(q) })) } : {}),
  }));
}

/** Splits a string's UTF-8 bytes at `at`, the way a tokenizer can cut a multi-byte character in half. */
function splitBytes(text: string, at: number, p: [number, number]): TokenLogprob[] {
  const b = Buffer.from(text, 'utf8');
  return [
    { token: b.subarray(0, at).toString('utf8'), bytes: [...b.subarray(0, at)], logprob: lp(p[0]) },
    { token: b.subarray(at).toString('utf8'), bytes: [...b.subarray(at)], logprob: lp(p[1]) },
  ];
}

const raw = '{"is_expense":true,"amount":500,"category":"Travel","payment_method":"Cash","description":"Ida a la playa"}';
const playa = tokens(
  ['{"', 1],
  ['is', 1],
  ['_expense', 1],
  ['":', 1],
  ['true', 0.99],
  [',"', 1],
  ['amount', 1],
  ['":', 1],
  ['500', 0.97],
  [',"', 1],
  ['category', 1],
  ['":"', 1],
  ['Travel', 0.62, [['Travel', 0.62], ['Transport', 0.31], ['Other', 0.05]]],
  ['","', 1],
  ['payment', 1],
  ['_method', 1],
  ['":"', 1],
  ['Cash', 0.9],
  ['","', 1],
  ['description', 1],
  ['":"', 1],
  ['Ida', 0.8],
  [' a', 0.9],
  [' la', 0.9],
  [' playa', 0.9],
  ['"}', 1],
);

describe('valueSpans', () => {
  const text = (s: string, span: { start: number; end: number }) =>
    Buffer.from(s, 'utf8').subarray(span.start, span.end).toString('utf8');

  it('finds string contents and bare values', () => {
    const spans = valueSpans(raw);
    expect(text(raw, spans.category!)).toBe('Travel');
    expect(text(raw, spans.amount!)).toBe('500');
    expect(text(raw, spans.is_expense!)).toBe('true');
  });

  it('handles escapes, pretty-printing and any key order', () => {
    const s = '{\n  "description": "Caf\\u00e9 \\"bueno\\"",\n  "amount" : 85.5,\n  "category": "Food"\n}';
    const spans = valueSpans(s);
    expect(text(s, spans.description!)).toBe('Caf\\u00e9 \\"bueno\\"');
    expect(text(s, spans.amount!)).toBe('85.5');
    expect(text(s, spans.category!)).toBe('Food');
  });

  it('uses byte offsets after multi-byte characters', () => {
    const s = '{"description":"Café","amount":85}';
    expect(text(s, valueSpans(s).amount!)).toBe('85');
  });
});

describe('fieldConfidence', () => {
  it('scores every field and lists the category alternatives', () => {
    const f = fieldConfidence(raw, playa);
    expect(f.category?.p).toBeCloseTo(0.62);
    expect(f.category?.alternatives).toEqual([
      { value: 'Transport', p: expect.closeTo(0.31) },
      { value: 'Other', p: expect.closeTo(0.05) },
    ]);
    expect(f.amount?.p).toBeCloseTo(0.97);
    expect(f.payment_method?.p).toBeCloseTo(0.9);
    expect(f.is_expense?.p).toBeCloseTo(0.99);
    // geometric mean of 0.8, 0.9, 0.9, 0.9
    expect(f.description?.p).toBeCloseTo(Math.exp((lp(0.8) + 3 * lp(0.9)) / 4));
  });

  it('puts a prefix shared by several values in unresolved', () => {
    const r = '{"category":"Transport"}';
    const t = tokens(['{"', 1], ['category', 1], ['":"', 1], ['Tra', 0.7, [['Tra', 0.7], ['Food', 0.2]]], ['nsport', 0.95], ['"}', 1]);
    const f = fieldConfidence(r, t);
    expect(f.category?.p).toBeCloseTo(0.7 * 0.95);
    expect(f.category?.alternatives).toEqual([{ value: 'Food', p: expect.closeTo(0.2) }]);
    expect(f.category?.unresolved).toBeCloseTo(0.7);
  });

  it('uses the text before the decision token to resolve alternatives', () => {
    const r = '{"category":"Transport"}';
    const t = tokens(['{"', 1], ['category', 1], ['":"', 1], ['Tra', 0.99], ['nsport', 0.6, [['nsport', 0.6], ['vel', 0.4]]], ['"}', 1]);
    expect(fieldConfidence(r, t).category?.alternatives).toEqual([{ value: 'Travel', p: expect.closeTo(0.4) }]);
  });

  it('ignores trailing decimal zeros in the amount', () => {
    const r = '{"amount":345.50}';
    const t = tokens(['{"', 1], ['amount', 1], ['":', 1], ['345', 0.9], ['.', 0.95], ['5', 0.9], ['0', 0.3], ['}', 1]);
    expect(fieldConfidence(r, t).amount?.p).toBeCloseTo(0.9 * 0.95 * 0.9);
  });

  it('omits the amount when it is 0 (flagged by rule instead)', () => {
    const r = '{"amount":0}';
    expect(fieldConfidence(r, tokens(['{"amount":', 1], ['0', 0.99], ['}', 1])).amount).toBeUndefined();
  });

  it('maps tokens that split an accented character', () => {
    const r = '{"category":"Food","description":"Café"}';
    const t: TokenLogprob[] = [
      ...tokens(['{"', 1], ['category', 1], ['":"', 1], ['Food', 0.95], ['","', 1], ['description', 1], ['":"', 1]),
      ...splitBytes('Café', 4, [0.9, 0.8]), // "Caf" + half of "é", then the other half
      ...tokens(['"}', 1]),
    ];
    const f = fieldConfidence(r, t);
    expect(f.description?.p).toBeCloseTo(Math.sqrt(0.9 * 0.8));
    expect(f.category?.p).toBeCloseTo(0.95);
  });

  it('drops only the fields after tokens stop matching the text', () => {
    const r = '{"category":"Food","description":"Tacos"}';
    const t = tokens(['{"', 1], ['category', 1], ['":"', 1], ['Food', 0.95], ['","', 1], ['description', 1], ['":"', 1], ['Burritos', 0.5]);
    const f = fieldConfidence(r, t);
    expect(f.category?.p).toBeCloseTo(0.95);
    expect(f.description).toBeUndefined();
  });

  it('returns nothing for output that is not an object', () => {
    expect(fieldConfidence('nope', tokens(['nope', 1]))).toEqual({});
  });
});

describe('transcriptConfidence', () => {
  const heard = tokens(['T', 0.9], ['uve', 0.6], [' l', 0.4], ['ipis', 0.5], [' dos', 0.95], ['cientos', 0.98], [' treinta', 0.97], ['.', 0.99]);

  it('groups tokens into words and lists the unsure ones', () => {
    const t = transcriptConfidence(heard, 0.5)!;
    expect(t.uncertain).toEqual([{ text: 'lipis', p: expect.closeTo(0.2) }]);
    expect(t.p).toBeGreaterThan(0.6);
    expect(t.p).toBeLessThan(0.9);
  });

  it('uses a separate threshold for the first word (capitalization doubt)', () => {
    const t = tokens(['C', 0.5], ['ine', 0.5], [' con', 0.99], [' mi', 0.2]);
    expect(transcriptConfidence(t, 0.3, 0.1)!.uncertain.map((w) => w.text)).toEqual(['mi']); // Cine 25% is kept
    expect(transcriptConfidence(tokens(['TV', 0.02], ['ips', 0.5], [' 230', 0.99]), 0.3, 0.1)!.uncertain.map((w) => w.text)).toEqual(['TVips']);
  });

  it('reassembles words split inside a multi-byte character', () => {
    const t = transcriptConfidence([...tokens([' farmacia', 0.9]), ...splitBytes(' más', 3, [0.6, 0.5])], 0.5)!;
    expect(t.uncertain).toEqual([{ text: 'más', p: expect.closeTo(0.3) }]);
  });

  it('ignores punctuation-only words and empty input', () => {
    expect(transcriptConfidence(tokens(['hola', 0.99], [' ?', 0.1]), 0.5)!.uncertain).toEqual([]);
    expect(transcriptConfidence([], 0.5)).toBeUndefined();
  });
});
