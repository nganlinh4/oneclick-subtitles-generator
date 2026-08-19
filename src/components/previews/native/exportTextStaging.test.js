import { v7 as uuidv7 } from 'uuid';

import { invokeDesktopRaw } from '../../../platform/desktopRuntime';
import { bakeGlyphAtlas, bakeGlyphAtlasForCues } from '../../../platform/glyphAtlas';
import { stageGlyphAtlas } from '../../../platform/glyphAtlasStaging';
import {
  buildNativeRenderRequest,
  createNativeRenderService,
} from '../../../platform/renderService';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';
import { stageNativeRenderText } from './exportTextStaging';
import { atlasBakeRequest, previewFace } from './nativePreviewScene';

/**
 * What this suite proves: an export produces the atlas pages and the n runs `render_start` reads,
 * that every run indexes the page it names, that the preview's own atlas is reused rather than
 * staged twice, and that a font the editor cannot resolve stops the export by name instead of
 * writing a file in a substitute.
 *
 * The atlas is baked by the real baker against a measurement surface, because staging validates a
 * descriptor field by field and a hand-written stand-in would prove nothing about it.
 */

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('../../../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
  isDesktopRuntime: vi.fn(() => true),
}));

const EXPORT_FAMILY = 'Arial';

/** Three generics an engine resolves to different metrics, plus the family the export asks for. */
const GENERIC_RATIOS = [
  ['monospace', 0.6],
  ['serif', 0.55],
  ['sans-serif', 0.5],
];
const ADVANCE_RATIO = new Map([...GENERIC_RATIOS, [EXPORT_FAMILY.toLowerCase(), 0.52]]);
/** The same engine with no such family installed: every chain measures as its generic alone. */
const SUBSTITUTING_RATIO = new Map(GENERIC_RATIOS);

const parseCssFont = (cssFont) => {
  const match = /^(?:normal|italic|oblique) \d+ ([\d.]+)px (.+)$/.exec(cssFont);
  if (match === null) throw new Error('fake surface cannot parse a font shorthand');
  return {
    fontSizePx: Number(match[1]),
    families: match[2].split(',').map((family) => family.trim().replace(/^"|"$/g, '').toLowerCase()),
  };
};

const measureWith = (ratios) => (cssFont, text) => {
  const { fontSizePx, families } = parseCssFont(cssFont);
  const ratio = families
    .map((family) => ratios.get(family))
    .find((value) => value !== undefined) ?? 0.45;
  const width = fontSizePx * ratio * [...text].length;
  const inked = /\S/u.test(text);
  return {
    width,
    actualBoundingBoxLeft: inked ? -2 : 0,
    actualBoundingBoxRight: inked ? width * 0.9 : 0,
    actualBoundingBoxAscent: inked ? fontSizePx * 0.72 : 0,
    actualBoundingBoxDescent: inked ? fontSizePx * 0.18 : 0,
    fontBoundingBoxAscent: fontSizePx * 0.8,
    fontBoundingBoxDescent: fontSizePx * 0.2,
  };
};

const surface = {
  measure: measureWith(ADVANCE_RATIO),
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

const SOURCE_DIMENSIONS = Object.freeze({ widthPx: 1_920, heightPx: 1_080 });

const customization = (overrides = {}) => ({
  ...defaultCustomization,
  fontFamily: EXPORT_FAMILY,
  fontWeight: 400,
  ...overrides,
});

const renderRequest = (texts, overrides = {}) => buildNativeRenderRequest({
  sourceAsset: {
    id: uuidv7(),
    displayName: 'source.mp4',
    extension: 'mp4',
    sizeBytes: 4_096,
    kind: 'video',
  },
  projectId: uuidv7(),
  lyrics: texts.map((text, index) => ({
    id: index, start: index, end: index + 1, text,
  })),
  settings: {
    resolution: '1080p',
    frameRate: 30,
    originalAudioVolume: 100,
    narrationVolume: 0,
    trimStart: 0,
    trimEnd: 0,
  },
  customization: customization(overrides),
  crop: {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    canvasBgMode: 'solid',
    canvasBgColor: '#000000',
    canvasBgBlur: 24,
    flipX: false,
    flipY: false,
  },
});

/** The real baker, the real stager: only the measurement surface and the source size are injected. */
const stagingOptions = (overrides = {}) => ({
  sourceDimensions: SOURCE_DIMENSIONS,
  platform: 'windows',
  isSystemFaceInstalled: () => true,
  surface,
  ...overrides,
});

const exportFace = (request) => previewFace({
  fontFamily: request.customization.fontFamily,
  fontWeight: request.customization.fontWeight,
  platform: 'windows',
  isSystemFaceInstalled: () => true,
});

/** The bake request the module derives, rebuilt here from the same two shared functions. */
const cueBakeRequest = (request) => {
  const bake = atlasBakeRequest({
    customization: request.customization,
    text: '',
    compositionWidthPx: 1_920,
    compositionHeightPx: 1_080,
    face: exportFace(request),
  });
  const { text: _single, ...shared } = bake.request;
  return { ...shared, texts: request.lyrics.map((cue) => cue.text) };
};

const decodeFrame = (frame) => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const metadataBytes = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(frame.subarray(16, 16 + metadataBytes)));
};

/** Stands in for `glyph_atlas_stage`: reads the frame as Rust must, then echoes the identity. */
const acceptFrames = () => {
  invokeDesktopRaw.mockImplementation(
    async (_command, frame) => ({ atlasId: uuidv7(), contentHash: decodeFrame(frame).contentHash }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  acceptFrames();
});

describe('staging the text an export draws with', () => {
  test('produces one run per cue, in cue order, indexing the staged atlas', async () => {
    const request = renderRequest(['alpha', 'beta gamma', 'delta']);
    const text = await stageNativeRenderText(request, stagingOptions());

    expect(Object.keys(text)).toEqual([
      'schemaVersion', 'face', 'pages', 'cues',
    ]);
    expect(text.schemaVersion).toBe(2);
    expect(text.face).toEqual({
      family: EXPORT_FAMILY,
      source: expect.stringContaining(EXPORT_FAMILY),
      weight: 400,
    });
    expect(text.cues).toHaveLength(request.lyrics.length);

    // Cue order, checked by content: a cell is a whole shaped LINE, so each of these one-line cues
    // places exactly one, and the three cells are the three cue texts.
    expect(text.cues.map((cue) => cue.lines[0].glyphs.length)).toEqual([1, 1, 1]);
    expect(Object.keys(text.cues[0].lines[0])).toEqual([
      'glyphs', 'penXPx', 'advanceWidthPx', 'baselineYPx',
    ]);

    // One page here, and its identity is the frame that was uploaded.
    expect(text.pages).toHaveLength(1);
    const staged = decodeFrame(invokeDesktopRaw.mock.calls[0][1]);
    expect(staged.contentHash).toBe(text.pages[0].atlasContentHash);
    expect(text.cues.map((cue) => cue.page)).toEqual([0, 0, 0]);
    const cellCount = staged.glyphs.length;
    const everyCell = text.cues.flatMap((cue) => cue.lines.flatMap((line) => line.glyphs));
    expect(everyCell.length).toBeGreaterThan(0);
    expect(everyCell.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < cellCount))
      .toBe(true);
  });

  test('the payload is exactly what render_start accepts, and reaches it unchanged', async () => {
    const request = renderRequest(['send me natively']);
    const text = await stageNativeRenderText(request, stagingOptions());

    const invokeCommand = vi.fn(async () => ({
      id: uuidv7(),
      kind: 'renderVideo',
      state: 'running',
      progress: { basisPoints: 0 },
      sequence: 1,
    }));
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: class {},
      isNativeRuntime: () => true,
    });
    await service.start(request, {}, { text });

    const [[command, payload]] = invokeCommand.mock.calls;
    expect(command).toBe('render_start');
    expect(payload.text).toEqual(text);
  });

  test('reuses the atlas the preview staged rather than staging a second one', async () => {
    const request = renderRequest(['one shared cue']);
    const face = previewFace({
      fontFamily: EXPORT_FAMILY,
      fontWeight: 400,
      platform: 'windows',
      isSystemFaceInstalled: () => true,
    });

    // The preview surface's own path: the same face, the same composition, the same bake request.
    const previewBake = atlasBakeRequest({
      customization: request.customization,
      text: 'one shared cue',
      compositionWidthPx: 1_920,
      compositionHeightPx: 1_080,
      face,
    });
    const previewHandle = await stageGlyphAtlas(bakeGlyphAtlas(previewBake.request, { surface }));
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);

    const text = await stageNativeRenderText(request, stagingOptions());

    // Content-addressed: the export baked the identical atlas, so no second upload happened and the
    // handle it sends is the handle the preview minted.
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
    expect(text.pages).toEqual([
      { atlasId: previewHandle.atlasId, atlasContentHash: previewHandle.contentHash },
    ]);
  });

  test('stages its own atlas when the preview has not staged one for these cues', async () => {
    const request = renderRequest(['never previewed at all']);
    const text = await stageNativeRenderText(request, stagingOptions());
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(1);
    expect(text.pages[0].atlasContentHash)
      .toBe(decodeFrame(invokeDesktopRaw.mock.calls[0][1]).contentHash);
  });

  test('stages every page and sends each cue against the page it was laid out on', async () => {
    // A left-to-right cue and a right-to-left one resolve to different alignments, and one atlas
    // carries one alignment — so this document is two pages. It used to be refused outright.
    const request = renderRequest(['left to right', 'שלום עולם'], { textAlign: 'left' });
    const text = await stageNativeRenderText(request, stagingOptions());

    expect(text.pages).toHaveLength(2);
    expect(text.cues.map((cue) => cue.page)).toEqual([0, 1]);
    // Two uploads, one per page, and the payload's identities are the ones that were uploaded.
    expect(invokeDesktopRaw).toHaveBeenCalledTimes(2);
    const uploaded = invokeDesktopRaw.mock.calls.map(([, frame]) => decodeFrame(frame));
    expect(text.pages.map((page) => page.atlasContentHash))
      .toEqual(uploaded.map((frame) => frame.contentHash));
    expect(new Set(text.pages.map((page) => page.atlasId)).size).toBe(2);

    // Each cue's cells are inside ITS page's table. Cue 1 indexes low cell numbers that also exist
    // on page 0, so checking against page 0 would pass while drawing entirely wrong glyphs.
    for (const [index, cue] of text.cues.entries()) {
      const cells = cue.lines.flatMap((line) => line.glyphs);
      const table = uploaded[cue.page].glyphs;
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell >= 0 && cell < table.length)).toBe(true);
      // The cells those indices name spell this cue's own text. A cell is a whole line, so the
      // lines read top to bottom ARE the cue — nothing is reordered on this side any more, because
      // the visual order is inside each line's raster.
      expect(cells.map((cell) => table[cell].cluster).join('\n'))
        .toBe(request.lyrics[index].text);
    }
  });

  test('copies the baker positions rather than deriving any', async () => {
    const request = renderRequest(['carry me']);
    const text = await stageNativeRenderText(request, stagingOptions());
    const { runs } = bakeGlyphAtlasForCues(cueBakeRequest(request), { surface });
    expect(text.cues[0].lines.map((line) => ({
      glyphs: [...line.glyphs],
      penXPx: [...line.penXPx],
      advanceWidthPx: line.advanceWidthPx,
      baselineYPx: line.baselineYPx,
    }))).toEqual(runs[0].lines.map((line) => ({
      glyphs: [...line.glyphs],
      penXPx: [...line.penXPx],
      advanceWidthPx: line.advanceWidthPx,
      baselineYPx: line.baselineYPx,
    })));
  });
});

describe('refusals that stop an export before it starts', () => {
  test('a font that cannot be resolved refuses by name and stages nothing', async () => {
    const request = renderRequest(['unrenderable'], { fontFamily: 'Fictional Display' });
    const bakeCues = vi.fn(bakeGlyphAtlasForCues);

    await expect(stageNativeRenderText(request, stagingOptions({ bakeCues })))
      .rejects.toMatchObject({
        code: 'renderFontUnresolved',
        message: expect.stringContaining('"Fictional Display"'),
      });
    expect(bakeCues).not.toHaveBeenCalled();
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  test('a face the engine substitutes refuses by name too', async () => {
    // The family resolves, and then the measurement says the engine drew something else. Same
    // refusal, one measurement later: the surface below knows no face at all.
    const request = renderRequest(['substituted']);
    const substitutingSurface = { ...surface, measure: measureWith(SUBSTITUTING_RATIO) };
    await expect(stageNativeRenderText(request, stagingOptions({ surface: substitutingSurface })))
      .rejects.toMatchObject({
        code: 'renderFontUnresolved',
        message: expect.stringContaining(`"${EXPORT_FAMILY}"`),
      });
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  test('a source with no known size refuses rather than assuming an aspect ratio', async () => {
    const request = renderRequest(['unknown size']);
    const measureSource = vi.fn(async () => null);
    await expect(stageNativeRenderText(request, stagingOptions({
      sourceDimensions: null,
      measureSource,
      source: 'https://example.invalid/video.mp4',
    }))).rejects.toMatchObject({ code: 'renderSourceSizeUnknown' });
    expect(measureSource).toHaveBeenCalledWith('https://example.invalid/video.mp4');
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });

  test('a run that indexes past the staged table is refused here, not by the compositor', async () => {
    const request = renderRequest(['out of range']);
    await expect(stageNativeRenderText(request, stagingOptions({
      bakeCues: (bakeRequest, options) => {
        const baked = bakeGlyphAtlasForCues(bakeRequest, options);
        const [first] = baked.runs;
        return {
          ...baked,
          runs: [{
            lines: [{ ...first.lines[0], glyphs: first.lines[0].glyphs.map(() => 100_000) }],
          }],
        };
      },
    }))).rejects.toMatchObject({
      code: 'renderTextStagingFailed',
      reason: 'glyphAtlasLayoutGeometry',
    });
  });

  test('a run count that disagrees with the cue count is refused', async () => {
    const request = renderRequest(['first', 'second']);
    await expect(stageNativeRenderText(request, stagingOptions({
      bakeCues: (bakeRequest, options) => {
        const baked = bakeGlyphAtlasForCues(bakeRequest, options);
        return { ...baked, runs: baked.runs.slice(0, 1), pageOfCue: baked.pageOfCue.slice(0, 1) };
      },
    }))).rejects.toMatchObject({
      code: 'renderTextStagingFailed',
      reason: 'glyphAtlasLayoutCount',
    });
  });

  test('a cue the baker will not stage refuses the whole export, not just that cue', async () => {
    // A cue that places no cell cannot be drawn at all, and no page can rescue it: the compositor
    // would refuse the run and name no cue.
    const request = renderRequest(['drawable', '\n']);
    await expect(stageNativeRenderText(request, stagingOptions()))
      .rejects.toMatchObject({ code: 'renderTextStagingFailed' });
    expect(invokeDesktopRaw).not.toHaveBeenCalled();
  });
});
