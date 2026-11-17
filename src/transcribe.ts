import OpenAI, { toFile } from 'openai';
import { checkAudio, type GuardResult } from './guards.js';

export interface TranscribeOptions {
  client?: OpenAI;
  /** Length of the recording; very short clips are rejected before calling Whisper. */
  durationMs?: number;
  /** ISO-639-1 hint ("es", "en"). Omit to let Whisper auto-detect. */
  language?: string;
  filename?: string;
}

export async function transcribe(audio: Buffer, opts: TranscribeOptions = {}): Promise<GuardResult> {
  if (opts.durationMs !== undefined) {
    const guard = checkAudio(opts.durationMs);
    if (!guard.ok) return guard;
  }

  const client = opts.client ?? new OpenAI();
  const file = await toFile(audio, opts.filename ?? 'spend.m4a', { type: 'audio/m4a' });
  const result = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    ...(opts.language ? { language: opts.language } : {}),
  });
  return { ok: true, text: result.text };
}
