import { describe, expect, it } from 'vitest';

import {
  canvasBackingSize,
  canvasCompositionSize,
  canvasPreviewFailure,
  previewSceneTime,
} from './canvasPreviewModel';

describe('canvas preview geometry boundary', () => {
  it('caps an ultrawide fullscreen backing store without changing its aspect ratio', () => {
    expect(canvasBackingSize({ width: 2048, height: 864 }, 1.5)).toEqual({
      width: 1600,
      height: 675,
    });
    expect(canvasBackingSize({ width: 800, height: 450 }, 1.5)).toEqual({
      width: 1200,
      height: 675,
    });
  });

  it('classifies only recoverable browser resource failures as retryable', () => {
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceLoading',
    }))).toEqual({ code: 'glyphAtlasFaceLoading', retryable: true });
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceUnavailable',
    }))).toEqual({ code: 'glyphAtlasFaceUnavailable', retryable: false });
    expect(canvasPreviewFailure(Object.assign(new Error(), {
      code: 'glyphAtlasFaceSubstituted',
    }))).toEqual({ code: 'glyphAtlasFaceSubstituted', retryable: false });
  });

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

  it('uses the exact trimmed output grid without advancing before a frame boundary', () => {
    expect(previewSceneTime(0.05, 30, 0.01)).toBeCloseTo(0.01 + 1 / 30, 12);
    expect(previewSceneTime(1 / 30 - 0.000_001, 30, 0)).toBe(0);
    expect(previewSceneTime(1 / 30, 30, 0)).toBeCloseTo(1 / 30, 15);
  });
});
