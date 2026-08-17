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
// Unused today, and kept deliberately. Every field is now reproduced, corrected or inert, so
// nothing constructs a pending entry — but `pending` is the vocabulary a field added tomorrow needs,
// and `pendingParityFields()` is still asserted to be empty. Deleting the constructor would make the
// next honest "not implemented yet" harder to write than a dishonest "native".
// eslint-disable-next-line no-unused-vars
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
  lineHeight: native(
    'src/platform/glyphAtlasShaping.js',
    'The baker owns it, and the compositor no longer applies it a second time — its multiplication '
    + 'by line_spacing and its baseline stepper are both gone. line_spacing survives only as the '
    + 'value the staging boundary bakes with, so changing it invalidates the atlas the way changing '
    + 'a family or a size does. A test asserts line spacing cannot alter a single byte of a frame.',
  ),
  letterSpacing: native(
    'src/platform/glyphAtlasShaping.js',
    'Added to every cluster advance including the last, as a browser does, never baked into the '
    + 'raster, and carried to the compositor as exact pen positions rather than reconstructed. The '
    + 'compositor has no pen accumulator left to diverge with.',
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
  maxWidth: native(
    'src/components/previews/native/nativePreviewGeometry.js',
    'The persisted value is a PERCENTAGE of the composition while the baker takes atlas pixels, and '
    + 'the atlas is baked once at its own size then scaled — so the bake request computes '
    + '(maxWidth / 100) * compositionWidth / glyphScale, where glyphScale mirrors the compositor. '
    + 'Passing a composition-space width straight through would wrap correctly at exactly one '
    + 'resolution and wrongly at every other: 1080p and 4K both give 1536 atlas pixels where the '
    + 'naive pass-through gives 3072 at 4K. Proven at the arithmetic, through a real bake where two '
    + 'resolutions produce byte-identical line breaks, and through the hook the editor mounts.',
  ),
  textAlign: native(
    'src/platform/glyphAtlasShaping.js',
    'All four, including justify. The baker distributes the stretch into the pen positions and the '
    + 'compositor only places the line box, so justify places identically to left — which is exactly '
    + 'right, because the stretch is already in the pens. CSS justifies every line of a block but '
    + 'the last, and only when there is a gap to grow.',
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
  rtlSupport: native(
    'src/platform/glyphAtlasBidi.js',
    'Real bidi, not a heuristic. The baker resolves UAX #9 P2/P3, W1-W7, N1/N2, I1/I2 and per-line '
    + 'L1/L2 and emits lines in VISUAL order. This entry previously stated as fact that the '
    + 'implementation was cross-checked against a reference over all 65,536 ordered four-character '
    + 'runs of a mixed pool. That measurement was really made, but in a scratch script that was '
    + 'deleted, so NOTHING IN THIS REPOSITORY REPRODUCES IT — the committed coverage is the '
    + 'example-based bidi cases in glyphAtlas.shaping.test.js. Cited as a claim it was an '
    + 'over-claim, and it is corrected here rather than quietly kept. It refuses '
    + 'what it does not implement — explicit embedding controls, isolates, and mirrored characters '
    + 'in right-to-left content — rather than drawing them wrong. The persisted setting forces the '
    + 'paragraph level; left unset the text decides it. Cursive scripts draw because a cell is baked '
    + "from the contextual form the run gives it, resolved by measurement rather than from a joining "
    + 'table. LIMIT, recorded rather than hidden: a form is matched on its advance, because an '
    + 'advance is the only per-candidate signal a measurement surface exposes, so a face whose two '
    + 'forms share an advance but not an outline can be spelled with the wrong one. No browser API '
    + 'can detect that; it belongs to the real-font parity run.',
  ),

  // ---- Timing and animation ------------------------------------------------------------------
  fadeInDuration: native(
    'crates/osg-scene/src/cues.rs',
    'Including the window that makes a cue visible before its start and after its end.',
  ),
  fadeOutDuration: native('crates/osg-scene/src/cues.rs'),
  animationType: native(
    'crates/osg-compositor/src/typewriter.rs',
    'All ten, with their asymmetries preserved — scale animates both ways, bounce only in. '
    + 'Typewriter counts the same UTF-16 units the shipped renderer counts but cuts at a cluster '
    + 'boundary, because the atlas has no half-cluster to draw: an astral cluster appears one frame '
    + 'later than the shipped renderer showed half a surrogate. Driven by raw fade progress rather '
    + 'than the eased value, so fadeInDuration of zero is structurally the shipped no-op. '
    + 'UNSETTLED and recorded at crates/osg-scene/src/animation.rs: whether the slide offsets should '
    + 'scale with the composition, which the shipped renderer does not do.',
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
  preset: inert(
    'A label carried with the project. Applying a preset writes the fields it names, and those '
    + 'fields render; the label itself reaches no renderer and changing it alone changes no pixel. '
    + 'It was classified `native` on the strength of what applying one does, which is the mistake '
    + 'this classification exists to prevent — `native` means the gate can prove the field moves '
    + 'the picture, and this one cannot, because it does not.',
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
    'The timeline is exact rational time rather than a float that drifts, so frame instants do not '
    + 'accumulate error however long the export. The persisted field is an integer restricted to '
    + '24, 25, 30, 50, 60 and 120 by `crates/osg-render/src/contract.rs`, and the conversion builds '
    + 'the timeline with a denominator of 1 — so every rate this field can select is a whole '
    + 'number. This entry used to cite 29.97 as 30000/1001, which the timeline can represent and '
    + 'this field cannot reach; the claim was true of the machinery and false of the setting.',
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
  aspectRatio: native(
    'crates/osg-export/src/convert/dimensions.rs',
    'Redundant, and proven so rather than assumed. The output frame is derived once — the height '
    + 'from the resolution the request was validated against, the width from the source aspect times '
    + 'the crop region ratio — and this field is never read. The editor never meaningfully writes it '
    + 'either: the aspect-ratio buttons hold their value in component state that resets to null on '
    + 'entering crop mode, and express themselves by writing the crop rectangle, so the ratio is '
    + 'already a property of width and height. Consulting it could only contradict the rectangle the '
    + 'user dragged. The conversion refuses if a future contract change starts disagreeing, so this '
    + 'cannot rot silently.',
  ),
  canvasBgMode: native(
    'crates/osg-compositor',
    'Solid, blur, and absent meaning transparent, all decided in the same GPU sampling pass as the '
    + 'crop rather than as a later composite.',
  ),
  canvasBgColor: native(
    'crates/osg-export/src/convert/crop.rs',
    "Resolved through osg-scene's colour parser rather than a second one, so every shape the crop "
    + 'validator accepts parses rather than failing an export over a colour the schema calls valid. '
    + 'The alpha question is settled before a frame is composed rather than left to the encoder: '
    + 'MP4/H.264 has no alpha channel, so a translucent backfill is handled explicitly at the '
    + 'conversion instead of silently exporting darker than it previewed.',
  ),
  canvasBgBlur: native(
    'crates/osg-compositor/src/crop.rs',
    'A bounded separable two-pass Gaussian. The stored value is a CSS blur RADIUS — the shipped '
    + 'renderer interpolates it into `blur(${canvasBgBlur}px)` — and CSS defines that as a Gaussian '
    + 'of HALF the length, so the applied sigma is the stored value halved. This entry previously '
    + 'described only the clamp, and the compositor applied the stored value as the sigma directly: '
    + 'the backfill rendered at twice the blur the editor showed, at every value a user can pick. '
    + 'It was found by an adversarial review rather than by a test, because the only committed blur '
    + 'assertions were the clamped extreme and zero, which are identical either way. The stored '
    + 'range reaches 1000 but the sigma clamps to 40, so clamping begins at a stored 80.',
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
