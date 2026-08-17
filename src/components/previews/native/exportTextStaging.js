/**
 * The text one native EXPORT draws with: the glyph atlas pages, and one laid-out run per cue.
 *
 * `render_start` takes a second argument beside the render request, and without it the command
 * refuses with `renderTextNotStaged` rather than drawing anything. This module is what produces it.
 * The architecture forbids a Rust text stack, so an export's glyphs have to arrive already shaped;
 * `apps/desktop/src-tauri/src/render/text.rs` is the other end of this boundary and
 * `EXPORT_TEXT_SCHEMA_VERSION` below is its `EXPORT_TEXT_SCHEMA_VERSION`.
 *
 * ONE PAGE PER FRAME, MANY PAGES PER DOCUMENT. A `GlyphAtlasDescriptor` carries one cell table, and
 * `osg_compositor::CueRun` indexes exactly one of them — so a cue list whose alphabet overflows a
 * single table is split across pages, and each cue carries the page it was laid out against. This
 * costs nothing at draw time: `osg_scene::cues::active_cue_at` selects exactly one cue per frame, so
 * a frame samples exactly one page. It is what lets a Chinese, Korean or emoji-heavy track export at
 * all — one table held about a thousand distinct forms, which such a document passes in its first
 * few minutes.
 *
 * NOTHING HERE DESCRIBES THE STYLE A SECOND TIME. The face is resolved by `previewFace`, the bake
 * request is built by `atlasBakeRequest` and the composition size by `compositionSize` — the same
 * three functions the preview surface calls, with the same arguments, so an export bakes the atlas
 * the preview showed rather than one that merely agrees with it. When the two produce the same
 * descriptor, `stageGlyphAtlas` is content-addressed and hands back the handle the preview already
 * minted without touching IPC at all; when they do not, this module stages its own.
 *
 * A FONT THAT CANNOT BE RESOLVED REFUSES THE EXPORT BY NAME. `resolveFontIdentity` returns an honest
 * unavailable and the export stops there, because silently writing a file in a substituted face is
 * precisely the defect the native pipeline exists to remove. The refusal names the family the
 * project asked for — that is the one piece of user content it carries, and it is what makes the
 * message actionable. It never carries a path, a native message or a line of subtitle text.
 *
 * Determinism: no clocks and no RNG in anything that reaches the payload. The one timer is a
 * liveness guard on the source probe, which can only turn a hang into a refusal.
 */

import * as glyphAtlas from '../../../platform/glyphAtlas';
import { stageGlyphAtlas } from '../../../platform/glyphAtlasStaging';
import { compositionSize } from './nativePreviewGeometry';
import { atlasBakeRequest, previewFace } from './nativePreviewScene';

const { GLYPH_ATLAS_LIMITS } = glyphAtlas;

/** Mirrors `EXPORT_TEXT_SCHEMA_VERSION` in `apps/desktop/src-tauri/src/render/text.rs`. */
export const EXPORT_TEXT_SCHEMA_VERSION = 2;

/**
 * The bounds the far side applies, mirrored so an unusable payload is refused before IPC.
 *
 * `maxRunLines` and `maxRunCells` are `MAX_RUN_LINES` and `MAX_RUN_GLYPHS` in
 * `crates/osg-compositor/src/run.rs`, which the baker's own `maxLayoutLines` and `maxLayoutCells`
 * already mirror; they are read from the baker so one rename moves both. `maxPages` is
 * `MAX_ATLAS_PAGES` in `crates/osg-scene/src/glyph/limits.rs`, mirrored the same way.
 */
export const EXPORT_TEXT_LIMITS = Object.freeze({
  maxCues: 100_000,
  maxPages: GLYPH_ATLAS_LIMITS.maxAtlasPages,
  maxRunLines: GLYPH_ATLAS_LIMITS.maxLayoutLines,
  maxRunCells: GLYPH_ATLAS_LIMITS.maxLayoutCells,
});

/** How long the source probe may take before the export refuses instead of waiting forever. */
const SOURCE_PROBE_TIMEOUT_MS = 15_000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The codes this module refuses under. Local to the `WebView`: the export never started, so none of
 * these can arrive from native code, and none of them is a native refusal renamed.
 */
export const EXPORT_TEXT_ERROR_CODES = Object.freeze([
  /** The project's font is not one this machine can draw, and no substitute will be used. */
  'renderFontUnresolved',
  /** The source has not reported a decoded size, so the composition it wraps against is unknown. */
  'renderSourceSizeUnknown',
  /** The atlas could not be baked or staged. `reason` carries the baker's or stager's own code. */
  'renderTextStagingFailed',
]);

/**
 * A refusal to prepare an export's text.
 *
 * Its own type rather than `NativeRenderError`, because nothing here has called the renderer yet:
 * these are decided in the `WebView`, before a job exists. `code` is what a surface switches on and
 * `message` is written for a person; `reason` carries a sanitized nested code for diagnostics and
 * is never shown.
 */
export class ExportTextError extends Error {
  constructor(code, message, reason = null) {
    super(message);
    this.name = 'ExportTextError';
    this.code = code;
    this.reason = reason;
  }
}

const refuse = (code, message, reason = null) => {
  throw new ExportTextError(code, message, reason);
};

/** A sanitized code from a nested failure, or `null`. Never the message, which may name a face. */
const nestedCode = (error) => {
  try {
    const code = error?.code;
    return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
};

const stagingFailed = (reason) => refuse(
  'renderTextStagingFailed',
  'The subtitles for this export could not be prepared for the native renderer',
  reason,
);

/**
 * The family the project asked for, for a refusal that names it.
 *
 * The persisted value is a CSS font list, so the primary family is what a user recognises. A value
 * that does not parse at all has no name to report and is refused without one.
 */
const requestedFamilyName = (fontFamily) => {
  if (typeof fontFamily !== 'string') return null;
  const [primary] = fontFamily.split(',');
  const trimmed = primary?.trim().replace(/^["'](.*)["']$/su, '$1').trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= 64 && !/\p{Cc}/u.test(trimmed) ? trimmed : null;
};

const fontUnresolved = (fontFamily, detail) => {
  const family = requestedFamilyName(fontFamily);
  refuse(
    'renderFontUnresolved',
    family === null
      ? `This project's font ${detail}, so the video was not rendered in a substitute`
      : `The font "${family}" ${detail}, so the video was not rendered in a substitute`,
  );
};

/** The three platforms `src/services/fontIdentity.js` has reviewed declaration sets for. */
export const detectExportPlatform = () => {
  const agent = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
    ? navigator.userAgent.toLowerCase()
    : '';
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

/**
 * Corroboration only, and only in the rejecting direction: `resolveFontIdentity` treats a `false` as
 * a missing face and never lets a `true` override a declaration it does not have.
 */
export const systemFaceProbe = () => {
  if (typeof document !== 'object' || typeof document.fonts?.check !== 'function') return null;
  return ({ family, weight }) => {
    try {
      return document.fonts.check(`${weight} 16px "${family}"`);
    } catch {
      return false;
    }
  };
};

/** A playable URL for whatever shape of source the export was handed, and how to give it back. */
const resolveSourceUrl = (source) => {
  if (source === null || source === undefined) return null;
  if (typeof source === 'string') return { url: source, release: null };
  if (typeof Blob === 'function' && source instanceof Blob) {
    const url = URL.createObjectURL(source);
    return { url, release: () => URL.revokeObjectURL(url) };
  }
  if (isRecord(source)) {
    const candidate = source.playbackUrl ?? source.url;
    if (typeof candidate === 'string' && candidate.length > 0) return { url: candidate, release: null };
  }
  return null;
};

/**
 * The decoded size of the source, read from a `<video>` element.
 *
 * The element is the only thing that has actually decoded the file, and the composition WIDTH is
 * derived from the source aspect — so this is where the wrap width the atlas is baked against comes
 * from. `crates/osg-export/src/convert/dimensions.rs` derives the same size from its own probe;
 * these agree because both take the DISPLAY size, pixel aspect and rotation applied.
 *
 * Returns `null` rather than a guess. A 16:9 assumption would wrap every other source's subtitles at
 * the wrong width, silently.
 */
export const measureNativeSourceDimensions = (source) => new Promise((resolve) => {
  const resolved = resolveSourceUrl(source);
  if (resolved === null || typeof document !== 'object' || typeof document.createElement !== 'function') {
    resolve(null);
    return;
  }
  const element = document.createElement('video');
  let settled = false;
  let timer = null;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    try {
      element.removeEventListener('loadedmetadata', onMetadata);
      element.removeEventListener('error', onError);
      element.removeAttribute('src');
    } catch {
      // Releasing the probe element is best effort; the measurement is already decided.
    }
    resolved.release?.();
    resolve(value);
  };
  function onMetadata() {
    const widthPx = element.videoWidth;
    const heightPx = element.videoHeight;
    finish(
      Number.isInteger(widthPx) && Number.isInteger(heightPx) && widthPx > 0 && heightPx > 0
        ? Object.freeze({ widthPx, heightPx })
        : null,
    );
  }
  function onError() {
    finish(null);
  }
  element.preload = 'metadata';
  element.muted = true;
  element.addEventListener('loadedmetadata', onMetadata);
  element.addEventListener('error', onError);
  timer = setTimeout(() => finish(null), SOURCE_PROBE_TIMEOUT_MS);
  try {
    element.src = resolved.url;
  } catch {
    finish(null);
  }
});

/**
 * Bake the atlas pages a cue list needs, plus one layout per cue against the page it landed on.
 *
 * `bakeGlyphAtlasForCues` is the baker's own cue-list entry point: `bakeGlyphAtlas`'s request with
 * `texts` in place of `text`, returning `{ pages, runs, pageOfCue }`. For a single text it produces
 * exactly the descriptor `bakeGlyphAtlas` produces, so a one-cue export stages the atlas the preview
 * staged — which is what lets the content-addressed stager hand back the preview's own handle.
 *
 * A build without that entry point refuses rather than falling back to one cue's atlas standing in
 * for the rest.
 */
export const bakeCueAtlas = (request, options = {}) => {
  const bake = glyphAtlas.bakeGlyphAtlasForCues;
  if (typeof bake !== 'function') stagingFailed('glyphAtlasCueBakerUnavailable');
  return bake(request, options);
};

/**
 * The pages to stage, the per-cue layouts and each cue's page, as the baker hands them over.
 *
 * This checks the bake is COHERENT — every cue has a page, every page index is a real page. Whether
 * it matches the render request is `buildExportTextRequest`'s question, and keeping the two apart is
 * what makes a refusal say which side was wrong.
 */
const readCueBake = (baked) => {
  if (!isRecord(baked)
      || !Array.isArray(baked.pages)
      || baked.pages.length === 0
      || baked.pages.length > EXPORT_TEXT_LIMITS.maxPages
      || !baked.pages.every(isRecord)
      || !Array.isArray(baked.runs)
      || !Array.isArray(baked.pageOfCue)
      || baked.pageOfCue.length !== baked.runs.length
      || !baked.pageOfCue.every(
        (page) => Number.isInteger(page) && page >= 0 && page < baked.pages.length,
      )) {
    stagingFailed('glyphAtlasCueBakeShape');
  }
  return { pages: baked.pages, layouts: baked.runs, pageOfCue: baked.pageOfCue };
};

/** One laid-out line, reduced to the four fields `ExportCueLine` deserialises. */
const exportLine = (line, cellCount) => {
  if (!isRecord(line)
      || !Array.isArray(line.glyphs)
      || !Array.isArray(line.penXPx)
      || line.glyphs.length !== line.penXPx.length
      || !isFiniteNumber(line.advanceWidthPx)
      || !isFiniteNumber(line.baselineYPx)
      || line.penXPx.some((pen) => !isFiniteNumber(pen))
      // A cell index the staged table does not have is refused HERE rather than by the compositor,
      // because a run that indexes past the atlas is a baker fault and the message the far side
      // gives for it says nothing about which side produced it.
      || line.glyphs.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= cellCount)) {
    stagingFailed('glyphAtlasLayoutGeometry');
  }
  return Object.freeze({
    glyphs: Object.freeze([...line.glyphs]),
    penXPx: Object.freeze([...line.penXPx]),
    advanceWidthPx: line.advanceWidthPx,
    baselineYPx: line.baselineYPx,
  });
};

/** One cue's run, bounded exactly as `ExportTextRequest::check` bounds it. */
const exportRun = (layout, cellCount) => {
  const lines = isRecord(layout) && Array.isArray(layout.lines) ? layout.lines : null;
  if (lines === null || lines.length === 0 || lines.length > EXPORT_TEXT_LIMITS.maxRunLines) {
    stagingFailed('glyphAtlasLayoutLines');
  }
  const run = lines.map((line) => exportLine(line, cellCount));
  const cells = run.reduce((total, line) => total + line.glyphs.length, 0);
  if (cells > EXPORT_TEXT_LIMITS.maxRunCells) stagingFailed('glyphAtlasLayoutCells');
  return Object.freeze({ lines: Object.freeze(run) });
};

/**
 * The payload `render_start` reads, from the staged pages and the layouts baked against them.
 *
 * Exported separately from the staging so the shape can be checked without a canvas, a runtime or a
 * native call. `cueCount` is the render request's own, and a layout count that disagrees with it is
 * refused here: the far side would refuse it too, but not before an IPC round trip.
 *
 * Each cue is bounded against ITS OWN page's cell count, which is the whole reason the page travels
 * with the cue. Checking every cue against page 0 would let a cue on a later page index past its
 * table and be caught, if at all, by the compositor — with a message that says nothing about which
 * side produced it.
 */
export const buildExportTextRequest = ({ handles, face, layouts, pageOfCue, cueCount }) => {
  if (!Array.isArray(handles)
      || handles.length === 0
      || handles.length > EXPORT_TEXT_LIMITS.maxPages
      || !handles.every((handle) => isRecord(handle)
        && typeof handle.atlasId === 'string'
        && typeof handle.contentHash === 'string'
        && Number.isInteger(handle.glyphCount)
        && handle.glyphCount >= 0)) {
    stagingFailed('glyphAtlasHandle');
  }
  if (!Array.isArray(layouts)
      || layouts.length !== cueCount
      || cueCount === 0
      || cueCount > EXPORT_TEXT_LIMITS.maxCues
      || !Array.isArray(pageOfCue)
      || pageOfCue.length !== cueCount
      || !pageOfCue.every((page) => Number.isInteger(page) && page >= 0 && page < handles.length)) {
    stagingFailed('glyphAtlasLayoutCount');
  }
  return Object.freeze({
    schemaVersion: EXPORT_TEXT_SCHEMA_VERSION,
    face: Object.freeze({ family: face.family, source: face.source, weight: face.weight }),
    pages: Object.freeze(handles.map((handle) => Object.freeze({
      atlasId: handle.atlasId,
      atlasContentHash: handle.contentHash,
    }))),
    cues: Object.freeze(layouts.map((layout, cue) => Object.freeze({
      page: pageOfCue[cue],
      ...exportRun(layout, handles[pageOfCue[cue]].glyphCount),
    }))),
  });
};

/**
 * Resolve the face, bake one atlas for every cue, stage it, and return `render_start`'s `text`.
 *
 * `request` is the validated render request `buildNativeRenderRequest` produced — the cue list, the
 * style, the crop and the resolution all come from it, so nothing here can describe a different
 * composition from the one that is about to be exported.
 *
 * `options.source` is whatever the caller holds for the source video: a native media descriptor, a
 * `File`, a URL. It is used for one thing only — reading the decoded size the composition width is
 * derived from — and `options.sourceDimensions` short-circuits it for a caller that already knows.
 */
export const stageNativeRenderText = async (request, options = {}) => {
  const {
    source = null,
    sourceDimensions = null,
    platform = detectExportPlatform(),
    isSystemFaceInstalled = systemFaceProbe(),
    measureSource = measureNativeSourceDimensions,
    bakeCues = bakeCueAtlas,
    stage = stageGlyphAtlas,
    surface = null,
  } = options;

  const cues = isRecord(request) && Array.isArray(request.lyrics) ? request.lyrics : null;
  const customization = isRecord(request) ? request.customization : null;
  if (cues === null || cues.length === 0 || cues.length > EXPORT_TEXT_LIMITS.maxCues
      || !isRecord(customization) || !isRecord(request.settings) || !isRecord(request.crop)) {
    stagingFailed('renderRequestShape');
  }

  const face = previewFace({
    fontFamily: customization.fontFamily,
    fontWeight: customization.fontWeight,
    platform,
    isSystemFaceInstalled,
  });
  if (face === null) {
    fontUnresolved(customization.fontFamily, 'is not available on this computer');
  }

  const dimensions = sourceDimensions ?? await measureSource(source);
  if (!isRecord(dimensions) || !(dimensions.widthPx > 0) || !(dimensions.heightPx > 0)) {
    refuse(
      'renderSourceSizeUnknown',
      'The size of the source video is not known yet, so its subtitles cannot be laid out',
    );
  }

  const composition = compositionSize({
    resolution: request.settings.resolution,
    sourceWidthPx: dimensions.widthPx,
    sourceHeightPx: dimensions.heightPx,
    crop: request.crop,
  });
  if (composition === null) stagingFailed('compositionSize');

  const bake = atlasBakeRequest({
    customization,
    text: '',
    compositionWidthPx: composition.widthPx,
    compositionHeightPx: composition.heightPx,
    face,
  });
  if (bake === null) stagingFailed('atlasBakeRequest');
  if (bake.request === null) stagingFailed(bake.refusal);

  // The cue-list request is the preview's own bake request with the single run replaced by every
  // cue's, so a one-cue export bakes byte-for-byte the atlas the preview staged and reuses its
  // handle instead of uploading a second copy of it.
  const { text: _singleRun, ...shared } = bake.request;
  const cueRequest = { ...shared, texts: cues.map((cue) => cue.text) };

  let staged;
  try {
    const baked = await bakeCues(cueRequest, surface === null ? {} : { surface });
    const { pages, layouts, pageOfCue } = readCueBake(baked);
    // Sequentially, not concurrently: the staging registry is byte-bounded and evicts by least
    // recent use, so uploading every page at once could evict a page this same export just staged.
    const handles = [];
    for (const page of pages) handles.push(await stage(page));
    staged = { handles, layouts, pageOfCue };
  } catch (error) {
    if (error instanceof ExportTextError) throw error;
    const code = nestedCode(error);
    // The baker's own substitution verdict is the same refusal `fontIdentity` makes, one measurement
    // later: the family resolved, and then the engine drew something else. Both name the face.
    if (code === 'glyphAtlasFaceUnavailable' || code === 'glyphAtlasFaceSubstituted') {
      fontUnresolved(
        customization.fontFamily,
        'is not the font this computer would draw the subtitles with',
      );
    }
    stagingFailed(code);
  }

  return buildExportTextRequest({
    handles: staged.handles,
    face,
    layouts: staged.layouts,
    pageOfCue: staged.pageOfCue,
    cueCount: cues.length,
  });
};
