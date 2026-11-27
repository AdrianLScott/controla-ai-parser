import OpenAI from 'openai';
import {
  fieldConfidence,
  transcriptConfidence,
  type Confidence,
  type Field,
  type TokenLogprob,
} from './confidence.js';
import { daysBetween, isIsoDate, utcToday } from './dates.js';
import { checkTranscript, type RejectReason } from './guards.js';
import { PROMPT_VERSION, systemPrompt } from './prompt.js';
import { ModelOutputSchema, toCents, type Movement } from './schema.js';

/** A model answer, optionally with the logprobs of the tokens it wrote. */
export interface Completion {
  content: string;
  logprobs?: TokenLogprob[];
  /** The exact model that answered (e.g. "gpt-4o-mini-2024-07-18"), for logging. */
  model?: string;
}

/**
 * What the model was given and said, raw, for storing as history. Present whenever the model was called, on success
 * and on rejections alike: with the logprobs, confidence can be recomputed later with different scoring.
 */
export interface Trace {
  prompt_version: string;
  /** The `today` the calendar in the prompt was built from. */
  today: string;
  model?: string;
  /** The model's raw output, before parsing. */
  completion: string;
  /** Every output token with its logprob and top alternatives, as the API returned them. */
  logprobs?: TokenLogprob[];
}

/**
 * Anything that can answer "system prompt + user text -> raw string".
 * Injected so tests run offline with a fake, and so the model can be swapped without touching parsing.
 * Returning a `Completion` with logprobs enables per-field confidence; a plain string still works.
 */
export type Completer = (system: string, user: string) => Promise<string | Completion>;

export type ParseResult =
  | {
      ok: true;
      movement: Movement;
      /** Model probabilities per field (and per transcript word), when logprobs were available. */
      confidence?: Confidence;
      /**
       * Fields worth confirming with the user: low confidence, missing amount, a shaky transcript, or a date that is
       * over a year old or not a real day.
       */
      needs_review?: Field[];
      /** The transcription model was unsure of at least one word (see `confidence.transcript.uncertain`). */
      transcript_uncertain?: boolean;
      trace?: Trace;
    }
  | { ok: false; reason: RejectReason; detail?: string; trace?: Trace };

export type ReviewThresholds = Partial<Record<Field | 'transcript' | 'transcript_first_word', number>>;

/**
 * A field is flagged when its probability is below these. `description` has none: its score is a weak signal.
 * Set from the eval runs (see README, "Confidence"): gpt-4o-mini is confident even when wrong, so the category
 * threshold is high. Transcript words are flagged under 30%; the first word under 10%, because the model hesitates
 * over its capitalization (correct first words scored 24–44%, mishearings there 0–3%).
 */
export const DEFAULT_REVIEW_BELOW: Readonly<ReviewThresholds> = {
  amount: 0.8,
  category: 0.9,
  payment_method: 0.8,
  date: 0.8,
  transcript: 0.3,
  transcript_first_word: 0.1,
};

export interface ParseOptions {
  /**
   * The user's local date, `YYYY-MM-DD`, used to resolve "ayer", "el lunes"… and as the date when none is said.
   * Defaults to the UTC date, which is wrong for part of every day outside UTC, so callers should pass it.
   */
  today?: string;
  /** Logprobs from `transcribe`, so mishearings can be flagged. */
  transcript?: TokenLogprob[];
  /** Per-field thresholds, merged over {@link DEFAULT_REVIEW_BELOW}. */
  reviewBelow?: ReviewThresholds;
}

export function openAICompleter(
  client: OpenAI = new OpenAI(),
  model = 'gpt-4o-mini',
): Completer {
  return async (system, user) => {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0, // same input -> same record
      max_tokens: 150,
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 5,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const choice = completion.choices[0];
    const logprobs = choice?.logprobs?.content?.map((t) => ({
      token: t.token,
      logprob: t.logprob,
      bytes: t.bytes,
      top: t.top_logprobs.map((x) => ({ token: x.token, logprob: x.logprob, bytes: x.bytes })),
    }));
    return { content: choice?.message?.content ?? '', ...(logprobs ? { logprobs } : {}), model: completion.model };
  };
}

/**
 * Text in, validated record (or an explicit rejection) out.
 * Model output is treated as untrusted input: it must parse, match a closed schema,
 * and claim to be an expense before anything is returned for storage.
 */
export async function parseSpend(text: string, complete: Completer, opts: ParseOptions = {}): Promise<ParseResult> {
  const today = opts.today ?? utcToday();
  if (!isIsoDate(today)) throw new Error(`parseSpend: today must be a YYYY-MM-DD date, got ${JSON.stringify(today)}`);

  const guard = checkTranscript(text);
  if (!guard.ok) return guard;

  const answer = await complete(systemPrompt(today), guard.text);
  const { content: raw, logprobs, model } =
    typeof answer === 'string' ? { content: answer, logprobs: undefined, model: undefined } : answer;
  const trace: Trace = {
    prompt_version: PROMPT_VERSION,
    today,
    ...(model ? { model } : {}),
    completion: raw,
    ...(logprobs ? { logprobs } : {}),
  };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json', detail: raw.slice(0, 200), trace };
  }

  const result = ModelOutputSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: 'schema_violation', detail: result.error.issues[0]?.message, trace };
  }

  const out = result.data;
  if (!out.is_expense) return { ok: false, reason: 'not_an_expense', detail: out.reason, trace };

  const movement: Movement = {
    amount: toCents(out.amount),
    category: out.category,
    payment_method: out.payment_method,
    description: out.description,
    date: out.date && isIsoDate(out.date) ? out.date : today,
  };
  // Only money already spent is recorded: a planned payment the model missed is rejected here, deterministically.
  if (daysBetween(movement.date, today) < 0) return { ok: false, reason: 'future_date', detail: movement.date, trace };
  const badDate = out.date != null && !isIsoDate(out.date);
  return { ok: true, movement, ...review(movement, guard.text, raw, logprobs, { ...opts, today, badDate }), trace };
}

/** Confidence and review flags. Only adds keys that have something to say. */
function review(
  movement: Movement,
  text: string,
  raw: string,
  logprobs: TokenLogprob[] | undefined,
  opts: ParseOptions & { today: string; badDate: boolean },
) {
  const below = { ...DEFAULT_REVIEW_BELOW, ...opts.reviewBelow };
  const fields = logprobs ? fieldConfidence(raw, logprobs) : undefined;
  const transcript = opts.transcript
    ? transcriptConfidence(opts.transcript, below.transcript ?? 0.3, below.transcript_first_word ?? 0.1)
    : undefined;
  const flagged = new Set<Field>();

  for (const field of ['amount', 'category', 'payment_method', 'description', 'date'] as const) {
    const p = fields?.[field]?.p;
    const threshold = below[field];
    if (p !== undefined && threshold !== undefined && p < threshold) flagged.add(field);
  }
  if (movement.amount === 0) flagged.add('amount'); // the model found no amount
  // The prompt says "ambiguous → Other", so the model is confident about Other even when it just didn't know.
  if (movement.category === 'Other') flagged.add('category');
  // Past dates are questioned, not rejected: not a real day (replaced by today), or over a year ago.
  if (opts.badDate || daysBetween(movement.date, opts.today) > 366) flagged.add('date');

  const shaky = transcript !== undefined && transcript.uncertain.length > 0;
  if (shaky) {
    // A misheard word is usually the item ("uber eats" → "uvevip"), so the category is suspect. An unsure number
    // ("850" vs "eight hundred fifty") says nothing about the item.
    if (transcript.uncertain.some((w) => !/^[\d.,$]+$/.test(w.text))) flagged.add('category');
    // And a misheard number is a misheard amount: an unsure word with digits, or an amount not written as digits.
    const digits = String(movement.amount / 100);
    if (transcript.uncertain.some((w) => /\d/.test(w.text)) || !text.replace(/[,\s]/g, '').includes(digits)) {
      flagged.add('amount');
    }
  }

  const confidence: Confidence | undefined =
    fields || transcript ? { fields: fields ?? {}, ...(transcript ? { transcript } : {}) } : undefined;
  return {
    ...(confidence ? { confidence } : {}),
    ...(flagged.size ? { needs_review: [...flagged] } : {}),
    ...(transcript ? { transcript_uncertain: shaky } : {}),
  };
}
