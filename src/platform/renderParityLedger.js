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
  lineHeight: pending('Needs the glyph atlas line metrics wired into layout.'),
  letterSpacing: pending('Baked per grapheme cluster; the atlas carries advances but layout is unwired.'),
  textTransform: pending('Applied before shaping, so it must happen on the WebView side of the atlas.'),

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
    'crates/osg-scene/src/color.rs',
    'Including the interaction that surprises users: the gradient clips the background box away.',
  ),
  gradientColorStart: pending('Needs the gradient fill in the compositor shader.'),
  gradientColorEnd: pending('Needs the gradient fill in the compositor shader.'),
  gradientDirection: pending('Needs the gradient fill in the compositor shader.'),
  gradientType: inert('Persisted and validated, but the shipped renderer only ever draws linear.'),
  gradientColorMid: inert('Persisted and validated, but never sampled by the shipped renderer.'),

  // ---- Decoration ----------------------------------------------------------------------------
  strokeEnabled: pending('Glyph outline pass in the compositor.'),
  strokeWidth: pending('Glyph outline pass in the compositor.'),
  strokeColor: pending('Glyph outline pass in the compositor.'),
  textShadowEnabled: pending('Blur pass in the compositor.'),
  textShadowColor: pending('Blur pass in the compositor.'),
  textShadowBlur: pending('Blur pass in the compositor.'),
  textShadowOffsetX: pending('Renders today but has no UI control; keep it rendering.'),
  textShadowOffsetY: pending('Blur pass in the compositor.'),
  glowEnabled: pending(
    'Reproduce as the shipped box-shadow, which glows the box rather than the glyphs. Changing it '
    + 'to a real text glow would alter every existing project that enables it.',
  ),
  glowColor: pending('See glowEnabled.'),
  glowIntensity: pending('See glowEnabled.'),
  multiShadowEnabled: inert('Validated and persisted end to end, with no render effect and no UI.'),
  shadowLayers: inert('Validated and persisted end to end, with no render effect and no UI.'),

  // ---- Box -----------------------------------------------------------------------------------
  borderRadius: pending('Rounded-rect background in the compositor.'),
  borderWidth: pending('Background border in the compositor.'),
  borderColor: pending('Background border in the compositor.'),
  borderStyle: pending('Dashed and dotted need a shader pattern, not just a colour.'),

  // ---- Position and box metrics --------------------------------------------------------------
  position: native('crates/osg-scene/src/layout.rs'),
  customPositionX: native('crates/osg-scene/src/layout.rs'),
  customPositionY: native('crates/osg-scene/src/layout.rs'),
  marginTop: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginBottom: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginLeft: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  marginRight: native('crates/osg-scene/src/layout.rs', 'Fixed 1920x1080 percentage, unlike sizes.'),
  maxWidth: native('crates/osg-scene/src/layout.rs'),
  textAlign: native('crates/osg-scene/src/layout.rs', "Including 'justify', which has no UI control."),

  // ---- Wrapping ------------------------------------------------------------------------------
  wordWrap: pending('Renders today with no UI control; line breaking is not wired yet.'),
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
  animationType: native(
    'crates/osg-scene/src/animation.rs',
    'All ten, with their asymmetries preserved: scale animates both ways, bounce only in.',
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

/** Fields whose disposition is still `pending`. Must be empty before the migration can be called done. */
export const pendingParityFields = () => Object.freeze(
  Object.keys(RENDER_PARITY_LEDGER)
    .filter(field => RENDER_PARITY_LEDGER[field].disposition === 'pending')
    .sort(),
);

/** Fields the native renderer deliberately changes. Each one needs a release note. */
export const deliberatelyChangedFields = () => Object.freeze(
  Object.keys(RENDER_PARITY_LEDGER)
    .filter(field => RENDER_PARITY_LEDGER[field].disposition === 'fixed')
    .sort(),
);
