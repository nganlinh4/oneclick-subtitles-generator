/**
 * The single WebView glyph source for the native renderer.
 *
 * The architecture (docs/rewrite/NATIVE_RENDERER.md) is one Rust/GPU pixel compositor fed by one
 * glyph source. This module is that source: the WebView shapes and rasterizes the selected face
 * once, using the exact editor font bytes and the browser's own text stack, and hands native code a
 * bounded, versioned, immutable descriptor. Rust re-derives per-frame layout and animation from it
 * and emits textured quads; it never shapes text. That makes preview and export share identical
 * fonts and identical shaping by construction rather than by a test we have to keep passing.
 *
 * Shaping includes LINE BREAKING. The WebView owns the font stack and `Intl.Segmenter`, so it is the
 * only side that can break a line at a word-safe, cluster-safe boundary using real measured
 * advances. `descriptor.layout` therefore carries the per-line runs the compositor draws, rather
 * than the compositor guessing where a line ended. `glyphAtlasShaping.js` owns that pass, including
 * `textTransform`, `letterSpacing`, the wrap width and justification.
 *
 * Shaping also decides WHAT EACH CELL IS. A cluster whose glyph depends on its neighbours — every
 * cursive script does — cannot be rasterized alone, so `glyphAtlasCells.js` resolves each position's
 * contextual form and the cell is baked from that form's canonical spelling instead of from the bare
 * cluster. It is engaged only for a run the isolated cells cannot reproduce, so a script that does
 * not join bakes byte-for-byte the atlas it always did, and it hands the run back unresolved when no
 * spelling reproduces it, so a ligature or a kern still refuses rather than drawing the wrong glyph.
 *
 * TWO ENTRY POINTS, ONE BAKE. `bakeGlyphAtlas` is the preview's: one text, one atlas, one layout.
 * `bakeGlyphAtlasForCues` is the export's: many texts, ONE atlas, one layout each. They are the same
 * pipeline — `glyphAtlasBake.js` — because an export that did not bake the cells the preview baked
 * would stop being a proof of the preview.
 *
 * Transport is deliberately NOT decided here. Raw frame bytes over IPC are forbidden by the
 * architecture, so `descriptor.pixels` is exposed as a plain RGBA byte view and the caller chooses
 * the staging route. `pixels.buffer` is a plain transferable ArrayBuffer for that purpose. This
 * module never touches IPC and never sees a native path.
 *
 * Determinism: no clocks, no RNG, no `Math.random`. Every field is a pure function of the request
 * and the measurement surface, so a seek is exact and repeatable.
 *
 * Caveat recorded rather than hidden: grapheme and word segmentation come from `Intl.Segmenter`, so
 * a host with a different ICU version can cluster new emoji sequences — or find word boundaries in
 * an unspaced script — differently. Both feed `contentHash`, so that surfaces as a different atlas
 * identity instead of silent divergence.
 */

import { bakeAtlas } from './glyphAtlasBake';
import { fail, invalidRequest } from './glyphAtlasCore';

export { GLYPH_ATLAS_ERROR_CODES, GlyphAtlasError } from './glyphAtlasCore';
export { createCanvas2dMeasurementSurface } from './glyphAtlasSurface';
export { TEXT_ALIGNMENTS, TEXT_TRANSFORMS } from './glyphAtlasShaping';

export const GLYPH_ATLAS_VERSION = 1;

/**
 * The bounds this module enforces. `crates/osg-scene/src/glyph/limits.rs` mirrors them and
 * `crates/osg-scene/tests/glyph.rs` parses these entries straight out of this file, so a rename or a
 * reformat is a Rust test failure rather than a silent divergence.
 */
export const GLYPH_ATLAS_LIMITS = Object.freeze({
  maxTextCodePoints: 4_096,
  maxGlyphCount: 1_024,
  maxClusterCodePoints: 32,
  maxAtlasDimensionPx: 4_096,
  minFontSizePx: 4,
  maxFontSizePx: 512,
  maxFamilyCharacters: 64,
  maxPaddingPx: 8,
  // Layout bounds. `maxLayoutLines` and `maxLayoutCells` mirror `MAX_RUN_LINES` and `MAX_RUN_GLYPHS`
  // in crates/osg-compositor/src/subtitle.rs, so a run this module emits is one the compositor can
  // stage. They are structural bounds on the payload and are NOT the persisted `maxLines`, which
  // stays inert.
  maxLayoutLines: 64,
  maxLayoutCells: 4_096,
  // Bounds the wrap arithmetic rather than expressing a design limit: the widest sane wrap width in
  // atlas space is an 8K composition divided by the smallest bakeable scale, which is far below it.
  maxLayoutWidthPx: 1_048_576,
  minLetterSpacingPx: -100,
  maxLetterSpacingPx: 1_000,
});

/**
 * The most cue texts one call may bake, mirroring `MAX_STAGED_CUES` in
 * `apps/desktop/src-tauri/src/render/text.rs`. It bounds the array this module walks; the bound that
 * actually decides whether a real track fits is `maxGlyphCount`, on the union of every cue's cells.
 */
const MAX_CUE_TEXTS = 100_000;

/**
 * Bake the glyphs a text run needs into a packed atlas, and lay that run out into lines.
 *
 * `request` is `{ text, face: { family, weight = 400, style = 'normal' }, fontSizePx,
 * lineHeightPx = null, paddingPx = 1, requireExactFace = true, textTransform = 'none',
 * letterSpacingPx = 0, maxWidthPx = null, wordWrap = true, textAlign = 'left' }`; oversize input is
 * rejected, never truncated, and `requireExactFace` makes any substitution a hard failure.
 * `options.surface` injects the measurement surface and defaults to canvas 2D. Returns a frozen,
 * versioned descriptor whose `pixels` is tightly packed RGBA8 — its alpha channel is the coverage
 * mask — and whose `layout` is the per-line run the compositor draws. The caller owns staging both.
 *
 * A cell is rasterized from the CONTEXTUAL FORM the run gives its cluster, not always from the bare
 * cluster: see `glyphAtlasCells.js`. `glyphs[].cluster` therefore carries the text the cell was
 * baked from, which for a joined form is the cluster plus the zero-width joiners that spell it.
 */
export const bakeGlyphAtlas = (request, options = {}) => bakeAtlas(
  { texts: [request?.text], request, limits: GLYPH_ATLAS_LIMITS, version: GLYPH_ATLAS_VERSION },
  options
).descriptor;

/**
 * What one cue set has to agree on before it can be drawn from one atlas.
 *
 * These are not extra caution: each one is a place where the native side has exactly one answer for
 * the whole scene and a cue list could otherwise carry n.
 *
 * - A run that places NO cell is refused by `osg_compositor::CueRun::validate`, so an empty or
 *   line-break-only cue text would take the whole export down with a refusal the user cannot read.
 * - `SubtitleScene::new` gates on the ATLAS's `cellAdvanceLayout`, one verdict for every cue. A cue
 *   whose shaping crosses cluster boundaries, or whose bidi the shaper refused, therefore cannot be
 *   carried beside cues that are fine: the alternative to refusing here is drawing that cue wrong.
 * - `osg_compositor`'s `run_align` places every cue by the ATLAS's `layout.textAlign`, because CSS
 *   `start` resolves against the paragraph's own direction and only the shaper can decide it. Cues
 *   that resolve to different alignments — a right-to-left cue beside a left-to-right one, with the
 *   direction left to the text — would be aligned by whichever one came first, which is exactly the
 *   preview/export divergence this pipeline exists to remove.
 */
const requireStageableCues = (runs) => {
  runs.forEach((run, index) => {
    if (run.lines.length === 0 || run.lines.every((line) => line.glyphs.length === 0)) {
      invalidRequest(`texts[${index}] places no glyph cells, so it cannot be staged as a cue run`);
    }
    if (run.cellAdvanceLayout !== 'reproduces') {
      fail(
        'glyphAtlasCueLayoutRefused',
        `texts[${index}] cannot be laid out from atlas cells, and one refused cue refuses the whole atlas`
      );
    }
    if (run.textAlign !== runs[0].textAlign) {
      fail(
        'glyphAtlasCueAlignmentConflict',
        'The cues resolve to different alignments, and one atlas carries one alignment for all of them'
      );
    }
  });
};

/**
 * Bake ONE atlas for a whole cue list, and lay every cue out against it.
 *
 * `request` is `bakeGlyphAtlas`'s, with `texts` — one string per cue, in cue order — in place of
 * `text`. Returns `{ descriptor, runs }` where `runs[i]` is `texts[i]`'s layout against
 * `descriptor.glyphs`, and `runs[0]` is `descriptor.layout` itself. `render_start` wants each run
 * projected to `{ lines: [{ glyphs, penXPx, advanceWidthPx, baselineYPx }] }`; every other field a
 * layout carries is provenance the caller may drop.
 *
 * WHY ONE ATLAS. `osg_compositor::SubtitleScene::new` validates every run's cell indices against one
 * glyph table and refuses a run count that is not the cue count, so n atlases cannot be used and
 * cannot be merged natively.
 *
 * WHAT THE BOUND MEANS HERE. `maxGlyphCount` applies to the UNION of every cue's cells, not to one
 * cue, and an oversize union is refused rather than truncated — a truncated table would silently
 * drop glyphs from cues nobody was looking at. The bound is on the ALPHABET, not on the cue count:
 * a track saturates at the number of distinct forms it is written with, so Latin text stops growing
 * the table after its own alphabet however many cues follow, while a script with a large character
 * set reaches 1024 cells in proportion to the distinct characters the track uses.
 */
export const bakeGlyphAtlasForCues = (request, options = {}) => {
  if (request === null || typeof request !== 'object') invalidRequest('request must be an object');
  const { texts } = request;
  if (!Array.isArray(texts) || texts.length === 0) {
    invalidRequest('texts must be a non-empty array of cue texts');
  }
  if (texts.length > MAX_CUE_TEXTS) {
    invalidRequest(`texts must hold at most ${MAX_CUE_TEXTS} cue texts`);
  }
  const baked = bakeAtlas(
    { texts, request, limits: GLYPH_ATLAS_LIMITS, version: GLYPH_ATLAS_VERSION },
    options
  );
  requireStageableCues(baked.runs);
  return baked;
};
