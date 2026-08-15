// Every persisted subtitle-customization field, and what the native renderer does with it.
//
// The migration away from the shipped renderer is only finished when each of these 54 fields has a
// deliberate disposition. Prose cannot enforce that, so this ledger is asserted against
// `defaultCustomization` in renderParityLedger.test.js: a field added to the schema without an
// entry here fails the suite, and an entry here for a field that no longer exists fails it too.
//
// The point is to make a silently dropped capability impossible rather than unlikely. A user who
// saved a project with `strokeWidth: 4` must not open it after the migration to find the setting
// still in the file, still in the UI, and no longer on the screen.

/**
 * What the native renderer does with a field.
 *
 * - `native`   — reproduced by the native renderer. `where` names the implementing module.
 * - `pending`  — not implemented yet. Every one of these must reach another state before release.
 * - `inert`    — validated and persisted today but with no render effect and no UI control. It stays
 *                inert deliberately, so existing saved projects keep round-tripping unchanged.
 * - `fixed`    — the shipped behaviour is a defect the native renderer deliberately does not copy.
 *                `note` must say what visibly changes, because this is the only disposition that
 *                can alter an existing project's appearance.
 */
export const PARITY_DISPOSITIONS = Object.freeze(['native', 'pending', 'inert', 'fixed']);

const entry = (disposition, where, note) => Object.freeze({ disposition, where, note });

const native = (where, note) => entry('native', where, note);
const pending = note => entry('pending', null, note);
const inert = note => entry('inert', null, note);
const fixed = (where, note) => entry('fixed', where, note);

export const RENDER_PARITY_LEDGER = Object.freeze({
  // ---- Type and face -------------------------------------------------------------------------
  fontFamily: native(
    'src/services/fontIdentity.js',
    'Resolves to exactly one face and byte source, or an honest unavailable. The shipped renderer '
    + 'substituted silently for 107 of the 121 catalog families on this machine.',
  ),
  fontWeight: native('src/services/fontIdentity.js', 'The resolved weight travels in the scene face.'),
  fontSize: native('crates/osg-scene/src/scale.rs', 'Scales by value * height / 1080, rounded to 2dp.'),
  lineHeight: pending(
    'The baker now derives per-line baselines from it, and the compositor also multiplies the '
    + "atlas line height by its own line_spacing — so whichever side owns it, the other must stop, "
    + 'or every line after the first lands wrong. One owner has to be chosen before this moves.',
  ),
  letterSpacing: pending(
    'Complete on the WebView side — added to every cluster advance including the last, as a browser '
    + 'does, and never baked into the raster — but not yet drawable. The compositor still '
    + 'accumulates the pen from cell advances alone, which matches exactly at zero spacing and '
    + 'diverges otherwise. It needs CueRun to carry the pen positions the atlas already emits, and '
    + 'staging to forward them.',
  ),
  textTransform: native(
    'src/platform/glyphAtlasShaping.js',
    'Applied before segmentation, because the transform decides the cluster count and therefore the '
    + "bound: 'straße' becomes 'STRASSE', five cells instead of six. Reproduces the shipped "
    + "renderer's double transform — a JS rewrite that lowercases each word's tail, then CSS "
    + "capitalize over the result — rather than the intent, because that is what existing projects "
    + "look like ('iPhone' becomes 'Iphone').",
  ),

  // ---- Colour --------------------------------------------------------------------------------
  textColor: native('crates/osg-scene/src/color.rs'),
  backgroundColor: native('crates/osg-scene/src/color.rs'),
  backgroundOpacity: fixed(
    'crates/osg-scene/src/color.rs',
    'Unchanged on screen. The shipped renderer appends hex alpha to the colour string, so an '
    + '#rrggbbaa background — which every validator accepts — became a 10-digit colour and vanished '
    + 'with no message. The native renderer reports AlreadyHasAlpha instead of losing it silently.',
  ),

  // ---- Gradient ------------------------------------------------------------------------------
  gradientEnabled: native(
    'crates/osg-compositor',
    'Landed together with the fill, so enabling a gradient can never produce invisible subtitles. '
    + 'One residual difference, recorded rather than hidden: background-clip clips the background '
    + 'COLOUR to the glyphs as well as the image, so the shipped renderer shows that colour through '
    + 'translucent stops. Every shipped preset uses opaque stops, where the two are identical.',
  ),
  gradientColorStart: native('crates/osg-compositor'),
  gradientColorEnd: native('crates/osg-compositor'),
  gradientDirection: native(
    'crates/osg-compositor',
    'The CSS angle convention: 0deg points at the top edge and increases clockwise. Each glyph quad '
    + 'carries four corner colours sampled from the padding box gradient line, because a CSS ramp '
    + 'is affine over a quad and needs no extra pass.',
  ),
  gradientType: inert('Persisted and validated, but the shipped renderer only ever draws linear.'),
  gradientColorMid: inert('Persisted and validated, but never sampled by the shipped renderer.'),

  // ---- Decoration ----------------------------------------------------------------------------
  strokeEnabled: native(
    'crates/osg-compositor',
    'A disc dilation of the glyph coverage, drawn under the fill. DIVERGENCE, documented rather '
    + 'than hidden: -webkit-text-stroke is centred on the glyph contour and eats inward, thinning '
    + 'the letter. This crate has coverage, not contours, so it reproduces the outer half only. The '
    + 'outer silhouette and the stroke colour match; the letter keeps its full weight where WebKit '
    + 'would have thinned it.',
  ),
  strokeWidth: native('crates/osg-compositor', 'See strokeEnabled for the centred-stroke divergence.'),
  strokeColor: native('crates/osg-compositor'),
  textShadowEnabled: native(
    'crates/osg-compositor',
    'Rendered into an offscreen mask and blurred with the separable Gaussian the canvas backfill '
    + 'already used. Painted ABOVE the background box, which is what CSS does with a text-shadow '
    + 'and the opposite of what an outer box-shadow does — a discriminating test covers it, because '
    + 'the shipped default box is opaque enough to swallow a shadow drawn underneath.',
  ),
  textShadowColor: native('crates/osg-compositor'),
  textShadowBlur: native('crates/osg-compositor'),
  textShadowOffsetX: native('crates/osg-compositor', 'Still has no UI control, and still renders.'),
  textShadowOffsetY: native('crates/osg-compositor'),
  glowEnabled: native(
    'crates/osg-compositor',
    'Cast from the box rather than the glyphs, reproducing the shipped box-shadow rather than the '
    + 'text glow a reader might expect, with the box cut back out of the blur so it cannot shine '
    + 'through a translucent background.',
  ),
  glowColor: native('crates/osg-compositor'),
  glowIntensity: native(
    'crates/osg-compositor',
    'The applied blur deviation clamps at 64 output pixels. Nothing the slider offers is clamped at '
    + '1080p; a glow of 100 renders slightly tighter than a browser would at 1440p and above.',
  ),
  multiShadowEnabled: inert('Validated and persisted end to end, with no render effect and no UI.'),
  shadowLayers: inert('Validated and persisted end to end, with no render effect and no UI.'),

  // ---- Box -----------------------------------------------------------------------------------
  borderRadius: native(
    'crates/osg-compositor',
    'A signed-distance rounded box, now the border-box radius once a border is present.',
  ),
  borderWidth: native(
    'crates/osg-compositor',
    'A rounded-rect signed-distance ring. The border grows the box outward and the anchor holds the '
    + 'outer edge, as CSS does. At the shipped default of 0 the geometry is byte-identical to '
    + 'before, so no project without a border moves.',
  ),
  borderColor: native('crates/osg-compositor'),
  borderStyle: native(
    'crates/osg-compositor',
    'solid and double are exact — CSS defines them. dashed and dotted are CHOSEN, not measured: CSS '
    + 'leaves dash length to the browser and the pinned Chrome the shipped renderer used was not '
    + 'available to measure. Dashes are three widths on, three off; dots are round, one width '
    + 'across, one apart, with the period nudged so a whole number fits the perimeter.',
  ),

  // ---- Position and box metrics --------------------------------------------------------------
  position: native('crates/osg-scene/src/layout.rs'),
  customPositionX: native('crates/osg-scene/src/layout.rs'),
  customPositionY: native('crates/osg-scene/src/layout.rs'),
  marginTop: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginBottom: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginLeft: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginRight: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  maxWidth: pending(
    'Persisted, defaulted to 80, exposed in the UI and set by three shipped presets, and applied by '
    + 'the shipped renderer as a percentage width cap on the subtitle element. Nothing in the native '
    + 'pipeline consumes it: layout.rs derives the box from margins alone and the compositor sizes '
    + 'the block to its widest laid-out line. It cannot be honoured before line breaking lands, '
    + 'which wordWrap is already pending on.',
  ),
  textAlign: pending(
    'Left, centre and right resolve through the box anchor, and the baker can now justify a wrapped '
    + 'line because line breaking exists. Still pending because justification moves pen positions '
    + 'the compositor does not yet read — the same gap that blocks letterSpacing.',
  ),

  // ---- Wrapping ------------------------------------------------------------------------------
  wordWrap: native(
    'src/platform/glyphAtlasShaping.js',
    'Greedy breaking on real measured advances, at Intl.Segmenter word boundaries, never splitting '
    + 'a grapheme cluster. DIVERGENCE: the shipped style is pre-wrap with no overflow-wrap, so a '
    + 'word wider than the box overflows it; this breaks such a word at a cluster boundary instead. '
    + 'wordWrap false is reproduced exactly.',
  ),
  maxLines: inert('Validated and persisted end to end, with no render effect and no UI.'),
  lineBreakBehavior: inert('Validated and persisted end to end, with no render effect and no UI.'),
  rtlSupport: pending(
    'The atlas classifies direction by first-strong character only, which is not full bidi. The '
    + 'limit is carried explicitly rather than hidden, so layout can refuse what it cannot do.',
  ),

  // ---- Timing and animation ------------------------------------------------------------------
  fadeInDuration: native(
    'crates/osg-scene/src/cues.rs',
    'Including the window that makes a cue visible before its start and after its end.',
  ),
  fadeOutDuration: native('crates/osg-scene/src/cues.rs'),
  animationType: pending(
    'Nine of the ten are reproduced in crates/osg-scene/src/animation.rs with their asymmetries '
    + 'preserved — scale animates both ways, bounce only in. The tenth, typewriter, is the one that '
    + 'is not a transform but a progressive reveal of the text, and the compositor does not cut the '
    + 'glyph run yet, so it currently draws the whole cue at once. osg-scene already computes the '
    + 'reveal length; the run has to be trimmed where it is drawn.',
  ),
  animationEasing: native(
    'crates/osg-scene/src/easing.rs',
    "Including that 'ease' and 'ease-in-out' are the same quadratic and neither is the CSS curve.",
  ),
  pulseEnabled: inert('Validated and persisted end to end, with no render effect and no UI.'),
  pulseSpeed: inert('Validated and persisted end to end, with no render effect and no UI.'),
  shakeEnabled: inert('Validated and persisted end to end, with no render effect and no UI.'),
  shakeIntensity: inert('Validated and persisted end to end, with no render effect and no UI.'),

  // ---- Identity ------------------------------------------------------------------------------
  preset: native(
    'src/components/subtitleCustomization',
    'A label carried with the project. It selects field values rather than rendering anything.',
  ),
});

// The other sixteen persisted options: what the export is, rather than what the subtitles look
// like. Three of the shipped renderer's worst defects live in here, and all three are the kind that
// a user notices only after waiting for a long export to finish.
export const RENDER_OUTPUT_PARITY_LEDGER = Object.freeze({
  // ---- Output format -------------------------------------------------------------------------
  resolution: native(
    'crates/osg-export',
    'The conversion derives the composition size from it, and the scene refuses an odd edge before '
    + 'a render is wasted.',
  ),
  frameRate: native(
    'crates/osg-scene/src/timeline.rs',
    'Exact rational time, so 29.97 is 30000/1001 rather than a float that drifts.',
  ),

  // ---- Audio ---------------------------------------------------------------------------------
  originalAudioVolume: native(
    'crates/osg-audio',
    "The shipped 0-100 control divided by 100 into a linear gain, which is exactly what the editor's "
    + 'own volume prop does. osg-audio mirrors the vocabulary rather than inventing one.',
  ),
  narrationVolume: native(
    'crates/osg-audio',
    'The same shipped 0-100 scale as the original audio volume.',
  ),

  // ---- Trim ----------------------------------------------------------------------------------
  trimStart: fixed(
    'crates/osg-scene/src/timeline.rs',
    'VISIBLE CHANGE, and a bug fix. The shipped renderer trims the video with FFmpeg -ss but passes '
    + 'cue timestamps absolute and never rebases them, so any trimStart above zero shifts every '
    + 'subtitle in the exported file by exactly that much. The native renderer rebases cue times '
    + 'onto the trimmed timeline, so subtitles land where the editor showed them. Anyone who '
    + 'compensated by hand-editing their timings will see the compensation double.',
  ),
  trimEnd: native('crates/osg-export', 'Bounds the frame range; no rebase is needed at the end.'),

  // ---- Crop and canvas -----------------------------------------------------------------------
  x: fixed(
    'crates/osg-compositor',
    'VISIBLE CHANGE only where crop was already wrong. Crop is never applied by FFmpeg today: '
    + 'frames are extracted full size and the crop becomes CSS percentages, while the output '
    + 'dimensions are derived from the crop ratio. The compositor crops the source region for real, '
    + 'so the exported framing finally matches the crop UI.',
  ),
  y: fixed('crates/osg-compositor', 'See x — the same never-applied crop.'),
  width: fixed('crates/osg-compositor', 'See x — the same never-applied crop.'),
  height: fixed('crates/osg-compositor', 'See x — the same never-applied crop.'),
  aspectRatio: pending('Selects the output dimensions from the crop region.'),
  canvasBgMode: native(
    'crates/osg-compositor',
    'Solid, blur, and absent meaning transparent, all decided in the same GPU sampling pass as the '
    + 'crop rather than as a later composite.',
  ),
  canvasBgColor: native(
    'crates/osg-compositor',
    "Resolved through osg-scene's colour parser rather than a second one, so the shapes the crop "
    + 'validator accepts — including the four-digit #rgba shorthand — all parse rather than failing '
    + 'an entire export over a colour the schema calls valid. OPEN QUESTION for the compositor '
    + 'owner: a canvas colour carrying alpha leaves the uncovered area translucent, and the encoder '
    + 'discards alpha, so a translucent non-black backfill would export darker than it previews. '
    + 'Either force the backfill opaque or refuse alpha on this field specifically.',
  ),
  canvasBgBlur: native(
    'crates/osg-compositor',
    'A bounded separable two-pass Gaussian. The stored range reaches 1000 but the applied sigma '
    + 'clamps to 40, because beyond that the backdrop is already an unrecognisable wash and the '
    + 'per-frame cost would grow without limit. A stored 200 renders as 40.',
  ),
  flipX: native(
    'crates/osg-compositor',
    'A sampling transform, proven byte-identical to a column reversal of the unflipped frame.',
  ),
  flipY: native(
    'crates/osg-compositor',
    'A sampling transform, proven byte-identical to a row reversal of the unflipped frame.',
  ),
});

/**
 * The shipped renderer's duration rule, which is not a persisted field but decides how long every
 * export is.
 *
 * Today the final duration is whatever the actual extracted frame count turned out to be, which
 * overrides the computed duration. That makes the output length depend on how frame extraction
 * happened to behave rather than on the timeline the user set. The native renderer takes the
 * duration from the timeline, so an export is as long as the editor says it is.
 */
export const DURATION_SOURCE = Object.freeze({
  shipped: 'actual extracted frame count, overriding the computed duration',
  native: 'the scene timeline frame count',
  where: 'crates/osg-scene/src/timeline.rs',
});

const fieldsWithDisposition = (ledger, disposition) => Object.freeze(
  Object.keys(ledger).filter(field => ledger[field].disposition === disposition).sort(),
);

/** Fields whose disposition is still `pending`. Must be empty before the migration can be called done. */
export const pendingParityFields = () => fieldsWithDisposition(RENDER_PARITY_LEDGER, 'pending');

/** Fields the native renderer deliberately changes. Each one needs a release note. */
export const deliberatelyChangedFields = () => fieldsWithDisposition(RENDER_PARITY_LEDGER, 'fixed');

/** Output-settings fields still to implement. */
export const pendingOutputParityFields = () => fieldsWithDisposition(RENDER_OUTPUT_PARITY_LEDGER, 'pending');

/**
 * Every deliberate behaviour change across both ledgers, for the release notes.
 *
 * These are the changes a user can see in a file they already exported once. Shipping them without
 * saying so would look like the migration broke something.
 */
export const allDeliberateChanges = () => Object.freeze([
  ...deliberatelyChangedFields().map(field => ({ field, ...RENDER_PARITY_LEDGER[field] })),
  ...fieldsWithDisposition(RENDER_OUTPUT_PARITY_LEDGER, 'fixed')
    .map(field => ({ field, ...RENDER_OUTPUT_PARITY_LEDGER[field] })),
]);
