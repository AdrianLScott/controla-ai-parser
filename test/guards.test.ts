import { describe, expect, it } from 'vitest';
import { checkAudio, checkTranscript, MIN_AUDIO_MS } from '../src/guards.js';

describe('checkTranscript', () => {
  it.each([
    'Subtítulos realizados por la comunidad de Amara.org',
    'subtitulos hechos por la comunidad de amara.org',
    'Thanks for watching!',
    'Thank you so much for watching',
    'Gracias por ver el video.',
    '¡Suscríbete al canal!',
  ])('rejects the known Whisper hallucination %j', (text) => {
    expect(checkTranscript(text)).toEqual({ ok: false, reason: 'known_hallucination' });
  });

  it.each(['', '   ', '...', '…', '[Music]', '(silencio)'])('rejects empty or content-free %j', (text) => {
    expect(checkTranscript(text)).toEqual({ ok: false, reason: 'empty_transcript' });
  });

  it('rejects a single word, which cannot be a record', () => {
    expect(checkTranscript('tacos')).toEqual({ ok: false, reason: 'too_short' });
  });

  it.each(['tacos 300', 'uber 25', 'gasté 180 en hamburguesas en efectivo'])('lets %j through', (text) => {
    expect(checkTranscript(text)).toEqual({ ok: true, text });
  });

  it('normalizes whitespace before passing text on', () => {
    expect(checkTranscript('  tacos \n  300 ')).toEqual({ ok: true, text: 'tacos 300' });
  });
});

describe('checkAudio', () => {
  it('rejects accidental taps', () => {
    expect(checkAudio(MIN_AUDIO_MS - 1)).toEqual({ ok: false, reason: 'audio_too_short' });
  });

  it('accepts a real recording', () => {
    expect(checkAudio(2400).ok).toBe(true);
  });
});
