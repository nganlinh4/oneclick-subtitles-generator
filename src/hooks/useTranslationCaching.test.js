import { describe, expect, it } from 'vitest';

import { translationCacheMatches } from './useTranslationCaching';

describe('translation cache identity', () => {
  const entry = Object.freeze({
    mediaId: 'media-a',
    subtitleHash: 'hash-a',
    translations: Object.freeze([{ id: 1, text: 'Translated' }]),
  });

  it('requires the same media and exact source subtitle hash', () => {
    expect(translationCacheMatches(entry, 'media-a', 'hash-a')).toBe(true);
    expect(translationCacheMatches(entry, 'media-b', 'hash-a')).toBe(false);
    expect(translationCacheMatches(entry, 'media-a', 'hash-b')).toBe(false);
  });

  it('rejects malformed and empty cache entries', () => {
    for (const value of [
      null,
      [],
      {},
      { ...entry, translations: [] },
      { ...entry, translations: null },
    ]) {
      expect(translationCacheMatches(value, 'media-a', 'hash-a')).toBe(false);
    }
  });
});
