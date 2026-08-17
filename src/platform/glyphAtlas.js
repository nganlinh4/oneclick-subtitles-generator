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
 * `bakeGlyphAtlasForCues` is the export's: many texts, as many atlas PAGES as their alphabet needs,
 * and one layout each against the page it landed on. They are the same pipeline —
 * `glyphAtlasBake.js` — because an export that did not bake the cells the preview baked would stop
 * being a proof of the preview. A cue's cells are a function of that cue alone, whichever page it
 * lands on and whichever cues it is baked beside, which is what makes the one-cue and many-cue
 * entry points comparable at all.
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
  // Paging bounds. A cue list whose alphabet overflows one atlas is split across pages rather than
  // refused, because `osg_scene::cues::active_cue_at` draws exactly one cue per frame and therefore
  // samples exactly one page. `maxAtlasPages` mirrors `MAX_ATLAS_PAGES` in
  // crates/osg-scene/src/glyph/limits.rs and `maxTotalAtlasBytes` mirrors `MAX_STAGED_BYTES` in
  // apps/desktop/src-tauri/src/glyph_atlas.rs, which is what the staging registry will hold
  // resident. Together they are the DECLARED budget: 32 pages of 1,024 cells carry 32,768 distinct
  // glyph forms, which covers every script this product ships fonts for, and the byte budget is what
  // decides whether a large font size at 4K reaches that count before it reaches the memory.
  maxAtlasPages: 32,
  maxTotalAtlasBytes: 268_435_456,
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
).pages[0];

/**
 * What every cue has to satisfy before it can be drawn at all.
 *
 * Both conditions are places where the native side has exactly one answer and a cue could otherwise
 * carry another:
 *
 * - A run that places NO cell is refused by `osg_compositor::CueRun::validate`, so an empty or
 *   line-break-only cue text would take the whole export down with a refusal the user cannot read.
 * - `SubtitleScene::new` gates on each ATLAS's `cellAdvanceLayout`. A cue whose shaping crosses
 *   cluster boundaries, or whose bidi the shaper refused, cannot be drawn from cells at all — so it
 *   refuses here, by index, rather than being drawn in the wrong order.
 *
 * Alignment is NOT in this list any more, and that is the point of paging. `run_align` places every
 * cue by its ATLAS's `layout.textAlign`, because CSS `start` resolves against the paragraph's own
 * direction and only the shaper can decide it. One atlas therefore carries one alignment — which
 * used to mean a document mixing a right-to-left cue with a left-to-right one was refused outright.
 * Now those cues land on different pages, each aligned as its own direction demands.
 */
const requireStageableCues = (runs) => {
  runs.forEach((run, index) => {
    if (run.lines.length === 0 || run.lines.every((line) => line.glyphs.length === 0)) {
      invalidRequest(`texts[${index}] places no glyph cells, so it cannot be staged as a cue run`);
    }
    if (run.cellAdvanceLayout !== 'reproduces') {
      fail(
        'glyphAtlasCueLayoutRefused',
        `texts[${index}] cannot be laid out from atlas cells, and a cue that cannot be drawn is refused rather than drawn wrongly`
      );
    }
  });
};

/**
 * Bake a whole cue list into as many atlas pages as its alphabet needs.
 *
 * `request` is `bakeGlyphAtlas`'s, with `texts` — one string per cue, in cue order — in place of
 * `text`. Returns `{ pages, runs, pageOfCue }` where `runs[i]` is `texts[i]`'s layout against
 * `pages[pageOfCue[i]].glyphs`. `render_start` wants each run projected to
 * `{ lines: [{ glyphs, penXPx, advanceWidthPx, baselineYPx }] }` plus its page; every other field a
 * layout carries is provenance the caller may drop.
 *
 * WHY PAGES RATHER THAN ONE ATLAS. `maxGlyphCount` bounds ONE atlas's cell table, and that bound is
 * on the ALPHABET — the union of every cue's distinct forms. Latin saturates it at a few dozen cells
 * however long the track, so one atlas was never a limit there. A large character set is different:
 * a Chinese film uses a few thousand distinct ideographs and overflowed a single atlas, so the
 * export refused an ordinary document. Splitting the cue list across pages removes that ceiling
 * without raising the per-atlas bound the native validators enforce, and it costs nothing at draw
 * time because `osg_scene::cues::active_cue_at` selects exactly one cue per frame — so a frame
 * samples exactly one page.
 *
 * WHAT IS STILL REFUSED, and refused rather than truncated, because a page silently dropped is a
 * stretch of subtitles missing from the exported file: a document needing more than `maxAtlasPages`
 * pages or more than `maxTotalAtlasBytes` of glyph raster. Both are declared budgets with actionable
 * messages, not incidental ceilings.
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
