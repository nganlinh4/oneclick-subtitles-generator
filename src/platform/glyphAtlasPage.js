/**
 * One atlas page: its cell table, its raster, and the layouts of the cues it serves.
 *
 * A page is exactly what a `GlyphAtlasDescriptor` has always been — the shape did not change when
 * paging arrived, and that is deliberate. Every native validator, the staging frame, the content
 * hash and the compositor's bind all still see one atlas with one cell table and one layout. Paging
 * is a decision about WHICH cues share a page, made in `glyphAtlasPaging.js`; this module is unaware
 * of it beyond being handed the cues that landed here.
 *
 * WHY LAYOUTS ARE REMAPPED RATHER THAN RE-LAID-OUT. A run is laid out once, against its own cells,
 * before any page exists — because the page a cue lands on depends on the alignment its layout
 * resolves to, and the layout cannot wait for a decision that depends on it. Cell INDICES are the
 * only part of a layout that a page can change, and remapping them is exact: the geometry, the
 * wrapping, the pen positions and the visual order were all decided from advances, never from an
 * index. So a cue draws the same picture whichever page it lands on, which is what lets the preview
 * bake one cue alone and still be a proof of the export.
 *
 * Determinism: no clocks, no RNG. The cell table is sorted, the pack walks it in that order, and the
 * hash folds every run the page carries.
 */

import { deepFreeze, fail, fnv1a32, hashText, round4 } from './glyphAtlasCore';

const canonicalizeLayout = (layout) => [
  `${layout.textTransform}|${layout.letterSpacingPx}|${layout.maxWidthPx ?? 'none'}`,
  `${layout.wordWrap ? 1 : 0}|${layout.textAlign}|${layout.cellAdvanceLayout}`,
  `${layout.lineCount}|${layout.widthPx}|${layout.heightPx}`,
  ...layout.lines.map((line) => [
    line.glyphs.join('.'), line.penXPx.join('.'), line.advanceWidthPx, line.measuredWidthPx,
    line.shapingResidualPx, line.baselineYPx, line.justificationPx, line.endsParagraph ? 1 : 0,
  ].join(',')),
];

/**
 * The descriptor's identity, as lines. Every run the page carries is folded in, the first through
 * the descriptor's own `layout` and the rest appended, so two pages that share a cell table but not
 * a set of layouts are two different atlases. A page serving one cue appends nothing, which is what
 * keeps a single-cue bake's hash the hash it has always had.
 */
const canonicalize = (descriptor, extraRuns) => {
  const glyphs = descriptor.glyphs.map((glyph) => [
    glyph.cluster, glyph.codePoints.join('.'), glyph.direction, glyph.advanceWidthPx,
    glyph.xPx, glyph.yPx, glyph.widthPx, glyph.heightPx,
    glyph.originXPx, glyph.originYPx, glyph.substituted ? 1 : 0,
  ].join(','));
  const { face, metrics, atlas } = descriptor;
  return [
    `v${descriptor.version}`,
    `${face.requestedFamily}|${face.weight}|${face.style}|${face.fontSizePx}|${face.substituted ? 1 : 0}`,
    `${metrics.ascentPx}|${metrics.descentPx}|${metrics.lineHeightPx}|${metrics.baselinePx}`,
    `${metrics.runAdvanceWidthPx}|${metrics.shapingResidualPx}|${metrics.baseDirection}`,
    `${metrics.letterSpacingPx}`,
    `${atlas.widthPx}|${atlas.heightPx}|${atlas.paddingPx}|${atlas.glyphCount}`,
    ...canonicalizeLayout(descriptor.layout),
    ...glyphs,
    ...extraRuns.flatMap(canonicalizeLayout),
  ].join('\n');
};

/**
 * Rewrite one run's cell indices from its own table into the page's.
 *
 * `localCells[index]` is the cell text the run's layout meant, and the page knows where that text
 * sits in its own sorted table. A miss is impossible by construction — the page's table is a
 * superset of every run it serves — so it is a fault rather than a condition, and it is raised
 * rather than papered over with a zero, which would draw the wrong glyph silently.
 */
const remapRun = (layout, localCells, pageIndexOf) => ({
  ...layout,
  lines: layout.lines.map((line) => ({
    ...line,
    glyphs: line.glyphs.map((local) => {
      const index = pageIndexOf.get(localCells[local]);
      if (index === undefined) {
        fail('glyphAtlasInvalidRequest', 'A laid-out cell is missing from its own atlas page');
      }
      return index;
    }),
  })),
});

/**
 * Rasterize the page's cells into one tightly packed RGBA8 buffer.
 *
 * The alpha channel is the coverage mask the compositor samples. An all-blank page packs to nothing
 * and carries a zero-length buffer rather than a 1x1 placeholder, because the descriptor's geometry
 * already says the atlas is empty and the compositor has its own answer for that.
 */
const rasterize = (surface, cssFont, glyphs, atlas) => {
  if (atlas.widthPx === 0 || atlas.heightPx === 0) return new Uint8ClampedArray(0);
  const target = surface.createTarget(atlas.widthPx, atlas.heightPx);
  for (const glyph of glyphs) {
    if (glyph.widthPx === 0 || glyph.heightPx === 0) continue;
    target.drawGlyph({
      cssFont,
      text: glyph.cluster,
      penXPx: glyph.xPx + glyph.originXPx,
      baselineYPx: glyph.yPx + glyph.originYPx,
    });
  }
  const raw = target.readPixels();
  const expected = atlas.widthPx * atlas.heightPx * 4;
  if (!ArrayBuffer.isView(raw) || raw.length !== expected) {
    fail('glyphAtlasSurfaceUnavailable', 'The measurement surface returned an atlas of the wrong size');
  }
  return raw instanceof Uint8ClampedArray
    ? raw
    : new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
};

/**
 * Build one page's descriptor and the remapped layouts of the cues it serves.
 *
 * `page` is `{ cellTexts, packed, cues }` from the partition. `runs` holds every cue's local layout
 * and local cell table, indexed as the whole document indexes cues. Returns
 * `{ descriptor, layouts }` where `layouts[i]` belongs to `page.cues[i]`.
 */
export const bakePage = ({ page, runs, shared }) => {
  const { cssFont, face, metrics, paddingPx, surface, version, measureCellText } = shared;
  const entries = page.cellTexts.map(measureCellText);
  const pageIndexOf = new Map(page.cellTexts.map((cellText, index) => [cellText, index]));
  const { packed } = page;

  const glyphs = entries.map((entry, index) => ({
    cluster: entry.cluster,
    codePoints: entry.codePoints,
    direction: entry.direction,
    advanceWidthPx: entry.advanceWidthPx,
    xPx: packed.placements[index].xPx,
    yPx: packed.placements[index].yPx,
    widthPx: entry.cell.widthPx,
    heightPx: entry.cell.heightPx,
    originXPx: entry.cell.originXPx,
    originYPx: entry.cell.originYPx,
    substituted: entry.substituted,
  }));

  const atlas = {
    widthPx: packed.widthPx,
    heightPx: packed.heightPx,
    paddingPx,
    glyphCount: glyphs.length,
    pixelFormat: 'rgba8',
    bytesPerRow: packed.widthPx * 4,
  };
  const pixels = rasterize(surface, cssFont, glyphs, atlas);

  const layouts = page.cues.map((cue) => remapRun(runs[cue].layout, runs[cue].cellTexts, pageIndexOf));
  const first = runs[page.cues[0]];

  const descriptor = {
    version,
    face: {
      requestedFamily: face.family,
      weight: face.weight,
      style: face.style,
      fontSizePx: round4(face.fontSizePx),
      cssFont,
      substituted: glyphs.some((glyph) => glyph.substituted),
      probes: shared.probes,
    },
    // Written field by field rather than spread, so the descriptor's shape is stated in one place
    // and a metric added to `shared` cannot reach the wire without someone deciding it should.
    metrics: {
      ascentPx: metrics.ascentPx,
      descentPx: metrics.descentPx,
      lineHeightPx: metrics.lineHeightPx,
      baselinePx: metrics.baselinePx,
      // Run-scoped, and the page's own first cue is the run they describe — the same choice the
      // descriptor has always made, since a descriptor carries exactly one layout.
      runAdvanceWidthPx: first.runAdvanceWidthPx,
      shapingResidualPx: first.shapingResidualPx,
      baseDirection: first.baseDirection,
      letterSpacingPx: metrics.letterSpacingPx,
    },
    atlas,
    layout: layouts[0],
    glyphs,
  };

  const contentHash = fnv1a32(pixels, hashText(canonicalize(descriptor, layouts.slice(1))))
    .toString(16)
    .padStart(8, '0');
  return {
    descriptor: deepFreeze({ ...descriptor, contentHash, pixels }),
    layouts,
  };
};
