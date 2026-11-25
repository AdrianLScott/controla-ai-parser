# controla-ai-parser

Turns a spoken or typed expense into a validated record:

```
"gasté 180 en hamburguesas en efectivo"
        ↓
{ amount: 18000, category: "Food", payment_method: "Cash", description: "Hamburguesas" }
```

This is the AI core of **Controla**, a personal finance app I'm building where you tap a home-screen widget, say what you spent, and it's logged. The app itself is private; this module is extracted so the interesting part can be read, run and tested on its own.

Controla is also my hands-on lab for AI engineering. Each concept I learn (structured output, validation, evals, and next tool calling and on-device models) gets shipped here instead of staying in a tutorial.

## Pipeline

```
audio ──► audio guard ──► transcribe ──► transcript guard ──► GPT-4o-mini ──► JSON.parse ──► Zod ──► cents ──► store
          (< 0.8 s?)                     (empty? known                        (not JSON?)     (closed     (integer
                                          hallucination?)                                      schema)     money)
```

Every arrow can say **no**. A rejection is a normal result with a reason, not an exception:

```ts
type ParseResult =
  | { ok: true; movement: Movement; confidence?: Confidence; needs_review?: Field[]; transcript_uncertain?: boolean }
  | { ok: false; reason: 'audio_too_short' | 'empty_transcript' | 'known_hallucination' | 'too_short'
                       | 'invalid_json' | 'schema_violation' | 'not_an_expense'; detail?: string };
```

## Choosing the transcription model

Transcription uses `gpt-4o-mini-transcribe` by default (`model` option to override). I compared it with `whisper-1`
by sending 31 spoken clips (the eval set read by a text-to-speech voice, plus silence and accidental taps) through
transcribe → parse:

| | `whisper-1` | `gpt-4o-mini-transcribe` |
|---|---|---|
| Clips passed | 30/31 | 30/31 |
| "uber eats 230 con crédito" | "vRips230": amount and category wrong | "Tuve lipis doscientos treinta": amount right, category wrong |
| Silent clips | "Thank you for watching." (caught by the transcript guard) | empty transcript |
| Price | $0.006/min | ~$0.003/min |

A vocabulary hint (`prompt` option) fixed the brand name, but on silent clips the model echoed the hint back as the
transcript, so it's opt-in and off by default.

## Confidence: which fields to double-check

Some input is genuinely ambiguous ("ida a la playa 500": Travel or Transport?) and some gets misheard ("uber eats
230" → "Tuve lipis doscientos treinta"). Instead of hiding that behind defaults, every parsed movement says how sure
the model was, field by field, so an app can ask the user about just the shaky parts.

The numbers are **logprobs**: the probabilities the model itself assigned to the tokens it wrote. They come with the
same API call at no extra cost, and unlike a confidence the model is asked to write in its JSON, they're measured,
not claimed.

```ts
{
  ok: true,
  movement: { amount: 50000, category: 'Travel', payment_method: 'Cash', description: 'Ida a la playa' },
  confidence: {
    fields: {
      amount:   { p: 0.97 },
      category: { p: 0.62, alternatives: [{ value: 'Transport', p: 0.31 }, { value: 'Other', p: 0.05 }] },
      payment_method: { p: 0.9 }, description: { p: 0.88 }, is_expense: { p: 0.99 },
    },
  },
  needs_review: ['category'],
}
```

| Signal | Catches | How it's scored |
|---|---|---|
| Parse logprobs ([`src/confidence.ts`](src/confidence.ts)) | the model hesitating between values | Tokens mapped back to each JSON value by **byte** offset (a token can hold half of "á"). Enums, amount: joint probability of the value; alternatives from the token where the model hesitated. Description: geometric mean, reported but never flagged. |
| Transcript logprobs (`transcribe` with `gpt-4o-*-transcribe`) | mishearings the parser can't see | Per word; words below the threshold (the first word has a lower one) are listed in `confidence.transcript.uncertain`. An unsure word flags `category`; an unsure number, or an amount not heard as digits, flags `amount`. |
| Rules | missing values, the fallback | `amount: 0` and `category: Other` are always flagged. |

Thresholds are per field (`parseSpend(text, complete, { reviewBelow: { category: 0.7 } })`), because each scoring
method spreads its numbers differently. Defaults are in `DEFAULT_REVIEW_BELOW`.

### What the evals showed

I expected the parse logprobs to do most of the work. They didn't: **gpt-4o-mini is confident even when it's wrong.**

- Text eval: 4 wrong categories on the hard cases came back at 85%, 94%, 99% and 100%. Three of them were `Other`:
  the prompt says "ambiguous → Other", so the model is sure about *following the rule*, not about the category. Amount
  and payment method were ~100% on every case.
- Flagging `Other` as a rule, plus a 0.9 category threshold, catches **4/4** wrong categories with **2/29** correct
  ones flagged. The threshold alone (0.9) caught 1/4.
- Audio eval: transcript logprobs are where the signal is. "uber eats 230" was heard as "uvevip doscientos treinta",
  with *uvevip* at **3%**. The first word of a transcript often scores ~40% (capitalization), hence the 0.3 threshold.
  The first word of a transcript gets its own threshold (10%): the model hesitates over its capitalization, so
  correct first words scored 24–44% ("Cine", "Tacos", "Veinticinco") while mishearings there scored 0–3% ("uvevip",
  "Tuverips", "TVips"). An unsure number ("850" at 22%, digits vs words) flags only the amount.
  Before those two rules, two runs: 2/3 and 1/2 failing clips flagged on the right field; 5/33 passing clips flagged on the second run (a
  genuinely missing amount, a near-miss "Casita Acapulco", the transfer to a person filed as `Other`, an amount in words
  with decimals, and "850" at 22% because the model hesitated between writing digits and words). Transcripts vary
  from run to run, so these are indications, not benchmarks.
- Not caught: a misheard clip the model rejects as "not an expense" ("Tuve el trabajo ochenta"). Rejections carry no
  confidence yet.

Limits: logprobs aren't calibrated probabilities (0.62 doesn't mean "right 62% of the time"), and these numbers come
from 44 text cases and 35 synthetic (text-to-speech) clips, not real recordings. A payment method the user never said
is defaulted to Cash by the prompt, and the model is confident about that default, so it isn't flagged.

## The bug that shaped this

In real use, my expense list started showing entries like **"Subtítulos en Amara"**. Nobody said that. When Whisper receives silence or a very short accidental recording, it sometimes "hears" text from its training data, typically subtitle credits like *"Subtítulos realizados por la comunidad de Amara.org"*. The parser then did exactly what it was told and turned that into an expense.

The fix is three layers, cheapest first:

1. **Guards before the LLM** ([`src/guards.ts`](src/guards.ts)): reject clips under 0.8 s, empty or punctuation-only transcripts, and known hallucination phrases. These are deterministic, free and run before any paid model call.
2. **A legitimate way to say no**: the schema now has `is_expense: false`. Before, the model's only valid output was an expense, so it invented one. Now greetings, mic tests, questions and income get rejected by the model itself.
3. **Eval cases** for each of these, so the bug can't come back silently when the prompt or model changes.

## Design decisions

| Decision | Why |
|---|---|
| **Treat model output as untrusted input** | It must parse as JSON, match a closed Zod schema (fixed category and payment enums, non-negative amount) and claim to be an expense before anything is stored. Anything off-contract is rejected with a reason instead of writing bad data. |
| **Money as integer cents** | `19.99 * 100` is `1998.9999…` in floating point. Rounding once at the boundary keeps every stored amount exact. |
| **`temperature: 0` + `response_format: json_object`** | Same input, same record. JSON mode removes a whole class of "Sure! Here's your JSON:" failures. |
| **Model behind a `Completer` function** | `(system, user) => Promise<string>`. Tests use a fake, so they run offline in milliseconds, and swapping models doesn't touch parsing. |
| **Defaults instead of follow-up questions** | No payment method → `Cash`; unclear category → `Other`. Logging has to take seconds, so the record is saved and can be corrected later. |
| **AI stays on the server** | In Controla the app only sends audio or text. Keys never ship in the bundle and the model can change without an app release. |

## Evals

[`evals/cases.json`](evals/cases.json) holds 44 cases in Spanish and English, tagged by what they test:

| Tag | What it checks | Example |
|---|---|---|
| `words` | Amounts written as words | "veinticinco pesos de camión" → 2500 |
| `decimals`, `format` | Decimals and thousands separators | "zapatos 1,299 a meses…" → 129900 |
| `defaults` | Missing payment method falls back to Cash | "tacos 300" |
| `inference`, `tricky` | Category from context, brand traps | "ida a la playa 500" → Travel; "uber eats 230" → Food |
| `ambiguous` | Cases where a human could disagree | "gas for the car" vs "recibo del gas" |
| `hallucination` | Whisper subtitle artifacts | "Subtítulos realizados por la comunidad de Amara.org" |
| `not-expense` | Text that must not become a record | "hola, probando, probando", "me pagaron 5000" |
| `hard` | Ambiguous or misheard input, reported separately and not gated | "gasolina del viaje a guadalajara 900", "Tuve lipis doscientos treinta" |

```bash
cp .env.example .env   # add OPENAI_API_KEY
npm run eval                                    # gpt-4o-mini, fails under 90%
npm run eval -- --model gpt-4.1-mini --min 0.95  # compare another model
```

Each run prints pass/fail per case with the exact field that was wrong, a pass rate per tag, and a confidence
report: per field, the lowest-probability values marked right or wrong, and how many correct values (false alarms) and
wrong values (caught) each threshold would flag. Wrong values are few, so default thresholds are chosen from the
false-alarm side: flag at most 5% of correct fields. It saves the full result to `evals/results/` so runs can be compared before and after a prompt change. The `ambiguous` cases are there on purpose: they document the decision I made, and if a model disagrees I want to see it, not hide it.

## Tests

```bash
npm install
npm test        # 82 tests, offline, no API key needed
```

Covers the guards (every known hallucination, empty input, accidental taps), every rejection path in the parser (non-JSON, unknown category, negative amount, `is_expense: false`, guard short-circuits without calling the model), cents rounding, and the eval set's own integrity.

## Use

```ts
import { transcribe, parseSpend, openAICompleter } from 'controla-ai-parser';

const heard = await transcribe(audioBuffer, { durationMs: 2400, language: 'es' });
if (!heard.ok) return heard; // e.g. { ok: false, reason: 'audio_too_short' }

const result = await parseSpend(heard.text, openAICompleter(), { transcript: heard.logprobs });
if (result.ok) await save(result.movement, { review: result.needs_review ?? [] });
```

## Releasing

Published to npm as [`controla-ai-parser`](https://www.npmjs.com/package/controla-ai-parser) by [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. Open a PR that bumps the version: `npm version patch|minor|major --no-git-tag-version`.
2. Merge it. If that version isn't on npm yet, CI publishes it (trusted publishing with provenance, no npm token), tags `vX.Y.Z` and creates a GitHub release.

## Next

- Learn from corrections: once users can edit a movement, each edit is a confirmed error. Use them to check what the
  confidence flags missed and to grow the eval set.
- Run the eval set on every prompt change in CI (needs an API key secret).
- An LLM-as-judge check for the free-text `description`, which exact matching can't score.
- Compare an on-device model for the parsing step, so simple expenses work offline.

## Stack

TypeScript · OpenAI (gpt-4o-mini-transcribe, GPT-4o-mini) · Zod · Vitest · Node 20+

---

MIT © Adrián Lizárraga Scott · [Portfolio](https://adrianlscott.github.io)
