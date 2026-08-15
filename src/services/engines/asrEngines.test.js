import { describe, expect, it } from 'vitest';
import { normalizeAsrLanguage } from './asrEngines';

describe('normalizeAsrLanguage', () => {
  it('keeps supported Qwen languages and rejects unsupported saved choices', () => {
    expect(normalizeAsrLanguage('qwen3-asr-1.7b', ' KO ')).toBe('ko');
    expect(normalizeAsrLanguage('qwen3-asr-1.7b', 'vi')).toBe('auto');
  });

  it('allows strict two-letter Faster-Whisper choices but never forces Parakeet', () => {
    expect(normalizeAsrLanguage('faster-whisper-turbo', 'vi')).toBe('vi');
    expect(normalizeAsrLanguage('faster-whisper-large-v3', 'en-US')).toBe('auto');
    expect(normalizeAsrLanguage('nvidia-parakeet', 'en')).toBe('auto');
  });

  it('fails closed for malformed values and unknown engines', () => {
    expect(normalizeAsrLanguage('qwen3-asr-0.6b', null)).toBe('auto');
    expect(normalizeAsrLanguage('unknown', 'en')).toBe('auto');
  });
});
