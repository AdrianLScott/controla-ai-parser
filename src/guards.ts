/**
 * Cheap, deterministic checks that run BEFORE we pay for an LLM call.
 *
 * Why they exist: in real use, short or silent recordings made Whisper "hear" text that was never said,
 * typically subtitle credits such as "Subtítulos realizados por la comunidad de Amara.org".
 * The parser then dutifully turned that into an expense. These guards stop it at the door.
 */

export type RejectReason =
  | 'audio_too_short'
  | 'empty_transcript'
  | 'known_hallucination'
  | 'too_short'
  | 'invalid_json'
  | 'schema_violation'
  | 'not_an_expense';

export type GuardResult = { ok: true; text: string } | { ok: false; reason: RejectReason };

/** Recordings shorter than this are almost always accidental taps. */
export const MIN_AUDIO_MS = 800;

/** Phrases Whisper is known to produce from silence or background noise. */
export const KNOWN_HALLUCINATIONS: readonly RegExp[] = [
  /amara\.org/i,
  /subt[ií]tulos? (realizados?|hechos?|creados?) por/i,
  /subtitles? by/i,
  /thanks? (you )?(so much )?for watching/i,
  /gracias por (ver|mirar)/i,
  /suscr[ií]be(te)?/i,
  /subscribe to/i,
];

/** Transcripts made only of punctuation, ellipses or bracketed sound tags, e.g. "...", "[Music]". */
const NO_CONTENT = /^[\s.,!?¡¿…-]*$|^\s*[[(][^\])]*[\])]\s*$/;

export function checkAudio(durationMs: number): GuardResult {
  return durationMs < MIN_AUDIO_MS ? { ok: false, reason: 'audio_too_short' } : { ok: true, text: '' };
}

export function checkTranscript(raw: string): GuardResult {
  const text = raw.replace(/\s+/g, ' ').trim();

  if (text.length === 0 || NO_CONTENT.test(text)) return { ok: false, reason: 'empty_transcript' };
  if (KNOWN_HALLUCINATIONS.some((re) => re.test(text))) return { ok: false, reason: 'known_hallucination' };

  // "tacos" alone can't be an expense record; "tacos 300" or "uber 25" can.
  const words = text.split(' ').filter((w) => /\p{L}|\d/u.test(w));
  if (words.length < 2) return { ok: false, reason: 'too_short' };

  return { ok: true, text };
}
