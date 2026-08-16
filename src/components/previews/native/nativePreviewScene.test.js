import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_VERSION } from '../../../platform/glyphAtlas';
import { createFakeSurface, lineTextsOf } from '../../../platform/glyphAtlasTestFont';
import { NATIVE_PREVIEW_SCENE_VERSION } from '../../../platform/nativePreviewFrames';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import {
  atlasBakeRequest,
  bakePreviewAtlas,
  buildPreviewScene,
  previewCueList,
  previewFace,
  selectPreviewCue,
} from './nativePreviewScene';

/**
 * `Editor Sans` in the injected font model advances 0.52 of the font size, so a 50px bake gives
 * every Latin cluster an advance of exactly 26px. A wrap width is then a cluster count and an
 * expectation is a number that can be checked by hand.
 */
const FACE = Object.freeze({ family: 'Editor Sans', source: 'system:windows|Editor Sans|400|normal', weight: 400 });
const surface = () => ({ surface: createFakeSurface() });

const customization = (overrides = {}) => ({
  ...defaultCustomization,
  fontFamily: 'Editor Sans',
  fontSize: 50,
  maxWidth: 80,
  textAlign: 'left',
  ...overrides,
});

/** Long enough that an 80% box wraps it several times at either resolution. */
const PARAGRAPH = Array.from({ length: 40 }, (_, index) => `word${String(index).padStart(2, '0')}`).join(' ');

describe('the maxWidth conversion, proven through a real bake at two resolutions', () => {
  const bakeAt = (compositionWidthPx, compositionHeightPx) => {
    const request = atlasBakeRequest({
      customization: customization(),
      text: PARAGRAPH,
      compositionWidthPx,
      compositionHeightPx,
      face: FACE,
    });
    return { request, descriptor: bakePreviewAtlas(request, surface()) };
  };

  it('wraps identically at 1080p and 4K, because one atlas serves both', () => {
    const hd = bakeAt(1_920, 1_080);
    const uhd = bakeAt(3_840, 2_160);

    expect(hd.request.glyphScale).toBe(1);
    expect(uhd.request.glyphScale).toBe(2);
    expect(hd.request.request.maxWidthPx).toBe(1_536);
    expect(uhd.request.request.maxWidthPx).toBe(1_536);

    expect(lineTextsOf(uhd.descriptor)).toEqual(lineTextsOf(hd.descriptor));
    expect(hd.descriptor.layout.lineCount).toBeGreaterThan(1);
  });

  it('would wrap differently if the composition-space width were passed straight through', () => {
    const hd = bakeAt(1_920, 1_080);
    // Exactly the mistake the ledger names: 80% of a 4K composition, in atlas pixels, unconverted.
    const passedThrough = bakePreviewAtlas(
      { request: { ...hd.request.request, maxWidthPx: 0.8 * 3_840 } },
      surface(),
    );
    expect(passedThrough.layout.maxWidthPx).toBe(3_072);
    expect(lineTextsOf(passedThrough)).not.toEqual(lineTextsOf(hd.descriptor));
    expect(passedThrough.layout.lineCount).toBeLessThan(hd.descriptor.layout.lineCount);
  });

  it('bakes at the unscaled style size so the atlas is resolution-independent', () => {
    expect(bakeAt(1_920, 1_080).request.atlasFontSizePx).toBe(50);
    expect(bakeAt(3_840, 2_160).request.atlasFontSizePx).toBe(50);
    expect(bakeAt(3_840, 2_160).descriptor.face.fontSizePx).toBe(50);
  });

  it('refuses to build a bake request when the wrap width cannot be derived', () => {
    expect(atlasBakeRequest({
      customization: customization({ maxWidth: 0 }),
      text: 'x',
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      face: FACE,
    })).toBeNull();
    expect(atlasBakeRequest({
      customization: customization({ fontSize: 0 }),
      text: 'x',
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      face: FACE,
    })).toBeNull();
  });

  it('clamps the bake size into the baker bounds and keeps the scale honest about it', () => {
    const request = atlasBakeRequest({
      customization: customization({ fontSize: 900 }),
      text: 'x',
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      face: FACE,
    });
    expect(request.atlasFontSizePx).toBe(512);
    // The compositor will scale a 512px atlas up to the 900px the style asks for.
    expect(request.glyphScale).toBeCloseTo(900 / 512, 12);
  });
});

describe('cue selection reproduces the shipped rule', () => {
  const cues = [
    { start: 0, end: 1, text: 'first' },
    { start: 0.5, end: 2, text: 'overlapping' },
    { start: 3, end: 4, text: 'third' },
  ];

  it('takes the first match, so an overlapping cue disappears rather than stacking', () => {
    expect(selectPreviewCue(cues, 0.75)?.text).toBe('first');
    expect(selectPreviewCue(cues, 1.5)?.text).toBe('overlapping');
  });

  it('widens the window by the fades, so a cue shows before its start and after its end', () => {
    expect(selectPreviewCue(cues, 3.5, { fadeInDuration: 0.3, fadeOutDuration: 0.3 })?.text).toBe('third');
    expect(selectPreviewCue(cues, 2.8)).toBeNull();
    expect(selectPreviewCue(cues, 2.8, { fadeInDuration: 0.3, fadeOutDuration: 0.3 })?.text).toBe('third');
    expect(selectPreviewCue(cues, 4.2, { fadeInDuration: 0.3, fadeOutDuration: 0.3 })?.text).toBe('third');
    expect(selectPreviewCue(cues, 4.4, { fadeInDuration: 0.3, fadeOutDuration: 0.3 })).toBeNull();
  });

  it('orders the list and drops cues the transport would refuse', () => {
    expect(previewCueList([
      { start: 5, end: 6, text: 'later' },
      { start: 1, end: 2, text: 'earlier' },
      { start: 1, end: 1, text: 'zero length' },
      { start: 2, end: 3, text: '' },
      { start: Number.NaN, end: 3, text: 'unusable' },
    ])).toEqual([
      { start: 1, end: 2, text: 'earlier' },
      { start: 5, end: 6, text: 'later' },
    ]);
  });
});

describe('the preview scene', () => {
  const timeline = { fpsNumerator: 30, fpsDenominator: 1, frameCount: 300 };

  it('carries exactly the cue the staged atlas holds a run for', () => {
    const scene = buildPreviewScene({
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      timeline,
      face: FACE,
      cue: { start: 1.25, end: 2.5, text: 'Preview' },
    });
    expect(scene.schemaVersion).toBe(NATIVE_PREVIEW_SCENE_VERSION);
    expect(scene.cues).toEqual([{
      text: 'Preview',
      start: { numerator: 1_250, denominator: 1_000 },
      end: { numerator: 2_500, denominator: 1_000 },
    }]);
  });

  it('is a legitimate scene with no cue on screen', () => {
    const scene = buildPreviewScene({
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      timeline,
      face: FACE,
      cue: null,
    });
    expect(scene.cues).toEqual([]);
  });

  it('refuses an odd composition edge, which the encoder cannot take', () => {
    expect(buildPreviewScene({
      compositionWidthPx: 1_921,
      compositionHeightPx: 1_080,
      timeline,
      face: FACE,
      cue: null,
    })).toBeNull();
  });
});

describe('the face is resolved or honestly absent', () => {
  it('declines a family with no verified byte source instead of substituting', () => {
    expect(previewFace({ fontFamily: 'Definitely Not Installed', fontWeight: 400, platform: 'windows' })).toBeNull();
    // A declared Windows face still needs a runtime probe; unverified is unavailable, not assumed.
    expect(previewFace({ fontFamily: 'Arial', fontWeight: 400, platform: 'windows' })).toBeNull();
  });

  it('carries the identity key as the face source when the face does resolve', () => {
    const face = previewFace({
      fontFamily: "'Arial', sans-serif",
      fontWeight: 400,
      platform: 'windows',
      isSystemFaceInstalled: () => true,
    });
    expect(face).toEqual({ family: 'Arial', source: 'system:windows|Arial|400|normal', weight: 400 });
  });
});

describe('the baked descriptor is the one the staging boundary accepts', () => {
  it('carries the current atlas version and a layout', () => {
    const request = atlasBakeRequest({
      customization: customization(),
      text: 'Preview',
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      face: FACE,
    });
    const descriptor = bakePreviewAtlas(request, surface());
    expect(descriptor.version).toBe(GLYPH_ATLAS_VERSION);
    expect(descriptor.layout.lines.length).toBe(1);
    expect(descriptor.layout.maxWidthPx).toBe(1_536);
  });
});
