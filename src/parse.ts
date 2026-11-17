import OpenAI from 'openai';
import { checkTranscript, type RejectReason } from './guards.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { ModelOutputSchema, toCents, type Movement } from './schema.js';

/**
 * Anything that can answer "system prompt + user text -> raw string".
 * Injected so tests run offline with a fake, and so the model can be swapped without touching parsing.
 */
export type Completer = (system: string, user: string) => Promise<string>;

export type ParseResult =
  | { ok: true; movement: Movement }
  | { ok: false; reason: RejectReason; detail?: string };

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
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return completion.choices[0]?.message?.content ?? '';
  };
}

/**
 * Text in, validated record (or an explicit rejection) out.
 * Model output is treated as untrusted input: it must parse, match a closed schema,
 * and claim to be an expense before anything is returned for storage.
 */
export async function parseSpend(text: string, complete: Completer): Promise<ParseResult> {
  const guard = checkTranscript(text);
  if (!guard.ok) return guard;

  const raw = await complete(SYSTEM_PROMPT, guard.text);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json', detail: raw.slice(0, 200) };
  }

  const result = ModelOutputSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: 'schema_violation', detail: result.error.issues[0]?.message };
  }

  const out = result.data;
  if (!out.is_expense) return { ok: false, reason: 'not_an_expense', detail: out.reason };

  return {
    ok: true,
    movement: {
      amount: toCents(out.amount),
      category: out.category,
      payment_method: out.payment_method,
      description: out.description,
    },
  };
}
