import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import { invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_VERSION } from './glyphAtlas';
import { createGlyphAtlasStager } from './glyphAtlasStaging';
import {
  NATIVE_PREVIEW_DEFAULT_LAYER,
  NATIVE_PREVIEW_LAYERS,
  NATIVE_PREVIEW_LIMITS,
  NATIVE_PREVIEW_REQUEST_FIELDS,
  NATIVE_PREVIEW_SCHEMA_VERSION,
  NativePreviewFrameError,
  prepareNativePreviewRequest,
} from './nativePreviewRequest';
import { NATIVE_PREVIEW_RESPONSE_FIELDS } from './nativePreviewFrames';
import { buildNativeRenderRequest } from './renderService';

/**
 * What a preview frame request must be, checked without a transport and without a bridge.
 *
 * The atlas handle is minted by the real stager and the render request by the real builder, so what
 * is asserted here is the object the native command will actually receive rather than a stand-in
 * shaped like it. `nativePreviewFrames.test.js` owns the other half — dispatch, coalescing, caching,
 * teardown and the response — which is the same seam the two modules are split along.
 */

vi.mock('./desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

/** Private content, so no refusal below can be satisfied by echoing the user's own text. */
const PRIVATE_TEXT = 'Bí mật';

const ATLAS_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f0001';
const SOURCE_ASSET_ID = '019ffbea-26d5-7800-8e3b-69de8bff2d7d';
const PROJECT_ID = '019ffbea-40eb-7c3c-b2f3-214ca260a7cc';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const REQUEST_SOURCE = 'apps/desktop/src-tauri/src/preview/request.rs';
const PREVIEW_SOURCE = 'apps/desktop/src-tauri/src/preview.rs';
const CONTRACT_SOURCE = 'crates/osg-render/src/contract.rs';

const COMPOSITION = Object.freeze({ widthPx: 1_920, heightPx: 1_080 });
const FACE = Object.freeze({ family: 'Editor Sans', source: 'sha256:0f1e2d3c', weight: 400 });

/** The smallest descriptor `glyphAtlasStaging` accepts: no pixel of it is read by this module. */
const atlasDescriptor = () => ({
  version: GLYPH_ATLAS_VERSION,
  contentHash: 'a1b2c3d4',
  face: {
    requestedFamily: 'Editor Sans',
    weight: 400,
    style: 'normal',
    fontSizePx: 48,
    substituted: false,
    cssFont: 'normal 400 48px "Editor Sans"',
    probes: [
      { probeFamily: 'serif', aloneWidthPx: 100, chainedWidthPx: 80, participated: true },
      { probeFamily: 'sans-serif', aloneWidthPx: 90, chainedWidthPx: 80, participated: true },
      { probeFamily: 'monospace', aloneWidthPx: 80, chainedWidthPx: 80, participated: false },
    ],
  },
  metrics: {
    ascentPx: 36, descentPx: 9, lineHeightPx: 48, baselinePx: 36,
    runAdvanceWidthPx: 120, shapingResidualPx: 0, baseDirection: 'ltr', letterSpacingPx: 0,
  },
  atlas: { widthPx: 8, heightPx: 8, paddingPx: 2, glyphCount: 1, pixelFormat: 'rgba8', bytesPerRow: 32 },
  layout: {
    textTransform: 'none',
    letterSpacingPx: 0,
    maxWidthPx: null,
    wordWrap: true,
    textAlign: 'center',
    lineCount: 1,
    widthPx: 6,
    heightPx: 48,
    cellAdvanceLayout: 'reproduces',
    refusal: { shapingCrossesClusters: false, directionNeedsBidi: false },
    lines: [{
      glyphs: [0], penXPx: [0], advanceWidthPx: 6, measuredWidthPx: 6,
      shapingResidualPx: 0, baselineYPx: 36, justificationPx: 0, endsParagraph: true,
    }],
  },
  glyphs: [{
    cluster: 'A', direction: 'ltr', advanceWidthPx: 6,
    xPx: 0, yPx: 0, widthPx: 8, heightPx: 8, originXPx: 0, originYPx: 6, substituted: false,
  }],
  pixels: new Uint8ClampedArray(8 * 8 * 4),
});

/** The export's own request builder, so what crosses is what an export would be built from. */
const renderRequest = (overrides = {}) => buildNativeRenderRequest({
  sourceAsset: {
    id: SOURCE_ASSET_ID,
    displayName: 'source.mp4',
    extension: 'mp4',
    sizeBytes: 1_024,
    kind: 'video',
  },
  projectId: PROJECT_ID,
  lyrics: [{ id: 'cue-1', start: 0, end: 2, text: PRIVATE_TEXT }],
  settings: {
    resolution: '1080p',
    frameRate: 30,
    originalAudioVolume: 100,
    narrationVolume: 0,
    trimStart: 0,
    trimEnd: 0,
  },
  customization: { ...defaultCustomization },
  crop: { x: 0, y: 0, width: 100, height: 100, aspectRatio: null },
  ...overrides,
});

let atlas;
let RENDER;

const frameRequest = (frameIndex, overrides = {}) => ({
  render: RENDER,
  face: FACE,
  composition: COMPOSITION,
  atlas,
  frameIndex,
  ...overrides,
});

/** The code a refusal carries, with the error proved to be the module's own typed one. */
const refusalOf = (request) => {
  try {
    prepareNativePreviewRequest(request);
  } catch (error) {
    expect(error).toBeInstanceOf(NativePreviewFrameError);
    return error;
  }
  throw new Error('expected the preview frame request to be refused');
};

beforeAll(async () => {
  invokeDesktopRaw.mockResolvedValue({ atlasId: ATLAS_ID, contentHash: 'a1b2c3d4' });
  atlas = await createGlyphAtlasStager().stage(atlasDescriptor());
  RENDER = renderRequest();
});

describe('the field set that crosses the command boundary', () => {
  /**
   * The fields a `#[serde(rename_all = "camelCase")]` struct in `request.rs` reads, taken from that
   * file rather than transcribed from it.
   *
   * Every gate stayed green while this module sent a payload the native command could not
   * deserialize at all, because the frontend test asserted the JS key set against itself — freezing
   * a shape that could never work — and `check-tauri-command-contract.js` compares command *names*
   * and never argument shapes. So the assertion has to be made against the other side's own source.
   * `preview::request::tests` makes it from the other direction, out of this file's own source.
   */
  const structFields = (file, struct) => {
    const source = readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8');
    const start = source.indexOf(`struct ${struct} {`);
    if (start === -1) throw new Error(`${file} no longer declares ${struct}`);
    const body = source.slice(start, source.indexOf('\n}', start));
    const fields = [...body.matchAll(/^\s+pub(?:\(crate\))? (\w+):/gm)]
      .map(([, field]) => field.replace(/_(\w)/g, (_unused, letter) => letter.toUpperCase()));
    if (fields.length === 0) throw new Error(`${file} declares ${struct} with no fields`);
    return fields;
  };
  const rustFields = (struct) => structFields(REQUEST_SOURCE, struct);

  it('is exactly what `PreviewFrameRequest` deserialises, which is `deny_unknown_fields`', () => {
    const { payload } = prepareNativePreviewRequest(frameRequest(0));

    // Order included: the payload is written as a literal so its encoding — and therefore the
    // revision derived from it — is deterministic, and this is what keeps the declared field list
    // and that literal from drifting apart.
    expect(Object.keys(payload)).toEqual([...NATIVE_PREVIEW_REQUEST_FIELDS]);
    expect([...NATIVE_PREVIEW_REQUEST_FIELDS].sort()).toEqual(rustFields('PreviewFrameRequest').sort());
    expect(payload.schemaVersion).toBe(NATIVE_PREVIEW_SCHEMA_VERSION);
    // The one field the native side defaults, so its absence would still deserialize.
    expect(readFileSync(resolve(REPOSITORY_ROOT, REQUEST_SOURCE), 'utf8')).toContain('#[serde(default)]');
  });

  it('is exactly what `PreviewFrameResponse` serialises, and no more', () => {
    expect([...NATIVE_PREVIEW_RESPONSE_FIELDS].sort())
      .toEqual(rustFields('PreviewFrameResponse').sort());
  });

  it('names the schema version this build of the native command reads', () => {
    const source = readFileSync(resolve(REPOSITORY_ROOT, PREVIEW_SOURCE), 'utf8');
    const declared = /const PREVIEW_SCHEMA_VERSION: u32 = (\d+);/.exec(source);
    expect(declared).not.toBeNull();
    expect(Number(declared[1])).toBe(NATIVE_PREVIEW_SCHEMA_VERSION);
  });

  it('carries the export request and the resolved face, not a second description of them', () => {
    const { payload, composition, cacheKey } = prepareNativePreviewRequest(frameRequest(4));

    expect(payload.render).toBe(RENDER);
    expect(payload.face).toEqual(FACE);
    expect(payload.atlasId).toBe(ATLAS_ID);
    expect(payload.atlasContentHash).toBe('a1b2c3d4');
    expect(payload.frameIndex).toBe(4);
    // No atlas bytes cross this boundary: the atlas was staged once, by id, over the other command.
    expect(JSON.stringify(payload)).not.toContain('pixels');
    // The size the frame is expected at travels beside the payload rather than in it: the native
    // conversion derives the composition, and there is exactly one place that decision is made.
    expect(composition).toEqual(COMPOSITION);
    expect(cacheKey).toContain(`:${ATLAS_ID}:4:composited`);
    // The revision is an opaque identity on the native side: it is compared, never parsed, and the
    // shape `is_opaque_identity` accepts is bounded and control-free.
    expect(payload.sceneRevision).toMatch(/^[A-Za-z0-9\-_:]+$/);
    expect(payload.sceneRevision.length).toBeLessThanOrEqual(NATIVE_PREVIEW_LIMITS.maxIdentityBytes);
  });

  it('checks the render request against the shape the render contract deserialises', () => {
    // This module states the render request's shape to refuse one it was not handed by the export's
    // builder, and `RenderRequest` is `deny_unknown_fields` too. Both statements are read from that
    // contract's own source rather than transcribed, so the exact-key check here cannot go stale.
    expect(Object.keys(RENDER).sort()).toEqual(structFields(CONTRACT_SOURCE, 'RenderRequest').sort());
    expect(Object.keys(RENDER.lyrics[0]).sort())
      .toEqual(structFields(CONTRACT_SOURCE, 'RenderLyric').sort());
  });

  it('names one revision per picture, and a different one for every picture', () => {
    const revisionOf = (request) => prepareNativePreviewRequest(request).sceneRevision;
    const base = revisionOf(frameRequest(0));

    // The frame index is not the picture: two frames of one revision share it, which is what lets a
    // late frame be recognised as belonging to the text that was on screen when it was asked for.
    expect(revisionOf(frameRequest(9))).toBe(base);
    expect(revisionOf(frameRequest(0, { face: { ...FACE, weight: 700 } }))).not.toBe(base);
    expect(revisionOf(frameRequest(0, { composition: { widthPx: 1_280, heightPx: 720 } }))).not.toBe(base);
    expect(revisionOf(frameRequest(0, {
      render: renderRequest({ customization: { ...defaultCustomization, fontSize: 64 } }),
    }))).not.toBe(base);
  });
});

describe('what a request must be', () => {
  it('refuses a shape or an atlas handle this module did not mint', () => {
    for (const request of [
      { ...frameRequest(0), extra: true },
      { render: RENDER, frameIndex: 0 },
      null,
    ]) {
      expect(refusalOf(request).code).toBe('nativePreviewInvalidRequest');
    }
    for (const forged of [{ ...atlas }, { atlasId: ATLAS_ID, contentHash: 'a1b2c3d4' }, null]) {
      expect(refusalOf(frameRequest(0, { atlas: forged })).code).toBe('nativePreviewInvalidAtlas');
    }
  });

  it('refuses a frame index no converted timeline could have', () => {
    for (const frameIndex of [-1, NATIVE_PREVIEW_LIMITS.maxFrameIndex + 1, 1.5, '0', Number.NaN]) {
      expect(refusalOf(frameRequest(frameIndex)).code).toBe('nativePreviewInvalidRequest');
    }
    // The exact bound is the converted timeline's, and that is derived natively from the source, so
    // an index this side cannot rule out is left to the command rather than guessed at here.
    expect(prepareNativePreviewRequest(frameRequest(NATIVE_PREVIEW_LIMITS.maxFrameIndex)).payload.frameIndex)
      .toBe(NATIVE_PREVIEW_LIMITS.maxFrameIndex);
  });

  it('refuses a render request the staged atlas could not draw', () => {
    const cue = { id: 'cue-1', startUs: 0, endUs: 1_000_000, text: 'x' };
    const cases = [
      ['not a render request', { widthPx: 1_920 }],
      ['an unknown render field', { ...RENDER, extra: true }],
      // One staged atlas holds one laid-out run, so a second cue has no layout to be drawn from.
      ['two cues', { ...RENDER, lyrics: [cue, { ...cue, id: 'cue-2' }] }],
      ['a cue that is not one', { ...RENDER, lyrics: [{ text: 'x', start: 0, end: 1 }] }],
      ['an empty cue', { ...RENDER, lyrics: [{ ...cue, text: '' }] }],
      ['a cue that is too long', { ...RENDER, lyrics: [{ ...cue, text: 'x'.repeat(NATIVE_PREVIEW_LIMITS.maxCueTextBytes + 1) }] }],
      ['a cue that ends before it starts', { ...RENDER, lyrics: [{ ...cue, startUs: 2, endUs: 1 }] }],
      ['a cue list that is not one', { ...RENDER, lyrics: 'cue' }],
    ];

    for (const [label, render] of cases) {
      expect(refusalOf(frameRequest(0, { render })).code, label).toBe('nativePreviewInvalidRender');
    }
  });

  it('accepts an instant with no cue on screen, which is an ordinary frame', () => {
    const { payload } = prepareNativePreviewRequest(
      frameRequest(0, { render: { ...RENDER, lyrics: [] } }),
    );

    // The underlay, the crop and the canvas backfill are all still composed, so a cue-less instant
    // is a picture to render rather than a request to refuse. `PreviewFrameRequest::check` agrees.
    expect(payload.render.lyrics).toEqual([]);
  });

  it('refuses a face the compositor could not draw with', () => {
    const cases = [
      ['not a face', { family: 'Editor Sans', weight: 400 }],
      ['no family', { ...FACE, family: '' }],
      ['no byte source', { ...FACE, source: '' }],
      ['a control character', { ...FACE, source: 'sha256 ' }],
      ['an oversized family', { ...FACE, family: 'ê'.repeat(NATIVE_PREVIEW_LIMITS.maxFaceBytes) }],
      ['an unresolved weight', { ...FACE, weight: 450 }],
      ['a weight out of range', { ...FACE, weight: 1_000 }],
    ];

    for (const [label, face] of cases) {
      expect(refusalOf(frameRequest(0, { face })).code, label).toBe('nativePreviewInvalidFace');
    }
  });

  it('refuses a composition size the encoder could not take', () => {
    for (const composition of [
      { widthPx: 1_921, heightPx: 1_080 },
      { widthPx: 0, heightPx: 1_080 },
      { widthPx: 1_920, heightPx: NATIVE_PREVIEW_LIMITS.maxDimensionPx + 2 },
      { widthPx: 1_920 },
    ]) {
      expect(refusalOf(frameRequest(0, { composition })).code).toBe('nativePreviewInvalidRequest');
    }
  });

  it('refuses a layer this build does not draw rather than defaulting it', () => {
    for (const layer of ['overlay', 'COMPOSITED', '', null, 0]) {
      expect(refusalOf(frameRequest(0, { layer })).code).toBe('nativePreviewInvalidRequest');
    }
    expect(prepareNativePreviewRequest(frameRequest(0)).payload.layer).toBe(NATIVE_PREVIEW_DEFAULT_LAYER);
    expect(NATIVE_PREVIEW_LAYERS).toContain(NATIVE_PREVIEW_DEFAULT_LAYER);
    for (const layer of NATIVE_PREVIEW_LAYERS) {
      expect(prepareNativePreviewRequest(frameRequest(0, { layer })).payload.layer).toBe(layer);
    }
  });

  it('measures the payload against the transport budget and refuses one that exceeds it', () => {
    // Measured, not estimated. This was once pinned to an exact literal so that any change to what
    // crosses the boundary had to be re-measured deliberately — but the literal then broke when the
    // default font family got six characters longer, which is not a fact about the transport at all.
    // So the measurement is checked against the payload it actually describes: still exact, still
    // catches a measurement that counts the wrong thing, and no longer fails for unrelated edits.
    const withinBudget = prepareNativePreviewRequest(frameRequest(0));
    const encoded = new TextEncoder().encode(JSON.stringify(withinBudget.payload)).byteLength;
    expect(withinBudget.measurement.requestBytes).toBe(encoded);
    expect(withinBudget.measurement.requestBytes).toBeLessThan(NATIVE_PREVIEW_LIMITS.maxRequestBytes);
    expect(withinBudget.measurement.budgetBytes).toBe(NATIVE_PREVIEW_LIMITS.maxRequestBytes);

    // The render request is validated deeply by the builder that made it, so this module checks its
    // shape rather than every field inside it. The budget is what keeps that decision safe: whatever
    // a request carries, the IPC copy is bounded.
    const oversized = {
      ...RENDER,
      customization: {
        ...defaultCustomization,
        fontFamily: 'x'.repeat(NATIVE_PREVIEW_LIMITS.maxRequestBytes),
      },
    };
    const error = refusalOf(frameRequest(0, { render: oversized }));

    expect(error.code).toBe('nativePreviewRequestTooLarge');
    expect(error.measurement.budgetBytes).toBe(4_194_304);
    expect(error.measurement.requestBytes).toBeGreaterThan(4_194_304);
  });

  it('leaks no subtitle text and no family the user typed into any refusal', () => {
    const errors = [
      refusalOf(frameRequest(0, { face: { family: PRIVATE_TEXT, source: '', weight: 400 } })),
      refusalOf(frameRequest(0, {
        render: { ...RENDER, lyrics: [{ id: 'cue-1', startUs: 2, endUs: 1, text: PRIVATE_TEXT }] },
      })),
    ];

    for (const error of errors) {
      const exposed = `${error.message}${JSON.stringify(error, Object.keys(error))}`;
      expect(exposed).not.toContain(PRIVATE_TEXT);
    }
  });
});
