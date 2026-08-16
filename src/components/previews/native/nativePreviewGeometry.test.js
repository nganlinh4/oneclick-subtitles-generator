import { describe, expect, it } from 'vitest';

import {
  atlasMaxWidthPx,
  compositionSize,
  exactFrameRate,
  frameCountForDuration,
  frameIndexForTime,
  glyphScaleForComposition,
  roundTwoDecimalsLikeJavaScript,
  scaleSubtitleStyleValue,
} from './nativePreviewGeometry';

const jsToFixedTwo = (value) => Number(value.toFixed(2));

describe('style scaling mirrors crates/osg-scene/src/scale.rs', () => {
  it('rounds the way toFixed(2) rounds rather than the way Rust rounds by default', () => {
    // Rust's own two-decimal formatting rounds half to even, so 0.125 would become 0.12 there.
    // scale.rs reimplements toFixed precisely to avoid that, and this side must not diverge.
    expect(roundTwoDecimalsLikeJavaScript(0.125)).toBe(jsToFixedTwo(0.125));
    expect(roundTwoDecimalsLikeJavaScript(2.345)).toBe(jsToFixedTwo(2.345));
    expect(roundTwoDecimalsLikeJavaScript(-1.005)).toBe(-jsToFixedTwo(1.005));
  });

  it('scales sizes with composition height, so a size is not resolution-independent', () => {
    expect(scaleSubtitleStyleValue(28, 1_080)).toBe(28);
    expect(scaleSubtitleStyleValue(28, 2_160)).toBe(56);
    expect(scaleSubtitleStyleValue(28, 720)).toBe(18.67);
  });
});

describe('the glyph scale relates the baked atlas to the composition', () => {
  it('is the scaled font size over the size the atlas was baked at', () => {
    expect(glyphScaleForComposition({ fontSize: 50, compositionHeightPx: 1_080, atlasFontSizePx: 50 })).toBe(1);
    expect(glyphScaleForComposition({ fontSize: 50, compositionHeightPx: 2_160, atlasFontSizePx: 50 })).toBe(2);
  });

  it('refuses rather than guessing when an input cannot produce one', () => {
    expect(glyphScaleForComposition({ fontSize: 0, compositionHeightPx: 1_080, atlasFontSizePx: 50 })).toBeNull();
    expect(glyphScaleForComposition({ fontSize: 50, compositionHeightPx: 0, atlasFontSizePx: 50 })).toBeNull();
    expect(glyphScaleForComposition({ fontSize: 50, compositionHeightPx: 1_080, atlasFontSizePx: 0 })).toBeNull();
  });
});

/**
 * The parity ledger's `maxWidth` entry, which this is the caller for.
 *
 * The persisted value is a percentage of the composition; the baker takes atlas pixels; the atlas is
 * baked once at its own font size and scaled by the compositor. The conversion therefore has to
 * divide by the glyph scale, and the observable consequence is that the SAME style produces the SAME
 * atlas-space wrap width at every resolution — which is the only way one baked atlas can serve them
 * all. A composition-space width passed straight through would agree at exactly one resolution.
 */
describe('maxWidth converts from composition percent to atlas pixels', () => {
  const style = { maxWidthPercent: 80, fontSize: 50, atlasFontSizePx: 50 };

  const atlasWidthAt = (compositionWidthPx, compositionHeightPx) => atlasMaxWidthPx({
    maxWidthPercent: style.maxWidthPercent,
    compositionWidthPx,
    glyphScale: glyphScaleForComposition({
      fontSize: style.fontSize,
      compositionHeightPx,
      atlasFontSizePx: style.atlasFontSizePx,
    }),
  });

  it('gives one atlas-space width at 1080p and at 4K', () => {
    expect(atlasWidthAt(1_920, 1_080)).toBe(1_536);
    expect(atlasWidthAt(3_840, 2_160)).toBe(1_536);
    expect(atlasWidthAt(3_840, 2_160)).toBe(atlasWidthAt(1_920, 1_080));
  });

  it('is not the composition-space width, which is what passing the percentage through would give', () => {
    // 80% of 3840 is 3072. Baking to that would fit twice as much text on a line at 4K as at 1080p,
    // from the same style, with nothing anywhere reporting a problem.
    const naiveAt4K = (style.maxWidthPercent / 100) * 3_840;
    expect(naiveAt4K).toBe(3_072);
    expect(atlasWidthAt(3_840, 2_160)).not.toBe(naiveAt4K);
    expect(naiveAt4K / atlasWidthAt(3_840, 2_160)).toBe(2);
  });

  it('carries the rounding of the scaled font size, because the compositor does', () => {
    // 720p scales a 50px face to 33.33px, so the glyph scale is 0.6666 and not exactly 2/3. The wrap
    // width has to be derived through the same rounded scale the compositor will apply, or the
    // preview wraps a fraction of a pixel away from the frame it is previewing.
    const scale = glyphScaleForComposition({ fontSize: 50, compositionHeightPx: 720, atlasFontSizePx: 50 });
    expect(scale).toBe(0.6666);
    expect(atlasWidthAt(1_280, 720)).toBeCloseTo((0.8 * 1_280) / 0.6666, 9);
  });

  it('refuses a percentage or a width it cannot honour rather than wrapping nowhere', () => {
    expect(atlasMaxWidthPx({ maxWidthPercent: 0, compositionWidthPx: 1_920, glyphScale: 1 })).toBeNull();
    expect(atlasMaxWidthPx({ maxWidthPercent: 101, compositionWidthPx: 1_920, glyphScale: 1 })).toBeNull();
    expect(atlasMaxWidthPx({ maxWidthPercent: 80, compositionWidthPx: 1_920, glyphScale: 0 })).toBeNull();
    // Below the baker's smallest scale the width would exceed the layout bound it enforces.
    expect(atlasMaxWidthPx({ maxWidthPercent: 100, compositionWidthPx: 7_680, glyphScale: 1e-6 })).toBeNull();
  });
});

describe('composition size mirrors crates/osg-export/src/convert/dimensions.rs', () => {
  it('takes the height from the ladder and derives the width from the crop', () => {
    expect(compositionSize({ resolution: '1080p', sourceWidthPx: 1_920, sourceHeightPx: 1_080 }))
      .toEqual({ widthPx: 1_920, heightPx: 1_080 });
    expect(compositionSize({ resolution: '4K', sourceWidthPx: 1_920, sourceHeightPx: 1_080 }))
      .toEqual({ widthPx: 3_840, heightPx: 2_160 });
    expect(compositionSize({ resolution: '720p', sourceWidthPx: 1_080, sourceHeightPx: 1_920 }))
      .toEqual({ widthPx: 406, heightPx: 720 });
  });

  it('associates the crop ratio the way Rust does, which the Remotion preview did not', () => {
    // dimensions.rs records this exact crop as one where the shipped preview composed 682 and
    // everything downstream composed 684, because floating-point multiplication is not associative.
    const derived = compositionSize({
      resolution: '1080p',
      sourceWidthPx: 1_920,
      sourceHeightPx: 1_080,
      crop: { width: 10.01, height: 28.16 },
    });
    const remotionAssociation = Math.round(1_080 * ((1_920 / 1_080) * ((10.01 / 100) / (28.16 / 100))));
    expect(derived.widthPx).toBe(684);
    expect(remotionAssociation).toBe(682);
  });

  it('rounds both edges up to even, because the encoder cannot take an odd one', () => {
    const derived = compositionSize({ resolution: '1080p', sourceWidthPx: 1_001, sourceHeightPx: 1_000 });
    expect(derived.widthPx % 2).toBe(0);
    expect(derived.heightPx % 2).toBe(0);
  });

  it('refuses a size the request contract would not accept', () => {
    expect(compositionSize({ resolution: '1080p', sourceWidthPx: 1_920, sourceHeightPx: 1_080, crop: { width: 100, height: 0.01 } })).toBeNull();
    expect(compositionSize({ resolution: 'not a rung', sourceWidthPx: 1_920, sourceHeightPx: 1_080 })).toBeNull();
    expect(compositionSize({ resolution: '1080p', sourceWidthPx: null, sourceHeightPx: 1_080 })).toBeNull();
  });
});

describe('the frame grid', () => {
  it('keeps 29.97 exact rather than a float that drifts', () => {
    expect(exactFrameRate(29.97)).toEqual({ fpsNumerator: 30_000, fpsDenominator: 1_001 });
    expect(exactFrameRate(59.94)).toEqual({ fpsNumerator: 60_000, fpsDenominator: 1_001 });
    expect(exactFrameRate(30)).toEqual({ fpsNumerator: 30, fpsDenominator: 1 });
    expect(exactFrameRate(30.5)).toBeNull();
  });

  it('floors a timestamp onto the frame that covers it and clamps into the timeline', () => {
    const timeline = { fpsNumerator: 30, fpsDenominator: 1, frameCount: 300 };
    expect(frameIndexForTime(0, timeline)).toBe(0);
    expect(frameIndexForTime(1 / 30 - 1e-9, timeline)).toBe(0);
    expect(frameIndexForTime(1 / 30, timeline)).toBe(1);
    expect(frameIndexForTime(2, timeline)).toBe(60);
    expect(frameIndexForTime(-5, timeline)).toBe(0);
    expect(frameIndexForTime(1_000, timeline)).toBe(299);
  });

  it('counts frames for a duration on the exact grid', () => {
    expect(frameCountForDuration(10, { fpsNumerator: 30, fpsDenominator: 1 })).toBe(300);
    expect(frameCountForDuration(1, { fpsNumerator: 30_000, fpsDenominator: 1_001 })).toBe(30);
    expect(frameCountForDuration(0, { fpsNumerator: 30, fpsDenominator: 1 })).toBeNull();
  });
});
