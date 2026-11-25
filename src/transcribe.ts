import OpenAI, { toFile } from 'openai';
import { checkAudio, type GuardResult } from './guards.js';

export interface TranscribeOptions {
  client?: OpenAI;
  /** Length of the recording; very short clips are rejected before calling Whisper. */
  durationMs?: number;
  /** ISO-639-1 hint ("es", "en"). Omit to let Whisper auto-detect. */
  language?: string;
  /** Upload filename. Its extension tells Whisper the audio format (default `spend.m4a`). */
  filename?: string;
  /** MIME type of the upload. Defaults to the type matching the filename's extension. */
  mimeType?: string;
}

/** Audio formats Whisper accepts, by file extension. */
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

export async function transcribe(audio: Buffer, opts: TranscribeOptions = {}): Promise<GuardResult> {
  if (opts.durationMs !== undefined) {
    const guard = checkAudio(opts.durationMs);
    if (!guard.ok) return guard;
  }

  const client = opts.client ?? new OpenAI();
  const filename = opts.filename ?? 'spend.m4a';
  const file = await toFile(audio, filename, { type: opts.mimeType ?? mimeTypeFor(filename) });
  const result = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    ...(opts.language ? { language: opts.language } : {}),
  });
  return { ok: true, text: result.text };
}
