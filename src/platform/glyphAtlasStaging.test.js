import { invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_LIMITS, GLYPH_ATLAS_VERSION, bakeGlyphAtlas } from './glyphAtlas';
import {
  GLYPH_ATLAS_FRAME_MEDIA_TYPE,
  GLYPH_ATLAS_STAGE_COMMAND,
  GLYPH_ATLAS_STAGING_ERROR_CODES,
  GLYPH_ATLAS_STAGING_LIMITS,
  GLYPH_ATLAS_STAGING_VERSION,
  GlyphAtlasStagingError,
  createGlyphAtlasStager,
  isStagedGlyphAtlas,
  measureGlyphAtlasPayload,
  stageGlyphAtlas,
} from './glyphAtlasStaging';

/**
 * The atlases under test are baked by the real `bakeGlyphAtlas`, so this suite proves the staging
 * contract against exactly what the baker emits rather than against a hand-written stand-in.
 *
 * The measurement surface below is deliberately far simpler than the font model in
 * `glyphAtlas.test.js`: staging does not care about fallback, ink extents or shaping, only that a
 * descriptor is real. It only has to be *discriminating* — three generic families with different
 * advances, and a requested family different from all three — which is what the baker's
 * substitution probes require.
 */

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

const ADVANCE_RATIO = new Map([
  ['monospace', 0.6],
  ['serif', 0.55],
  ['sans-serif', 0.5],
  ['editor sans', 0.52],
]);

const parseCssFont = (cssFont) => {
  const match = /^(?:normal|italic|oblique) \d+ ([\d.]+)px (.+)$/.exec(cssFont);
  if (match === null) throw new Error('fake surface cannot parse a font shorthand');
  return {
    fontSizePx: Number(match[1]),
    families: match[2].split(',').map((family) => family.trim().replace(/^"|"$/g, '').toLowerCase()),
  };
};

const measure = (cssFont, text) => {
  const { fontSizePx, families } = parseCssFont(cssFont);
  const ratio = families.map((family) => ADVANCE_RATIO.get(family)).find((value) => value !== undefined) ?? 0.45;
  const width = fontSizePx * ratio * [...text].length;
  const inked = /\S/u.test(text);
  return {
    width,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: inked ? width * 0.9 : 0,
    actualBoundingBoxAscent: inked ? fontSizePx * 0.72 : 0,
    actualBoundingBoxDescent: inked ? fontSizePx * 0.18 : 0,
    fontBoundingBoxAscent: fontSizePx * 0.8,
    fontBoundingBoxDescent: fontSizePx * 0.2,
  };
};

const surface = {
  measure,
  createTarget(widthPx, heightPx) {
    const pixels = new Uint8ClampedArray(widthPx * heightPx * 4);
    return {
      drawGlyph({ text, penXPx, baselineYPx }) {
        const alpha = 16 + (text.codePointAt(0) % 200);
        for (let y = Math.max(0, baselineYPx - 8); y < Math.min(heightPx, baselineYPx + 2); y += 1) {
          for (let x = Math.max(0, penXPx); x < Math.min(widthPx, penXPx + 8); x += 1) {
            const offset = (y * widthPx + x) * 4;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = alpha;
          }
        }
      },
      readPixels: () => pixels,
    };
  },
};

const bake = (text) => bakeGlyphAtlas(
  { text, face: { family: 'Editor Sans' }, fontSizePx: 48 },
  { surface }
);

/** Private content used to prove no error path ever echoes the user's subtitle text. */
const PRIVATE_TEXT = 'Bí mật';

const atlasId = (index) => `018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f${index.toString(16).padStart(4, '0')}`;

const decodeFrame = (frame) => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const metadataBytes = view.getUint32(12, true);
  return {
    magic: String.fromCharCode(...frame.subarray(0, 8)),
    frameVersion: view.getUint32(8, true),
    metadataBytes,
    metadata: JSON.parse(new TextDecoder().decode(frame.subarray(16, 16 + metadataBytes))),
    pixels: frame.subarray(16 + metadataBytes),
  };
};

/** Stands in for the native command: parses the frame exactly as Rust must, then echoes identity. */
const acceptFrames = () => {
  let issued = 0;
  invokeDesktopRaw.mockImplementation(async (_command, frame) => {
    issued += 1;
    return { atlasId: atlasId(issued), contentHash: decodeFrame(frame).metadata.contentHash };
  });
};

/**
 * Measured from `descriptorAtLimits()` below, not estimated: 67,108,864 pixel bytes, 293,780 bytes
 * of glyph table and a 16-byte header. Pinned as exact equalities so any change to the frame or the
 * metadata shape has to be re-measured deliberately rather than drifting.
 */
const WORST_CASE_METADATA_BYTES = 293_780;
const WORST_CASE_TOTAL_BYTES = 67_402_660;

const observedCodes = new Set();

const rejectionOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GlyphAtlasStagingError);
    observedCodes.add(error.code);
    return error;
  }
  throw new Error('expected staging to be rejected');
};

/**
 * A descriptor sitting on every bound `glyphAtlas.js` publishes: a full 4096x4096 RGBA8 atlas, the
 * maximum 1024 cells, and the maximum 32-code-point cluster per cell built from astral code points
 * so every cluster costs the full 4 UTF-8 bytes per code point.
 */
const descriptorAtLimits = () => {
  const dimension = GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx;
  const glyphCount = GLYPH_ATLAS_LIMITS.maxGlyphCount;
  const columns = 32;
  const cell = dimension / columns;
  return {
    version: GLYPH_ATLAS_VERSION,
    contentHash: 'ffffffff',
    face: {
      requestedFamily: 'W'.repeat(GLYPH_ATLAS_LIMITS.maxFamilyCharacters),
      weight: 1_000,
      style: 'oblique',
      fontSizePx: GLYPH_ATLAS_LIMITS.maxFontSizePx,
      substituted: true,
    },
    metrics: {
      ascentPx: 409.6001,
      descentPx: 102.4001,
      lineHeightPx: 512.0001,
      baselinePx: 409.6001,
      runAdvanceWidthPx: 999_999.9999,
      shapingResidualPx: -1_234.5678,
      baseDirection: 'rtl',
    },
    atlas: {
      widthPx: dimension,
      heightPx: dimension,
      paddingPx: GLYPH_ATLAS_LIMITS.maxPaddingPx,
      glyphCount,
      pixelFormat: 'rgba8',
      bytesPerRow: dimension * 4,
    },
    glyphs: Array.from({ length: glyphCount }, (_unused, index) => ({
      cluster: String.fromCodePoint(0x10000 + index).repeat(GLYPH_ATLAS_LIMITS.maxClusterCodePoints),
      direction: 'rtl',
      advanceWidthPx: 511.9999,
      xPx: (index % columns) * cell,
      yPx: Math.floor(index / columns) * cell,
      widthPx: cell,
      heightPx: cell,
      originXPx: 8,
      originYPx: 120,
      substituted: true,
    })),
    pixels: new Uint8ClampedArray(dimension * dimension * 4),
  };
};

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

    expect(Object.keys(metadata).sort()).toEqual([
      'atlas', 'atlasVersion', 'contentHash', 'face', 'frameVersion', 'glyphs', 'metrics',
    ]);
    // `cssFont` and `probes` are WebView-internal evidence; Rust never shapes text.
    expect(Object.keys(metadata.face).sort()).toEqual([
      'fontSizePx', 'requestedFamily', 'style', 'substituted', 'weight',
    ]);
    // `codePoints` is derivable from `cluster`; a second encoding of one identity can only disagree.
    expect(Object.keys(metadata.glyphs[0]).sort()).toEqual([
      'advanceWidthPx', 'cluster', 'direction', 'heightPx', 'originXPx', 'originYPx',
      'substituted', 'widthPx', 'xPx', 'yPx',
    ]);
    expect(metadata.glyphs).toHaveLength(descriptor.atlas.glyphCount);
  });

  it('stages an inkless run as an empty atlas rather than refusing it', async () => {
    const descriptor = bake('   ');
    expect(descriptor.atlas.widthPx).toBe(0);

    const handle = await createGlyphAtlasStager().stage(descriptor);

    expect(handle.widthPx).toBe(0);
    expect(decodeFrame(invokeDesktopRaw.mock.calls[0][1]).pixels.length).toBe(0);
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

describe('the payload budget', () => {
  it('measures the worst case the baker can produce and refuses it before any native call', async () => {
    const worstCase = descriptorAtLimits();

    const measured = measureGlyphAtlasPayload(worstCase);

    // Measured, not estimated: 4096x4096 RGBA8 plus the 1024-cell glyph table.
    expect(measured.pixelBytes).toBe(67_108_864);
    expect(measured.metadataBytes).toBe(WORST_CASE_METADATA_BYTES);
    expect(measured.totalBytes).toBe(WORST_CASE_TOTAL_BYTES);
    expect(measured.budgetBytes).toBe(GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes);
    expect(measured.withinBudget).toBe(false);
    expect(measured.metadataBytes).toBeLessThan(GLYPH_ATLAS_STAGING_LIMITS.maxMetadataBytes);

    const error = await rejectionOf(createGlyphAtlasStager().stage(worstCase));

    expect(error.code).toBe('glyphAtlasStagingPayloadTooLarge');
    expect(error.measurement.totalBytes).toBe(WORST_CASE_TOTAL_BYTES);
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  it('accepts an atlas that fits the budget', async () => {
    const measured = measureGlyphAtlasPayload(bake('Preview'));

    expect(measured.withinBudget).toBe(true);
    expect(measured.totalBytes).toBeLessThan(GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes);
  });
});

describe('refusals', () => {
  it('refuses a descriptor whose version this build does not implement', async () => {
    const descriptor = bake(PRIVATE_TEXT);

    const error = await rejectionOf(
      createGlyphAtlasStager().stage({ ...descriptor, version: GLYPH_ATLAS_VERSION + 1 })
    );

    expect(error.code).toBe('glyphAtlasStagingUnsupportedVersion');
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  it('refuses a descriptor whose pixels disagree with the atlas it declares', async () => {
    const descriptor = bake(PRIVATE_TEXT);

    const error = await rejectionOf(createGlyphAtlasStager().stage({
      ...descriptor,
      pixels: descriptor.pixels.slice(0, descriptor.pixels.length - 4),
    }));

    expect(error.code).toBe('glyphAtlasStagingInvalidDescriptor');
    expect(error.message).toContain('pixels length');
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  it('refuses a glyph cell that would sample outside the uploaded texture', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    // The first cluster of a sorted run is the space, whose cell is empty and can sample nothing;
    // the check has to bite on a cell that actually carries ink.
    const inked = descriptor.glyphs.findIndex((glyph) => glyph.widthPx > 0);
    const glyphs = descriptor.glyphs.map((glyph, index) => (
      index === inked ? { ...glyph, xPx: descriptor.atlas.widthPx } : glyph
    ));

    const error = await rejectionOf(createGlyphAtlasStager().stage({ ...descriptor, glyphs }));

    expect(error.code).toBe('glyphAtlasStagingInvalidDescriptor');
    expect(error.message)
      .toBe(`The glyph atlas descriptor cannot be staged: glyphs[${inked}] falls outside the atlas`);
  });

  it('surfaces a native failure as a typed error that leaks nothing', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    invokeDesktopRaw.mockRejectedValue(Object.assign(
      new Error(`C:\\Users\\owner\\AppData\\Roaming\\osg\\atlas.bin refused "${PRIVATE_TEXT}"`),
      { code: 'atlasUploadFailed', command: GLYPH_ATLAS_STAGE_COMMAND, cause: { argv: ['--secret'] } }
    ));

    const error = await rejectionOf(createGlyphAtlasStager().stage(descriptor));

    expect(error.code).toBe('glyphAtlasStagingRejected');
    expect(error.message).toBe('The desktop renderer did not accept the glyph atlas');
    // The native code is the only field carried across, and only because the desktop bridge has
    // already reduced it to a bounded identifier.
    expect(error.nativeCode).toBe('atlasUploadFailed');
    expect(error.cause).toBeUndefined();
    const exposed = `${error.message}${error.stack}${JSON.stringify(error, Object.keys(error))}`;
    expect(exposed).not.toContain(PRIVATE_TEXT);
    expect(exposed).not.toContain('C:\\');
    expect(exposed).not.toContain('argv');
  });

  it('refuses a native response that does not identify the atlas it staged', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    invokeDesktopRaw.mockResolvedValue({ atlasId: 'atlas-1', contentHash: descriptor.contentHash });

    const error = await rejectionOf(createGlyphAtlasStager().stage(descriptor));

    expect(error.code).toBe('glyphAtlasStagingRejected');
    expect(error.nativeCode).toBeUndefined();
  });

  it('refuses a native response that echoes a different revision', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    invokeDesktopRaw.mockResolvedValue({ atlasId: atlasId(9), contentHash: '00000000' });

    const stager = createGlyphAtlasStager();
    await rejectionOf(stager.stage(descriptor));

    expect(stager.size()).toBe(0);
  });

  it('declares every rejection code this module can raise', () => {
    expect([...observedCodes].sort()).toEqual([...GLYPH_ATLAS_STAGING_ERROR_CODES].sort());
  });
});
