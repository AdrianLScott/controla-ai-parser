/**
 * Confidence from logprobs: the probabilities the model itself assigned to the tokens it wrote.
 *
 * Two sources:
 * - the parse call's JSON output, mapped back to each field's value (`fieldConfidence`);
 * - the transcription, word by word (`transcriptConfidence`), which catches mishearings the parser can't see.
 *
 * Everything here is best effort: when tokens can't be lined up with the output, that field simply has no
 * confidence. It never causes a rejection.
 */
import { CATEGORIES, PAYMENT_METHODS } from './schema.js';

export interface TopLogprob {
  token: string;
  logprob: number;
  /** UTF-8 bytes of the token. A token can hold half of a multi-byte character ("á"), so offsets use bytes. */
  bytes?: number[] | null;
}

export interface TokenLogprob extends TopLogprob {
  /** The most likely tokens at this position (including the one chosen). */
  top?: TopLogprob[];
}

/** Movement fields a reviewer can be asked about. Maps 1:1 to `Movement` keys. */
export type Field = 'amount' | 'category' | 'payment_method' | 'description' | 'date';
export type ScoredField = Field | 'is_expense';

export interface FieldConfidence {
  /** Probability the model gave this value, 0..1. */
  p: number;
  /**
   * Other values the model considered (enum fields only), most likely first. Their `p` is the probability of the
   * token where the model hesitated, so a prefix probability, not a full joint.
   */
  alternatives?: { value: string; p: number }[];
  /** Probability mass at that token that couldn't be pinned to a single value (e.g. "Tra": Travel or Transport). */
  unresolved?: number;
}

export interface TranscriptConfidence {
  /** Geometric mean of the token probabilities over the whole transcript. */
  p: number;
  /** Words the transcription model was unsure of, e.g. `{ text: 'lipis', p: 0.21 }`. */
  uncertain: { text: string; p: number }[];
}

export interface Confidence {
  fields: Partial<Record<ScoredField, FieldConfidence>>;
  transcript?: TranscriptConfidence;
}

const ENUMS: Partial<Record<ScoredField, readonly string[]>> = {
  category: CATEGORIES,
  payment_method: PAYMENT_METHODS,
};

const bytesOf = (t: TopLogprob): Buffer => (t.bytes ? Buffer.from(t.bytes) : Buffer.from(t.token, 'utf8'));

/** A value's byte range in the raw output. For strings, the range is the content between the quotes. */
interface Span {
  start: number;
  end: number;
}

/**
 * Byte spans of each top-level value in a JSON object. A tiny lexer rather than a regex, so escapes (`\"`, `á`),
 * whitespace and key order don't matter. Returns {} if the text isn't a flat-enough object.
 */
export function valueSpans(raw: string): Record<string, Span> {
  const spans: Record<string, Span> = {};
  let i = 0;
  const ws = () => {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
  };
  const readString = (): { start: number; end: number; text: string } | undefined => {
    if (raw[i] !== '"') return undefined;
    const start = ++i;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    if (i >= raw.length) return undefined;
    const end = i++;
    return { start, end, text: raw.slice(start, end) };
  };
  const skipNested = (): boolean => {
    let depth = 0;
    while (i < raw.length) {
      const c = raw[i]!;
      if (c === '"') {
        if (!readString()) return false;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
      i++;
      if (depth === 0) return true;
    }
    return false;
  };
  const byteAt = (charIndex: number) => Buffer.byteLength(raw.slice(0, charIndex), 'utf8');

  ws();
  if (raw[i] !== '{') return {};
  i++;
  while (i < raw.length) {
    ws();
    if (raw[i] === '}') break;
    const key = readString();
    if (!key) return spans;
    ws();
    if (raw[i] !== ':') return spans;
    i++;
    ws();
    let start: number;
    let end: number;
    if (raw[i] === '"') {
      const value = readString();
      if (!value) return spans;
      ({ start, end } = value);
    } else if (raw[i] === '{' || raw[i] === '[') {
      start = i;
      if (!skipNested()) return spans;
      end = i;
    } else {
      start = i;
      while (i < raw.length && !/[\s,}]/.test(raw[i]!)) i++;
      end = i;
    }
    spans[key.text] = { start: byteAt(start), end: byteAt(end) };
    ws();
    if (raw[i] === ',') i++;
  }
  return spans;
}

/** Tokens with their byte offsets, up to the first byte where the tokens stop matching the raw output. */
function alignTokens(raw: string, tokens: TokenLogprob[]) {
  const rawBytes = Buffer.from(raw, 'utf8');
  const aligned: { token: TokenLogprob; start: number; end: number }[] = [];
  let offset = 0;
  for (const token of tokens) {
    const b = bytesOf(token);
    if (!rawBytes.subarray(offset, offset + b.length).equals(b)) break; // tokens and text diverge from here on
    aligned.push({ token, start: offset, end: offset + b.length });
    offset += b.length;
  }
  return { aligned, validUntil: offset };
}

/** Significant part of a number: "345.50" → "345.5", "25.0" → "25". Trailing zeros only split probability mass. */
function significantEnd(raw: Buffer, span: Span): number {
  const text = raw.subarray(span.start, span.end).toString('utf8');
  if (!text.includes('.')) return span.end;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return span.start + Buffer.byteLength(trimmed, 'utf8');
}

/** Strip JSON punctuation and whitespace around a token: `":"Travel` → `Travel`. */
const clean = (s: string) => s.replace(/^[\s":,{]+/, '').replace(/[\s":,}]+$/, '');

function alternatives(
  values: readonly string[],
  chosen: string,
  prefix: string,
  decision: TokenLogprob,
): Pick<FieldConfidence, 'alternatives' | 'unresolved'> {
  const mass = new Map<string, number>();
  let unresolved = 0;
  for (const top of decision.top ?? []) {
    const candidate = prefix + clean(top.token);
    const p = Math.exp(top.logprob);
    const matches = candidate ? values.filter((v) => v.startsWith(candidate)) : [];
    if (matches.length === 1) mass.set(matches[0]!, (mass.get(matches[0]!) ?? 0) + p);
    else unresolved += p;
  }
  mass.delete(chosen);
  const list = [...mass].map(([value, p]) => ({ value, p })).sort((a, b) => b.p - a.p);
  return {
    ...(list.length ? { alternatives: list } : {}),
    ...(unresolved > 0.001 ? { unresolved } : {}),
  };
}

/**
 * Per-field confidence for the model's JSON output.
 * - enum fields and `is_expense`: joint probability of the value's tokens, plus alternatives for enums;
 * - `amount`: joint probability of its significant digits (omitted when the amount is 0: that's flagged by rule);
 * - `date`: joint probability of the whole `YYYY-MM-DD` (omitted when null: no date was said);
 * - `description`: geometric mean, since a joint probability always shrinks as text gets longer.
 */
export function fieldConfidence(raw: string, tokens: TokenLogprob[]): Confidence['fields'] {
  const rawBytes = Buffer.from(raw, 'utf8');
  const spans = valueSpans(raw);
  const { aligned, validUntil } = alignTokens(raw, tokens);
  const fields: Confidence['fields'] = {};

  for (const name of ['is_expense', 'amount', 'category', 'payment_method', 'description', 'date'] as const) {
    const span = spans[name];
    if (!span || span.end > validUntil || span.end <= span.start) continue;
    const valueText = rawBytes.subarray(span.start, span.end).toString('utf8');
    if (name === 'amount' && Number(valueText) === 0) continue;
    if (name === 'date' && valueText === 'null') continue;

    const end = name === 'amount' ? significantEnd(rawBytes, span) : span.end;
    const inside = aligned.filter((t) => t.start < end && t.end > span.start);
    if (inside.length === 0) continue;
    const sum = inside.reduce((s, t) => s + t.token.logprob, 0);

    if (name === 'description') {
      fields[name] = { p: Math.exp(sum / inside.length) };
      continue;
    }
    const conf: FieldConfidence = { p: Math.exp(sum) };
    const values = ENUMS[name];
    if (values) {
      const decision = inside.reduce((a, b) => (b.token.logprob < a.token.logprob ? b : a));
      const prefix = decision.start > span.start ? rawBytes.subarray(span.start, decision.start).toString('utf8') : '';
      Object.assign(conf, alternatives(values, valueText, prefix, decision.token));
    }
    fields[name] = conf;
  }
  return fields;
}

/**
 * Word-level confidence for a transcript. Tokens are grouped into words by their leading space; a word's `p` is the
 * joint probability of its tokens. Words below `below` are listed as uncertain.
 *
 * The first word gets its own, lower threshold: the model hesitates over its capitalization ("Cine" vs "cine"), so
 * correct first words often score 25–45%, while real mishearings there ("uvevip", "TVips") score under 5%.
 */
export function transcriptConfidence(
  tokens: TokenLogprob[],
  below: number,
  firstWordBelow = below,
): TranscriptConfidence | undefined {
  if (tokens.length === 0) return undefined;
  const words: { bytes: Buffer[]; logprob: number }[] = [];
  for (const token of tokens) {
    const b = bytesOf(token);
    const startsWord = words.length === 0 || /^\s/.test(b.toString('utf8'));
    if (startsWord) words.push({ bytes: [], logprob: 0 });
    const word = words[words.length - 1]!;
    word.bytes.push(b);
    word.logprob += token.logprob;
  }
  const mean = tokens.reduce((s, t) => s + t.logprob, 0) / tokens.length;
  const uncertain = words
    .map((w, i) => ({ text: Buffer.concat(w.bytes).toString('utf8').trim(), p: Math.exp(w.logprob), first: i === 0 }))
    .filter((w) => w.text && /[\p{L}\p{N}]/u.test(w.text) && w.p < (w.first ? firstWordBelow : below))
    .map(({ text, p }) => ({ text, p }));
  return { p: Math.exp(mean), uncertain };
}
