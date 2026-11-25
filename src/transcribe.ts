import OpenAI, { toFile } from 'openai';
import type { TokenLogprob } from './confidence.js';
import { checkAudio, type RejectReason } from './guards.js';

/**
 * Transcription model used when none is given. `gpt-4o-mini-transcribe` is cheaper than `whisper-1`
 * (about $0.003 vs $0.006 per minute) and `whisper-1` is being retired.
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** The transcript, plus per-token logprobs when the model provides them (gpt-4o-*-transcribe; not whisper-1). */
export type TranscribeResult = { ok: true; text: string; logprobs?: TokenLogprob[] } | { ok: false; reason: RejectReason };

/** Models that can return logprobs for the transcript. */
const supportsLogprobs = (model: string) => /^gpt-4o.*transcribe/.test(model);

export interface TranscribeOptions {
  client?: OpenAI;
  /** OpenAI transcription model (default {@link DEFAULT_TRANSCRIBE_MODEL}). */
  model?: string;
  /**
   * Optional vocabulary/context hint for the model, e.g. brand names it tends to mishear. None by default:
   * on silent audio the model can echo the hint back as the transcript.
   */
  prompt?: string;
  /** Length of the recording; very short clips are rejected before calling the model. */
  durationMs?: number;
  /** ISO-639-1 hint ("es", "en"). Omit to let the model auto-detect. */
  language?: string;
  /** Upload filename. Its extension tells the model the audio format (default `spend.m4a`). */
  filename?: string;
  /** MIME type of the upload. Defaults to the type matching the filename's extension. */
  mimeType?: string;
}

/** Audio formats the transcription API accepts, by file extension. */
const MIME_TYPES: Record<string, string> = {
  m4a: 'audio/m4a',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

/** MIME type for a filename's extension, so the upload's type never contradicts its name. */
export function mimeTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export async function transcribe(audio: Buffer, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  if (opts.durationMs !== undefined) {
    const guard = checkAudio(opts.durationMs);
    if (!guard.ok) return guard;
  }

  const client = opts.client ?? new OpenAI();
  const filename = opts.filename ?? 'spend.m4a';
  const file = await toFile(audio, filename, { type: opts.mimeType ?? mimeTypeFor(filename) });
  const model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
  const result = await client.audio.transcriptions.create({
    model,
    file,
    ...(supportsLogprobs(model) ? { include: ['logprobs' as const] } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
  const logprobs = result.logprobs
    ?.filter((t) => t.token !== undefined && t.logprob !== undefined)
    .map((t) => ({ token: t.token!, logprob: t.logprob!, bytes: t.bytes ?? null }));
  return { ok: true, text: result.text, ...(logprobs?.length ? { logprobs } : {}) };
}
