import { describe, expect, it } from 'vitest';

import { EDITOR_PREVIEW_RESOLUTION, translatedSubtitlesForRender } from './previewCueSelection';

describe('editor preview cue selection', () => {
  it('keeps the fixed editor composition size explicit', () => {
    expect(EDITOR_PREVIEW_RESOLUTION).toBe('1080p');
  });

  it('puts translated text on the original cue timing without mutating either track', () => {
    const originals = [{ id: 'a', start: 1.25, end: 2.5, text: 'Original' }];
    const translated = [{ id: 't', originalId: 'a', text: 'Translated' }];
    expect(translatedSubtitlesForRender(translated, originals)).toEqual([
      { id: 't', start: 1.25, end: 2.5, text: 'Translated' },
    ]);
    expect(translated).toEqual([{ id: 't', originalId: 'a', text: 'Translated' }]);
  });

  it('normalizes legacy string timing only when no original cue owns the timing', () => {
    expect(translatedSubtitlesForRender([
      { id: 't', startTime: '00:00:03,250', endTime: '00:00:04,500', text: 'Legacy' },
      { id: 'n', start: 5, end: 6, text: 'Numeric' },
    ], [])).toEqual([
      { id: 't', start: 3.25, end: 4.5, text: 'Legacy' },
      { id: 'n', start: 5, end: 6, text: 'Numeric' },
    ]);
  });
});
