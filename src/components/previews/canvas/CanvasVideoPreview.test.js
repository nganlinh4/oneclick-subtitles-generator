import { describe, expect, it } from 'vitest';

import { canvasCompositionSize } from './CanvasVideoPreview';

describe('canvas preview geometry boundary', () => {
  it('adapts the native widthPx/heightPx contract into finite canvas dimensions', () => {
    expect(canvasCompositionSize({
      resolution: '1080p',
      sourceWidthPx: 640,
      sourceHeightPx: 360,
      crop: { width: 100, height: 100 },
    })).toEqual({ width: 1920, height: 1080 });
  });

  it('does not manufacture a canvas size when native geometry refuses the input', () => {
    expect(canvasCompositionSize({
      resolution: '1080p',
      sourceWidthPx: 0,
      sourceHeightPx: 360,
      crop: { width: 100, height: 100 },
    })).toBeNull();
  });
});
