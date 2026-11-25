import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { DEFAULT_TRANSCRIBE_MODEL, mimeTypeFor, transcribe } from '../src/transcribe.js';

/** A fake OpenAI client that records the uploaded file, so tests run offline. */
function fakeClient(text = 'tacos 300') {
  const create = vi.fn(async (_req: { file: File; model: string }) => ({ text }));
  const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
  return { client, create, uploaded: () => create.mock.calls[0]?.[0].file, model: () => create.mock.calls[0]?.[0].model };
}

const audio = Buffer.from('fake audio bytes');

describe('mimeTypeFor', () => {
  it.each([
    ['clip.m4a', 'audio/m4a'],
    ['clip.webm', 'audio/webm'],
    ['clip.mp4', 'audio/mp4'],
    ['clip.mp3', 'audio/mpeg'],
    ['clip.wav', 'audio/wav'],
    ['clip.ogg', 'audio/ogg'],
    ['CLIP.WEBM', 'audio/webm'],
    ['clip.xyz', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'],
  ])('%s → %s', (filename, type) => {
    expect(mimeTypeFor(filename)).toBe(type);
  });
});

describe('transcribe', () => {
  it('uploads m4a by default (unchanged behavior)', async () => {
    const { client, uploaded } = fakeClient();
    const result = await transcribe(audio, { client });
    expect(result).toEqual({ ok: true, text: 'tacos 300' });
    expect(uploaded()?.name).toBe('spend.m4a');
    expect(uploaded()?.type).toBe('audio/m4a');
  });

  it("labels the upload with the type matching the filename's extension", async () => {
    const { client, uploaded } = fakeClient();
    await transcribe(audio, { client, filename: 'audio.webm' });
    expect(uploaded()?.name).toBe('audio.webm');
    expect(uploaded()?.type).toBe('audio/webm');
  });

  it('uses an explicit mimeType over the extension', async () => {
    const { client, uploaded } = fakeClient();
    await transcribe(audio, { client, filename: 'audio.webm', mimeType: 'audio/webm;codecs=opus' });
    expect(uploaded()?.type).toBe('audio/webm;codecs=opus');
  });

  it('uses gpt-4o-mini-transcribe by default', async () => {
    const { client, model } = fakeClient();
    await transcribe(audio, { client });
    expect(DEFAULT_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(model()).toBe('gpt-4o-mini-transcribe');
  });

  it('uses the model it is given', async () => {
    const { client, model } = fakeClient();
    await transcribe(audio, { client, model: 'whisper-1' });
    expect(model()).toBe('whisper-1');
  });

  it('rejects a too-short clip without calling Whisper', async () => {
    const { client, create } = fakeClient();
    const result = await transcribe(audio, { client, durationMs: 300 });
    expect(result).toEqual({ ok: false, reason: 'audio_too_short' });
    expect(create).not.toHaveBeenCalled();
  });
});
