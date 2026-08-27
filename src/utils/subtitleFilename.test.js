import { describe, expect, it } from 'vitest';

import { generateSubtitleFilename } from './subtitleFilename';

describe('generateSubtitleFilename', () => {
  it('prefers the uploaded document name, then the video name, then the title', () => {
    expect(generateSubtitleFilename({
      source: 'original', sourceSubtitleName: 'cues-ascii.srt', videoName: 'Me at the zoo.mp4',
    })).toBe('cues-ascii');
    expect(generateSubtitleFilename({
      source: 'original', videoName: 'Me at the zoo.mp4',
    })).toBe('Me at the zoo');
    expect(generateSubtitleFilename({ source: 'original', videoTitle: 'Zoo' })).toBe('Zoo');
    expect(generateSubtitleFilename({ source: 'original' })).toBe('subtitles');
  });

  it('names single- and multi-language translations by their languages', () => {
    expect(generateSubtitleFilename({
      source: 'translated', sourceSubtitleName: 'cues.srt', targetLanguages: [{ value: 'Tiếng Việt' }],
    })).toBe('cues_tiếng_việt');
    expect(generateSubtitleFilename({
      source: 'translated', sourceSubtitleName: 'cues.srt', targetLanguages: ['Korean', 'French'],
    })).toBe('cues_multi_lang');
  });

  it('never lets a language-free translation collide with the original name', () => {
    const original = generateSubtitleFilename({
      source: 'original', sourceSubtitleName: 'cues-ascii.srt',
    });
    const formatted = generateSubtitleFilename({
      source: 'translated', sourceSubtitleName: 'cues-ascii.srt',
    });
    expect(formatted).toBe('cues-ascii_translated');
    expect(formatted).not.toBe(original);
  });
});
