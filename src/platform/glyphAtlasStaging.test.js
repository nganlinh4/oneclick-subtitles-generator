import { invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_VERSION } from './glyphAtlas';
import {
  GLYPH_ATLAS_FRAME_MEDIA_TYPE,
  GLYPH_ATLAS_STAGE_COMMAND,
  GLYPH_ATLAS_STAGING_VERSION,
  createGlyphAtlasStager,
  isStagedGlyphAtlas,
  measureGlyphAtlasPayload,
  stageGlyphAtlas,
} from './glyphAtlasStaging';
import { acceptFrames, atlasId, bake, decodeFrame } from './glyphAtlasStagingTestFixtures';

/**
 * The atlases under test are baked by the real `bakeGlyphAtlas`, so this suite proves the staging
 * contract against exactly what the baker emits rather than against a hand-written stand-in.
 *
 * The measurement surface in `glyphAtlasStagingTestFixtures.js` is deliberately far simpler than
 * the font model in `glyphAtlas.test.js`: staging does not care about fallback, ink extents or
 * shaping, only that a descriptor is real. It only has to be *discriminating* — three generic
 * families with different advances, and a requested family different from all three — which is
 * what the baker's substitution probes require.
 */

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

beforeEach(() => {
  invokeDesktopRaw.mockReset();
  acceptFrames();
});

describe('staging one baked atlas', () => {
  it('sends a bounded, versioned frame and returns a typed handle', async () => {
    const descriptor = bake('Preview');
    const stager = createGlyphAtlasStager();

    const handle = await stager.stage(descriptor);

    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
    const [command, frame, headers] = invokeDesktopRaw.mock.calls[0];
    expect(command).toBe(GLYPH_ATLAS_STAGE_COMMAND);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(headers).toEqual({ 'x-osg-content-type': GLYPH_ATLAS_FRAME_MEDIA_TYPE });

    expect(isStagedGlyphAtlas(handle)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).toMatchObject({
      stagingVersion: GLYPH_ATLAS_STAGING_VERSION,
      atlasVersion: GLYPH_ATLAS_VERSION,
      atlasId: atlasId(1),
      contentHash: descriptor.contentHash,
      widthPx: descriptor.atlas.widthPx,
      heightPx: descriptor.atlas.heightPx,
      glyphCount: descriptor.atlas.glyphCount,
      payloadBytes: frame.length,
    });
    expect(isStagedGlyphAtlas({ ...handle })).toBe(false);
  });

  it('frames the atlas so the receiver can parse it without trusting a second length', async () => {
    const descriptor = bake('Preview');

    await createGlyphAtlasStager().stage(descriptor);
    const { magic, frameVersion, metadataBytes, metadata, pixels } = decodeFrame(
      invokeDesktopRaw.mock.calls[0][1]
    );

    expect(magic).toBe('OSGATLAS');
    expect(frameVersion).toBe(GLYPH_ATLAS_STAGING_VERSION);
    expect(metadataBytes).toBe(measureGlyphAtlasPayload(descriptor).metadataBytes);
    expect(metadata.atlasVersion).toBe(GLYPH_ATLAS_VERSION);
    expect(metadata.contentHash).toBe(descriptor.contentHash);
    expect(metadata.atlas).toEqual(descriptor.atlas);
    expect(pixels.length).toBe(descriptor.atlas.widthPx * descriptor.atlas.heightPx * 4);
    expect(pixels.every((byte, index) => byte === descriptor.pixels[index])).toBe(true);
  });

  it('carries only the fields the compositor needs and no path-shaped field at all', async () => {
    const descriptor = bake('Preview');

    await createGlyphAtlasStager().stage(descriptor);
    const { metadata } = decodeFrame(invokeDesktopRaw.mock.calls[0][1]);

    // `layout` is added deliberately rather than by loosening the assertion: this exact key set is
    // what stops a path-shaped field ever appearing in the payload.
    expect(Object.keys(metadata).sort()).toEqual([
      'atlas', 'atlasVersion', 'contentHash', 'face', 'frameVersion', 'glyphs', 'layout', 'metrics',
    ]);
    // `cssFont` and `probes` are WebView-internal evidence; Rust never shapes text.
    expect(Object.keys(metadata.face).sort()).toEqual([
      // cssFont and probes are the shaping evidence Rust re-derives the substitution verdict from.
      // They are measurements, never paths — that is what the assertion below still guards.
      'cssFont', 'fontSizePx', 'probes', 'requestedFamily', 'style', 'substituted', 'weight',
    ]);
    // `codePoints` is derivable from `cluster`; a second encoding of one identity can only disagree.
    expect(Object.keys(metadata.glyphs[0]).sort()).toEqual([
      'advanceWidthPx', 'cluster', 'direction', 'heightPx', 'originXPx', 'originYPx',
      'substituted', 'widthPx', 'xPx', 'yPx',
    ]);
    // The spacing the WebView actually laid out travels with the metrics, so the compositor never
    // re-derives it from a style field something else may have scaled.
    expect(Object.keys(metadata.metrics).sort()).toEqual([
      'ascentPx', 'baseDirection', 'baselinePx', 'descentPx', 'letterSpacingPx', 'lineHeightPx',
      'runAdvanceWidthPx', 'shapingResidualPx',
    ]);
    expect(Object.keys(metadata.layout).sort()).toEqual([
      'cellAdvanceLayout', 'heightPx', 'letterSpacingPx', 'lineCount', 'lines', 'maxWidthPx',
      'refusal', 'textAlign', 'textTransform', 'widthPx', 'wordWrap',
    ]);
    expect(Object.keys(metadata.layout.lines[0]).sort()).toEqual([
      'advanceWidthPx', 'baselineYPx', 'endsParagraph', 'glyphs', 'justificationPx',
      'measuredWidthPx', 'penXPx', 'shapingResidualPx',
    ]);
    expect(metadata.glyphs).toHaveLength(descriptor.atlas.glyphCount);
  });

  it('stages a glyph whose ink starts right of the pen, which is most real glyphs', async () => {
    // Regression. `actualBoundingBoxLeft` is positive going LEFT from the alignment point, and the
    // baker pins textAlign to 'left', so any glyph with a left side bearing wider than the padding
    // reports a negative originXPx. Validation used to bound origins to non-negative, which
    // rejected the atlas outright — so the native preview would have failed for ordinary text
    // while every test passed, because the measurement stub returned 0 for that metric.
    const descriptor = bake('Preview');
    const negative = descriptor.glyphs.filter((glyph) => glyph.originXPx < 0);
    expect(negative.length, 'the fixture must actually exercise a negative origin').toBeGreaterThan(0);

    const handle = await createGlyphAtlasStager().stage(descriptor);

    expect(handle.atlasId).toBeTruthy();
    const staged = decodeFrame(invokeDesktopRaw.mock.calls[0][1]);
    expect(staged.metadata.glyphs.some((glyph) => glyph.originXPx < 0)).toBe(true);
  });

  it('stages an inkless run as an empty atlas rather than refusing it', async () => {
    const descriptor = bake('   ');
    expect(descriptor.atlas.widthPx).toBe(0);

    const handle = await createGlyphAtlasStager().stage(descriptor);

    expect(handle.widthPx).toBe(0);
    expect(decodeFrame(invokeDesktopRaw.mock.calls[0][1]).pixels.length).toBe(0);
  });
});

describe('forwarding the authoritative layout', () => {
  /** Wrapped, justified, spaced and hard-broken: every layout field carries something to lose. */
  const SHAPED = Object.freeze({
    maxWidthPx: 300,
    textAlign: 'justify',
    letterSpacingPx: 1.5,
    textTransform: 'uppercase',
    wordWrap: true,
  });

  const stagedMetadata = async (descriptor) => {
    await createGlyphAtlasStager().stage(descriptor);
    return decodeFrame(invokeDesktopRaw.mock.calls[0][1]).metadata;
  };

  it('round-trips the whole layout, byte for byte, for a wrapped multi-line run', async () => {
    const descriptor = bake('Preview the wrapped subtitle line\nsecond paragraph here', SHAPED);
    expect(descriptor.layout.lineCount, 'the fixture must actually wrap').toBeGreaterThan(2);

    const metadata = await stagedMetadata(descriptor);

    expect(metadata.layout).toEqual(descriptor.layout);
    // Byte for byte, not merely field for field: the encoded metadata is what Rust parses, so key
    // order and number formatting have to survive as well as the values.
    expect(JSON.stringify(metadata.layout)).toBe(JSON.stringify(descriptor.layout));
    expect(metadata.metrics.letterSpacingPx).toBe(descriptor.metrics.letterSpacingPx);
  });

  it('carries the visual order the compositor draws in, cell by cell', async () => {
    const descriptor = bake('Preview the wrapped subtitle line\nsecond paragraph here', SHAPED);

    const metadata = await stagedMetadata(descriptor);

    // Every cell index names a real cell, and reading the lines top to bottom reproduces the baked
    // run. A line's cell is the line's own text with its trailing space stripped — that space hangs
    // outside the alignment box in CSS and is not part of the raster — so the breaks are what the
    // join puts back.
    const drawn = metadata.layout.lines
      .map((line) => line.glyphs.map((cell) => metadata.glyphs[cell].cluster).join(''))
      .join(' ');
    expect(drawn).toBe('Preview the wrapped subtitle line second paragraph here'.toUpperCase());
    for (const line of metadata.layout.lines) {
      // One cell per line, at the line origin: everything inside the line is inside the mask.
      expect(line.glyphs).toHaveLength(1);
      expect(line.penXPx).toEqual([0]);
      expect(line.glyphs.every((cell) => cell >= 0 && cell < descriptor.atlas.glyphCount)).toBe(true);
    }
  });

  it('stages a tightened run, whose letter spacing is negative', async () => {
    // The signedness regression this file already learned once. Letter spacing tighter than a
    // cluster's own advance is ordinary product input, and a non-negative bound would refuse it at
    // the boundary while every other test kept passing.
    //
    // `penXPx` is always zero now — a line's one cell sits at the line origin — but the validator
    // still bounds it by MAGNITUDE rather than range, because a descriptor is validated on arrival
    // and nothing obliges the thing that sent it to be this baker.
    const descriptor = bake('Tight preview', { letterSpacingPx: -30 });
    expect(descriptor.metrics.letterSpacingPx).toBe(-30);
    expect(descriptor.layout.letterSpacingPx).toBe(-30);
    // That the tightening reaches the raster is a measurement fact, and this suite's surface is a
    // transport fixture rather than a font model; `glyphAtlas.shaping.test.js` owns it.

    const handle = await createGlyphAtlasStager().stage(descriptor);

    expect(handle.atlasId).toBe(atlasId(1));
    const { metadata } = decodeFrame(invokeDesktopRaw.mock.calls[0][1]);
    expect(metadata.layout.lines[0].penXPx).toEqual([0]);
    expect(metadata.metrics.letterSpacingPx).toBe(-30);
  });

  it('keys deduplication on the content hash, which the layout is part of', async () => {
    const stager = createGlyphAtlasStager();
    const text = 'Preview the wrapped subtitle line';

    const wide = await stager.stage(bake(text, { ...SHAPED, maxWidthPx: 900 }));
    const narrow = await stager.stage(bake(text, { ...SHAPED, maxWidthPx: 200 }));
    const again = await stager.stage(bake(text, { ...SHAPED, maxWidthPx: 900 }));

    expect(narrow.contentHash).not.toBe(wide.contentHash);
    expect(again).toBe(wide);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(2);
  });
});


describe('deduplication by content hash', () => {
  it('reuses the staged handle for an unchanged text revision', async () => {
    const stager = createGlyphAtlasStager();
    const first = await stager.stage(bake('Unchanged revision'));
    const second = await stager.stage(bake('Unchanged revision'));

    expect(second).toBe(first);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
    expect(stager.size()).toBe(1);
  });

  it('stages again when the content hash changes', async () => {
    const stager = createGlyphAtlasStager();
    const first = await stager.stage(bake('Revision one'));
    const second = await stager.stage(bake('Revision two'));

    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.atlasId).not.toBe(first.atlasId);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(2);
    expect(stager.size()).toBe(2);
  });

  it('collapses concurrent stages of the same revision into one upload', async () => {
    const stager = createGlyphAtlasStager();
    const descriptor = bake('Concurrent revision');

    const [first, second] = await Promise.all([stager.stage(descriptor), stager.stage(descriptor)]);

    expect(second).toBe(first);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
  });

  it('deduplicates through the shared stager as well', async () => {
    const descriptor = bake('Shared stager revision');

    const first = await stageGlyphAtlas(descriptor);
    const second = await stageGlyphAtlas(bake('Shared stager revision'));

    expect(second).toBe(first);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently reused atlas once the bound is reached', async () => {
    const stager = createGlyphAtlasStager({ maxEntries: 2 });
    const first = await stager.stage(bake('Evicted revision'));
    await stager.stage(bake('Kept revision'));
    await stager.stage(bake('Newest revision'));

    expect(stager.size()).toBe(2);
    expect(stager.peek(first.contentHash)).toBeUndefined();
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(3);

    const restaged = await stager.stage(bake('Evicted revision'));

    expect(restaged).not.toBe(first);
    expect(restaged.contentHash).toBe(first.contentHash);
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(4);
    expect(() => createGlyphAtlasStager({ maxEntries: 0 })).toThrow(TypeError);
  });
});

