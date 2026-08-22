import { describe, expect, it } from 'vitest';

import {
  PREVIEW_PLAYHEAD,
  PREVIEW_WRAP_WIDTH_UNSUPPORTED,
  atlasLetterSpacingPx,
  atlasWrapWidth,
  compositionSize,
  exactFrameRate,
  frameIndexForTime,
  glyphScaleForComposition,
  previewPlayhead,
  previewTimeline,
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

  const atlasWidthAt = (compositionWidthPx, compositionHeightPx) => atlasWrapWidth({
    maxWidthPercent: style.maxWidthPercent,
    compositionWidthPx,
    glyphScale: glyphScaleForComposition({
      fontSize: style.fontSize,
      compositionHeightPx,
      atlasFontSizePx: style.atlasFontSizePx,
    }),
  }).widthPx;

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

  /**
   * The bound this used to impose on its own, which the contract does not.
   *
   * `maxWidth` is bounded 1..1000 by `RenderRequest::validate` and by `normalizeCustomization`, and
   * the shipped renderer writes it as CSS `max-width: N%` where anything above 100 is simply a box
   * wider than its parent. Refusing above 100 here returned `null`, `atlasBakeRequest` returned
   * `null`, and the hook went DORMANT — no frame and, because dormancy is deliberately silent, no
   * error either. A project styled past 100 exported correctly and previewed as a blank panel.
   */
  it('supports the whole maxWidth range the contract accepts, not a preview-only 100% bound', () => {
    const justOver = atlasWrapWidth({ maxWidthPercent: 101, compositionWidthPx: 1_920, glyphScale: 1 });
    expect(justOver.refusal).toBeNull();
    expect(justOver.widthPx).toBeCloseTo(1_939.2, 9);
    expect(atlasWrapWidth({ maxWidthPercent: 150, compositionWidthPx: 1_920, glyphScale: 1 }).widthPx)
      .toBe(2_880);
    // The contract's own ceiling, converted through a glyph scale exactly like every other width.
    expect(atlasWrapWidth({ maxWidthPercent: 1_000, compositionWidthPx: 1_920, glyphScale: 2 }).widthPx)
      .toBe(9_600);
  });

  it('reports a width the baker will not take as a code, never as silence', () => {
    // 1000% of the widest composition the conversion accepts, at the smallest bakeable glyph scale.
    // The baker's layout bound refuses it, and a refusal a user can be told about is the point.
    expect(atlasWrapWidth({ maxWidthPercent: 1_000, compositionWidthPx: 15_360, glyphScale: 0.0825 }))
      .toEqual({ widthPx: null, refusal: PREVIEW_WRAP_WIDTH_UNSUPPORTED });
    expect(PREVIEW_WRAP_WIDTH_UNSUPPORTED).toBe('previewWrapWidthUnsupported');
  });

  it('has neither a width nor a refusal for a style the export refuses too', () => {
    // Outside the contract's own 1..1000, so `normalizeCustomization` refuses the same style and
    // there is no frame either side would produce. Silence is the honest answer here and only here.
    const dormant = { widthPx: null, refusal: null };
    expect(atlasWrapWidth({ maxWidthPercent: 0, compositionWidthPx: 1_920, glyphScale: 1 })).toEqual(dormant);
    expect(atlasWrapWidth({ maxWidthPercent: 1_001, compositionWidthPx: 1_920, glyphScale: 1 })).toEqual(dormant);
    expect(atlasWrapWidth({ maxWidthPercent: 80, compositionWidthPx: 1_920, glyphScale: 0 })).toEqual(dormant);
  });
});

/**
 * The second atlas-space quantity, and the one the clamp was never compensated for.
 *
 * The atlas is baked at `clamp(fontSize, 4, 512)` while the contract accepts 1..1000, and
 * `glyphScale` divides by that CLAMPED size — which is what makes cells, pen positions and the wrap
 * width all come out right at a font size the clamp bites at. The letter spacing was passed into
 * atlas space raw and then multiplied by that same scale on the way back out.
 */
describe('letterSpacing converts from composition pixels to atlas pixels', () => {
  const atlasSpacingAt = (letterSpacing, fontSize, compositionHeightPx) => {
    const atlasFontSizePx = Math.min(Math.max(fontSize, 4), 512);
    return atlasLetterSpacingPx({
      letterSpacing,
      compositionHeightPx,
      glyphScale: glyphScaleForComposition({ fontSize, compositionHeightPx, atlasFontSizePx }),
    });
  };

  it('compensates the atlas font-size clamp, which raw spacing did not', () => {
    // fontSize 800 bakes at 512, so the compositor scales the whole layout by 800/512 = 1.5625.
    // 10 composition pixels of spacing is therefore 6.4 atlas pixels; passing 10 through raw drew
    // 15.625 — every gap 56.25% wider than the style asks for, at every resolution.
    expect(glyphScaleForComposition({ fontSize: 800, compositionHeightPx: 1_080, atlasFontSizePx: 512 }))
      .toBe(1.5625);
    expect(atlasSpacingAt(10, 800, 1_080)).toBe(6.4);
    expect(10 * 1.5625).toBe(15.625);
  });

  it('lands the composition-space spacing the shipped renderer writes, at every size and rung', () => {
    // `getResponsiveScaledValue(customization.letterSpacing)` in SubtitledVideo.tsx: the persisted
    // value scales with composition height exactly as fontSize does. Round-tripping through the
    // glyph scale must give that number back.
    const composed = (letterSpacing, fontSize, height) => {
      const atlasFontSizePx = Math.min(Math.max(fontSize, 4), 512);
      const scale = glyphScaleForComposition({ fontSize, compositionHeightPx: height, atlasFontSizePx });
      return atlasSpacingAt(letterSpacing, fontSize, height) * scale;
    };
    expect(composed(10, 800, 1_080)).toBe(scaleSubtitleStyleValue(10, 1_080));
    expect(composed(10, 800, 2_160)).toBeCloseTo(scaleSubtitleStyleValue(10, 2_160), 9);
    expect(composed(10, 50, 720)).toBeCloseTo(scaleSubtitleStyleValue(10, 720), 9);
    expect(composed(-4, 28, 4_320)).toBeCloseTo(scaleSubtitleStyleValue(-4, 4_320), 9);
  });

  it('leaves a font size the clamp does not bite at exactly where it was', () => {
    // The unclamped path is the one every existing project is on, and it must not move.
    expect(atlasSpacingAt(10, 50, 1_080)).toBe(10);
    expect(atlasSpacingAt(0, 28, 1_080)).toBe(0);
    expect(atlasSpacingAt(-2, 28, 1_080)).toBe(-2);
  });

  it('has no atlas-space value to give when the inputs cannot produce one', () => {
    expect(atlasLetterSpacingPx({ letterSpacing: undefined, compositionHeightPx: 1_080, glyphScale: 1 })).toBeNull();
    expect(atlasLetterSpacingPx({ letterSpacing: 10, compositionHeightPx: 0, glyphScale: 1 })).toBeNull();
    expect(atlasLetterSpacingPx({ letterSpacing: 10, compositionHeightPx: 1_080, glyphScale: 0 })).toBeNull();
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

  it('associates the crop ratio the way Rust does, which the deleted preview did not', () => {
    // dimensions.rs records this exact crop as one where the shipped preview composed 682 and
    // everything downstream composed 684, because floating-point multiplication is not associative.
    const derived = compositionSize({
      resolution: '1080p',
      sourceWidthPx: 1_920,
      sourceHeightPx: 1_080,
      crop: { width: 10.01, height: 28.16 },
    });
    const deletedPreviewAssociation = Math.round(
      1_080 * ((1_920 / 1_080) * ((10.01 / 100) / (28.16 / 100))),
    );
    expect(derived.widthPx).toBe(684);
    expect(deletedPreviewAssociation).toBe(682);
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
});

/**
 * The timeline the preview shares with the export, which is the TRIMMED one.
 *
 * `RenderRequest::validate` in `crates/osg-render/src/contract.rs` derives `duration_frames` from
 * `trim_end_us - trim_start_us`, and `crates/osg-export/src/convert/timeline.rs` offsets the source
 * grid to `trim_start` while the scene grid starts at zero. A preview that counted frames from the
 * `<video>` element's duration and indexed from the raw playhead — which is what this file used to
 * do — asks for a different instant than the export renders for every trimmed project.
 */
describe('the trimmed timeline mirrors RenderRequest::validate', () => {
  /** `duration_frames`, transcribed from contract.rs and computed in whole microseconds. */
  const exportFrameCount = (trimStart, trimEnd, fps) => Math.ceil(
    (Math.round((trimEnd - trimStart) * 1e6) * fps) / 1e6,
  );

  it('counts the frames of the trim window, not of the source', () => {
    expect(previewTimeline({ frameRate: 30, durationSeconds: 10 }).frameCount).toBe(300);
    expect(previewTimeline({
      frameRate: 30, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
    }).frameCount).toBe(exportFrameCount(2, 8, 30));
    expect(previewTimeline({
      frameRate: 30, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
    }).frameCount).toBe(180);
  });

  it('reads a trimEnd of zero as the end of the source, exactly as normalizeSettings does', () => {
    const whole = previewTimeline({ frameRate: 25, durationSeconds: 12, trimEndSeconds: 0 });
    expect(whole).toMatchObject({ frameCount: 300, trimStartSeconds: 0, trimEndSeconds: 12 });
  });

  it('keeps 29.97 on the exact grid rather than on 30', () => {
    // 6s at 30000/1001 is 179.82 frames, so the window is 180 frames long and the last one runs
    // slightly past trimEnd. Rounding the rate to 30 would give the same count here and drift apart
    // over a longer window, which is exactly what the rational grid exists to prevent.
    const timeline = previewTimeline({
      frameRate: 29.97, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
    });
    expect(timeline).toMatchObject({ fpsNumerator: 30_000, fpsDenominator: 1_001, frameCount: 180 });
    expect(previewTimeline({ frameRate: 29.97, durationSeconds: 3_600 }).frameCount).toBe(107_893);
  });

  it('refuses a window the render contract would refuse, rather than repairing it', () => {
    const base = { frameRate: 30, durationSeconds: 10 };
    // trim_start_us >= trim_end_us
    expect(previewTimeline({ ...base, trimStartSeconds: 8, trimEndSeconds: 8 })).toBeNull();
    expect(previewTimeline({ ...base, trimStartSeconds: 9, trimEndSeconds: 4 })).toBeNull();
    // trim_end_us > source_duration_us
    expect(previewTimeline({ ...base, trimEndSeconds: 11 })).toBeNull();
    // No source duration yet, and a frame rate the ladder does not offer.
    expect(previewTimeline({ frameRate: 30, durationSeconds: 0 })).toBeNull();
    expect(previewTimeline({ frameRate: 30, durationSeconds: null })).toBeNull();
    expect(previewTimeline({ frameRate: 30.5, durationSeconds: 10 })).toBeNull();
  });
});

describe('the frame a playhead lands on', () => {
  const untrimmed = previewTimeline({ frameRate: 30, durationSeconds: 10 });
  const trimmed = previewTimeline({
    frameRate: 30, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
  });

  it('floors a source timestamp onto the frame that covers it, on an untrimmed project', () => {
    expect(frameIndexForTime(0, untrimmed)).toBe(0);
    expect(frameIndexForTime(1 / 30 - 1e-9, untrimmed)).toBe(0);
    expect(frameIndexForTime(1 / 30, untrimmed)).toBe(1);
    expect(frameIndexForTime(2, untrimmed)).toBe(60);
    // The last frame the composition has, and the last instant that lands on it.
    expect(frameIndexForTime(10 - 1e-9, untrimmed)).toBe(299);
  });

  it('indexes the trimmed composition, which is the one the export writes', () => {
    // The export renders wall-clock t as floor((t - trimStart) * fps): the scene timeline starts at
    // zero where the source starts at trimStart.
    const exportIndex = (t, trimStart, fps) => Math.floor((t - trimStart) * fps);

    expect(frameIndexForTime(2, trimmed)).toBe(exportIndex(2, 2, 30));
    expect(frameIndexForTime(5, trimmed)).toBe(exportIndex(5, 2, 30));
    expect(frameIndexForTime(5, trimmed)).toBe(90);
    expect(frameIndexForTime(2.05, trimmed)).toBe(exportIndex(2.05, 2, 30));
    expect(frameIndexForTime(2.05, trimmed)).toBe(1);
    // What the trim-blind derivation did: the raw playhead against the raw duration. It names a
    // frame 60 later than the export's, on a timeline 120 frames longer than the export's.
    expect(frameIndexForTime(5, untrimmed)).toBe(150);
  });

  it('keeps the same wall-clock instant on the same frame at 29.97', () => {
    const rational = previewTimeline({
      frameRate: 29.97, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
    });
    expect(frameIndexForTime(5, rational)).toBe(Math.floor(((5 - 2) * 30_000) / 1_001));
    expect(frameIndexForTime(5, rational)).toBe(89);
    expect(frameIndexForTime(8, rational)).toBe(179);
  });

  /**
   * The decision this file makes about a playhead the export does not cover.
   *
   * `null`, not a clamp. Frame 0 and frame `frameCount - 1` are both real exported frames, so
   * clamping to one would put an exported pixel on screen at an instant it is not the pixel for,
   * which looks exactly like a correct preview. The caller goes dormant and shows the `<video>`.
   */
  it('has no frame for a playhead outside the trim window, and says which side', () => {
    expect(frameIndexForTime(1.9, trimmed)).toBeNull();
    expect(previewPlayhead(1.9, trimmed).placement).toBe(PREVIEW_PLAYHEAD.beforeWindow);
    expect(frameIndexForTime(0, trimmed)).toBeNull();
    expect(frameIndexForTime(8.000001, trimmed)).toBeNull();
    expect(previewPlayhead(8.000001, trimmed).placement).toBe(PREVIEW_PLAYHEAD.afterWindow);
    expect(frameIndexForTime(10, trimmed)).toBeNull();
    // The same rule on an untrimmed project, whose window is the whole source.
    expect(frameIndexForTime(10.5, untrimmed)).toBeNull();
    expect(frameIndexForTime(-5, untrimmed)).toBeNull();
    expect(previewPlayhead(-5, untrimmed).placement).toBe(PREVIEW_PLAYHEAD.beforeWindow);
  });

  /**
   * THE CLAMP THE EXPORT HAS NO COUNTERPART FOR.
   *
   * This used to end in `Math.min(index, frameCount - 1)`. `run_export` walks
   * `0..plan.frame_count()` and never clamps, and the render timeline refuses
   * `frame_index >= composition.frame_count()` outright, so the clamp was the preview inventing an
   * answer for an instant neither of them has one for.
   *
   * The window is closed at both ends and `frameCount` is a CEILING, so `trimEnd` itself is inside
   * the window and one past the last index whenever the window is an exact number of frames long.
   * That is a real state and it now has a name, because calling it "outside the trim" would be
   * reporting a different fact than the true one.
   */
  it('has no frame at the closing instant, which the clamp used to answer with the last frame', () => {
    expect(Math.floor(10 * 30)).toBe(untrimmed.frameCount);
    expect(frameIndexForTime(10, untrimmed)).toBeNull();
    expect(previewPlayhead(10, untrimmed).placement).toBe(PREVIEW_PLAYHEAD.pastLastFrame);
    // The trimmed window closes the same way: floor((8 - 2) * 30) is 180 and the window has 180
    // frames, so the closing instant is one past frame 179.
    expect(frameIndexForTime(8, trimmed)).toBeNull();
    expect(previewPlayhead(8, trimmed).placement).toBe(PREVIEW_PLAYHEAD.pastLastFrame);
    // A rational rate whose window is NOT a whole number of frames still reaches its last frame:
    // 6s at 30000/1001 is 179.82 frames, so 179 covers the closing instant and is inside.
    const rational = previewTimeline({
      frameRate: 29.97, durationSeconds: 10, trimStartSeconds: 2, trimEndSeconds: 8,
    });
    expect(previewPlayhead(8, rational)).toEqual({ placement: PREVIEW_PLAYHEAD.inside, frameIndex: 179 });
  });

  /**
   * The duration the review measured, where the two sides count differently.
   *
   * The element reports 12.345 s and MF reports a shorter one; at 30 fps this timeline has 371
   * frames and its largest index is 370 while the native composition has 369 and refuses anything
   * past 368. The clamp did not make that safe — it clamped to 370, which the native side still has
   * no frame for. What this module can promise is the half it owns: never an index its own timeline
   * does not contain, so the remaining disagreement arrives as a stated refusal instead of as a
   * frame drawn for the wrong instant.
   */
  it('never names an index its own timeline does not contain', () => {
    const measured = previewTimeline({ frameRate: 30, durationSeconds: 12.345 });
    expect(measured.frameCount).toBe(371);
    for (const seconds of [0, 6.1, 12.3, 12.333, 12.3437, 12.345, 12.4]) {
      const index = frameIndexForTime(seconds, measured);
      expect(index === null || (index >= 0 && index < measured.frameCount)).toBe(true);
    }
    expect(frameIndexForTime(12.345, measured)).toBe(370);
    expect(frameIndexForTime(12.4, measured)).toBeNull();
  });

  it('has no frame at all without a timeline to index into', () => {
    expect(frameIndexForTime(1, null)).toBeNull();
    expect(previewPlayhead(1, null).placement).toBe(PREVIEW_PLAYHEAD.unknown);
    expect(frameIndexForTime(Number.NaN, untrimmed)).toBeNull();
    // A hand-assembled grid carries no window, so it cannot say whether an instant is inside one.
    expect(frameIndexForTime(1, { fpsNumerator: 30, fpsDenominator: 1, frameCount: 300 })).toBeNull();
    expect(previewPlayhead(1, { fpsNumerator: 30, fpsDenominator: 1, frameCount: 300 }).placement)
      .toBe(PREVIEW_PLAYHEAD.unknown);
  });
});
