// Shared fixtures for the glyph-atlas staging suites: a discriminating measurement surface, real
// baked atlases, a frame decoder, a stand-in native command, and a descriptor at every limit.
import { invokeDesktopRaw } from './desktopRuntime';
import { GLYPH_ATLAS_LIMITS, GLYPH_ATLAS_VERSION, bakeGlyphAtlas } from './glyphAtlas';

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
    // Negative, and deliberately so. `actualBoundingBoxLeft` is positive going LEFT from the
    // alignment point, which the baker pins to the pen, so any glyph whose ink starts right of the
    // pen reports a negative value here — that is most glyphs in most real fonts. A stub that
    // returns 0 makes every downstream origin non-negative and hides a bound that rejects
    // ordinary text.
    actualBoundingBoxLeft: inked ? -2 : 0,
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

export const bake = (text, shaping = {}) => bakeGlyphAtlas(
  { text, face: { family: 'Editor Sans' }, fontSizePx: 48, ...shaping },
  { surface }
);

/** Private content used to prove no error path ever echoes the user's subtitle text. */
export const PRIVATE_TEXT = 'Bí mật';

export const atlasId = (index) => `018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f${index.toString(16).padStart(4, '0')}`;

export const decodeFrame = (frame) => {
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
export const acceptFrames = () => {
  let issued = 0;
  invokeDesktopRaw.mockImplementation(async (_command, frame) => {
    issued += 1;
    return { atlasId: atlasId(issued), contentHash: decodeFrame(frame).metadata.contentHash };
  });
};

/**
 * Measured from `descriptorAtLimits()` below, not estimated: 67,108,864 pixel bytes, 380,288 bytes
 * of glyph table plus layout, and a 16-byte header. Pinned as exact equalities so any change to the
 * frame or the metadata shape has to be re-measured deliberately rather than drifting.
 *
 * Forwarding the layout added 86,508 bytes to the worst case — the 64-line, 4096-cell run at every
 * magnitude bound. Metadata is still 36% of the 1 MiB metadata bound, and the frame is still refused
 * by the 32 MiB payload budget on its pixels alone, as it was before.
 */
export const WORST_CASE_METADATA_BYTES = 380_730;
export const WORST_CASE_TOTAL_BYTES = 67_489_610;


/**
 * The widest coordinate any layout field may carry, and the widest letter spacing, so the worst case
 * sits on the magnitude bounds rather than near them. Both are signed: a negative value is one
 * character longer on the wire as well as the case that must not be refused.
 */
const LIMIT_COORDINATE = GLYPH_ATLAS_LIMITS.maxLayoutWidthPx - 0.0001;
const LIMIT_SPACING = -(GLYPH_ATLAS_LIMITS.maxLetterSpacingPx - 0.0001);

/**
 * A layout on every bound `glyphAtlasShaping.js` publishes: the maximum 64 lines carrying the
 * maximum 4096 cells between them, every coordinate at its magnitude bound and every pen negative,
 * because that is both the widest encoding and the signedness this validation must admit.
 */
const layoutAtLimits = (glyphCount) => {
  const cellsPerLine = GLYPH_ATLAS_LIMITS.maxLayoutCells / GLYPH_ATLAS_LIMITS.maxLayoutLines;
  return {
    textTransform: 'capitalize',
    letterSpacingPx: LIMIT_SPACING,
    maxWidthPx: GLYPH_ATLAS_LIMITS.maxLayoutWidthPx,
    wordWrap: true,
    textAlign: 'justify',
    lineCount: GLYPH_ATLAS_LIMITS.maxLayoutLines,
    widthPx: LIMIT_COORDINATE,
    heightPx: LIMIT_COORDINATE,
    cellAdvanceLayout: 'refused',
    refusal: { shapingCrossesClusters: true, directionNeedsBidi: true },
    lines: Array.from({ length: GLYPH_ATLAS_LIMITS.maxLayoutLines }, (_unused, line) => ({
      glyphs: Array.from({ length: cellsPerLine }, (_cell, index) => (line * cellsPerLine + index) % glyphCount),
      penXPx: Array.from({ length: cellsPerLine }, () => -LIMIT_COORDINATE),
      advanceWidthPx: -LIMIT_COORDINATE,
      measuredWidthPx: LIMIT_COORDINATE,
      shapingResidualPx: -LIMIT_COORDINATE,
      baselineYPx: LIMIT_COORDINATE,
      justificationPx: LIMIT_COORDINATE,
      endsParagraph: line === GLYPH_ATLAS_LIMITS.maxLayoutLines - 1,
    })),
  };
};

/**
 * A descriptor sitting on every bound `glyphAtlas.js` publishes: a full 4096x4096 RGBA8 atlas, the
 * maximum 1024 cells, the maximum 32-code-point cluster per cell built from astral code points so
 * every cluster costs the full 4 UTF-8 bytes per code point, and the layout above. Without the
 * layout the measurement below would no longer be the worst case the wire can carry.
 */
export const descriptorAtLimits = () => {
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
      cssFont: 'W'.repeat(GLYPH_ATLAS_LIMITS.maxFamilyCharacters * 2),
      probes: [
        { probeFamily: 'serif', aloneWidthPx: 999_999.9999, chainedWidthPx: 1.0001, participated: true },
        { probeFamily: 'sans-serif', aloneWidthPx: 999_999.9999, chainedWidthPx: 2.0002, participated: true },
        { probeFamily: 'monospace', aloneWidthPx: 3.0003, chainedWidthPx: 3.0003, participated: false },
      ],
    },
    metrics: {
      ascentPx: 409.6001,
      descentPx: 102.4001,
      lineHeightPx: 512.0001,
      baselinePx: 409.6001,
      runAdvanceWidthPx: 999_999.9999,
      shapingResidualPx: -1_234.5678,
      baseDirection: 'rtl',
      letterSpacingPx: LIMIT_SPACING,
    },
    atlas: {
      widthPx: dimension,
      heightPx: dimension,
      paddingPx: GLYPH_ATLAS_LIMITS.maxPaddingPx,
      glyphCount,
      pixelFormat: 'rgba8',
      bytesPerRow: dimension * 4,
    },
    layout: layoutAtLimits(glyphCount),
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
