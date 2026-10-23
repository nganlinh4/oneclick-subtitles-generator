// Glyph-atlas staging refusals: layouts the compositor cannot draw, the payload budget, and
// every typed rejection the module can raise.
import { invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_LIMITS, GLYPH_ATLAS_VERSION } from './glyphAtlas';
import {
  GLYPH_ATLAS_STAGE_COMMAND,
  GLYPH_ATLAS_STAGING_ERROR_CODES,
  GLYPH_ATLAS_STAGING_LIMITS,
  GlyphAtlasStagingError,
  createGlyphAtlasStager,
  measureGlyphAtlasPayload,
} from './glyphAtlasStaging';
import {
  PRIVATE_TEXT,
  WORST_CASE_METADATA_BYTES,
  WORST_CASE_TOTAL_BYTES,
  acceptFrames,
  atlasId,
  bake,
  descriptorAtLimits,
} from './glyphAtlasStagingTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

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

beforeEach(() => {
  invokeDesktopRaw.mockReset();
  acceptFrames();
});


describe('refusing a layout the compositor could not draw', () => {
  const withFirstLine = (descriptor, changes) => ({
    ...descriptor,
    layout: {
      ...descriptor.layout,
      lines: descriptor.layout.lines.map((line, index) => (index === 0 ? { ...line, ...changes } : line)),
    },
  });

  const flatLine = (cells) => ({
    glyphs: Array.from({ length: cells }, () => 0),
    penXPx: Array.from({ length: cells }, () => 0),
    advanceWidthPx: 0,
    measuredWidthPx: 0,
    shapingResidualPx: 0,
    baselineYPx: 0,
    justificationPx: 0,
    endsParagraph: true,
  });

  const withLines = (descriptor, lineCount, cellsPerLine) => ({
    ...descriptor,
    layout: {
      ...descriptor.layout,
      lineCount,
      lines: Array.from({ length: lineCount }, () => flatLine(cellsPerLine)),
    },
  });

  const refusalOf = async (descriptor) => {
    const error = await rejectionOf(createGlyphAtlasStager().stage(descriptor));
    expect(error.code).toBe('glyphAtlasStagingInvalidDescriptor');
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
    // The refusal names a field path and nothing else: never a cluster, never a path.
    expect(error.message).not.toContain(PRIVATE_TEXT);
    expect(error.message).not.toContain('C:\\');
    return error;
  };

  it('refuses a line that names a cell the atlas does not carry', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    const outOfRange = withFirstLine(descriptor, {
      glyphs: descriptor.layout.lines[0].glyphs.map(() => descriptor.atlas.glyphCount),
    });

    const error = await refusalOf(outOfRange);

    expect(error.message).toBe(
      'The glyph atlas descriptor cannot be staged: layout.lines[0].glyphs names a cell that does not exist'
    );
  });

  it('refuses a line whose pen positions do not match its cells one for one', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    const short = withFirstLine(descriptor, { penXPx: descriptor.layout.lines[0].penXPx.slice(1) });

    const error = await refusalOf(short);

    expect(error.message).toBe(
      'The glyph atlas descriptor cannot be staged: layout.lines[0].penXPx disagrees with glyphs in length'
    );
  });

  it('refuses a lineCount that disagrees with the lines it counts', async () => {
    const descriptor = bake(PRIVATE_TEXT);

    const error = await refusalOf({
      ...descriptor,
      layout: { ...descriptor.layout, lineCount: descriptor.layout.lineCount + 1 },
    });

    expect(error.message).toContain('layout.lineCount disagrees with layout.lines');
  });

  it('refuses more lines than the compositor can stage', async () => {
    const descriptor = bake(PRIVATE_TEXT);

    const error = await refusalOf(withLines(descriptor, GLYPH_ATLAS_LIMITS.maxLayoutLines + 1, 1));

    expect(error.message).toContain('layout.lines is missing or exceeds the line bound');
  });

  it('refuses more laid-out cells than the compositor can stage', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    const perLine = GLYPH_ATLAS_LIMITS.maxLayoutCells / GLYPH_ATLAS_LIMITS.maxLayoutLines;

    // Every line is in bounds; only their sum is not, which is the bound the baker also enforces.
    const withinLines = withLines(descriptor, GLYPH_ATLAS_LIMITS.maxLayoutLines, perLine);
    await createGlyphAtlasStager().stage(withinLines);
    invokeDesktopRaw.mockClear();

    const error = await refusalOf(withLines(descriptor, GLYPH_ATLAS_LIMITS.maxLayoutLines, perLine + 1));

    expect(error.message).toContain('layout exceeds the laid-out cell bound');
  });

  it('refuses a layout that is missing outright, so the compositor never guesses one', async () => {
    const { layout: _dropped, ...withoutLayout } = bake(PRIVATE_TEXT);

    const error = await refusalOf(withoutLayout);

    expect(error.message).toContain('layout is not an object');
  });

  it('refuses metrics with no letter spacing, which the pen positions depend on', async () => {
    const descriptor = bake(PRIVATE_TEXT);
    const { letterSpacingPx: _dropped, ...metrics } = descriptor.metrics;

    const error = await refusalOf({ ...descriptor, metrics });

    expect(error.message).toContain('metrics.letterSpacingPx is not a finite number');
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
