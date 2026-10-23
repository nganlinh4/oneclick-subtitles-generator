// Frozen material/animation sweep fixtures: control actions, vocabularies, the one animated cue
// and its independent timing authority.

import { activeCueAtFrom } from '../../src/components/previews/canvas/canvasSubtitleMath.js';

const freezeActions = actions => Object.freeze(actions.map(action => Object.freeze({ ...action })));

const dropdown = (token, field, selector, value, values) => Object.freeze({
  token, field, selector, kind: 'dropdown', value, values: Object.freeze(values),
});
const colour = (token, field, selector, value) => Object.freeze({
  token, field, selector, kind: 'colour', value,
});
const range = (token, field, selector, ratio, minimum, maximum) => Object.freeze({
  token, field, selector, kind: 'range', ratio, minimum, maximum,
});
const rangeAt = (token, field, selector, ratio, minimum, maximum, atSeconds) => Object.freeze({
  token, field, selector, kind: 'range', ratio, minimum, maximum, atSeconds,
});
const toggle = (token, field, selector, value) => Object.freeze({
  token, field, selector, kind: 'toggle', value,
});

const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);
const TRANSFORMS = Object.freeze(['none', 'uppercase', 'lowercase', 'capitalize']);
const BORDER_STYLES = Object.freeze(['none', 'solid', 'dashed', 'dotted', 'double']);
const GRADIENT_DIRECTIONS = Object.freeze(['0deg', '90deg', '45deg', '135deg', '180deg', '270deg']);
const POSITIONS = Object.freeze(['bottom', 'top', 'center', 'custom']);
export const CUSTOMIZATION_FIELD_COUNT = 56;
export const MAXIMUM_CONTINUITY_PLATEAU_MS = 500;
export const ANIMATION_TYPE_VALUES = Object.freeze([
  'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right',
  'scale', 'typewriter', 'bounce', 'flip', 'rotate',
]);
export const ANIMATION_EASING_VALUES = Object.freeze([
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
]);

const CSS_NAMED_BEZIERS = Object.freeze({
  ease: Object.freeze([0.25, 0.1, 0.25, 1]),
  'ease-in': Object.freeze([0.42, 0, 1, 1]),
  'ease-out': Object.freeze([0, 0, 0.58, 1]),
  'ease-in-out': Object.freeze([0.42, 0, 0.58, 1]),
});

const cubicBezierValue = (p1x, p1y, p2x, p2y, progress) => {
  const xAt = t => 3 * t * (1 - t) ** 2 * p1x + 3 * t * t * (1 - t) * p2x + t ** 3;
  const yAt = t => 3 * t * (1 - t) ** 2 * p1y + 3 * t * t * (1 - t) * p2y + t ** 3;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const mid = (low + high) / 2;
    if (xAt(mid) < progress) low = mid;
    else high = mid;
  }
  return yAt((low + high) / 2);
};

/**
 * Independent CSS-easing authority for the sweep. The slide displacement at a sampled instant is
 * `1 - eased(progress)` of the full offset, so its DIRECTION and whether it is measurable at all
 * depend on the easing: the overshoot bezier is already ≈1 (or beyond) at exit-sample progress,
 * where a fixed "must be above holding" claim is simply false. This evaluator is deliberately not
 * the product's implementation.
 */
export const sweepEasedProgress = (easing, progress) => {
  if (!Number.isFinite(progress)) throw new Error(`sweep progress is not finite: ${progress}`);
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  if (easing === 'linear') return progress;
  const named = CSS_NAMED_BEZIERS[easing];
  if (named !== undefined) return cubicBezierValue(...named, progress);
  const custom = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/u
    .exec(easing);
  if (custom === null) throw new Error(`sweep easing is not evaluable: ${easing}`);
  return cubicBezierValue(
    Number(custom[1]), Number(custom[2]), Number(custom[3]), Number(custom[4]), progress,
  );
};

/**
 * Non-Cartesian customer edits. Dormant fields are deliberately ordered behind an active Gaming
 * preset, so every action changes drawable pixels instead of merely changing a hidden value.
 */
export const MATERIAL_GROUPS = Object.freeze([
  Object.freeze({
    id: 'typography',
    step: '01-typography-material',
    description: 'Typography size, colour, alignment, line metrics and all text transforms remain native and drawable.',
    actions: freezeActions([
      range('font-size', 'fontSize', '#font-size-slider', 0.4, 8, 120),
      colour('text-colour', 'textColor', '#subtitle-text-color', '#f4ff65'),
      dropdown('align-left', 'textAlign', '#render-text-align', 'left', ALIGNMENTS),
      dropdown('align-right', 'textAlign', '#render-text-align', 'right', ALIGNMENTS),
      dropdown('align-justify', 'textAlign', '#render-text-align', 'justify', ALIGNMENTS),
      dropdown('align-center', 'textAlign', '#render-text-align', 'center', ALIGNMENTS),
      range('line-height', 'lineHeight', '#line-height-slider', 0.36, 0.5, 3),
      range('letter-spacing', 'letterSpacing', '#letter-spacing-slider', 0.65, -10, 10),
      dropdown('transform-uppercase', 'textTransform', '#render-text-transform', 'uppercase', TRANSFORMS),
      dropdown('transform-lowercase', 'textTransform', '#render-text-transform', 'lowercase', TRANSFORMS),
      dropdown('transform-capitalize', 'textTransform', '#render-text-transform', 'capitalize', TRANSFORMS),
      dropdown('transform-none', 'textTransform', '#render-text-transform', 'none', TRANSFORMS),
    ]),
  }),
  Object.freeze({
    id: 'background-border',
    step: '02-background-and-five-borders',
    description: 'Background material and all five border paints are selected through the shipped controls.',
    actions: freezeActions([
      colour('background-colour', 'backgroundColor', '#subtitle-background-color', '#243b55'),
      range('background-opacity', 'backgroundOpacity', '#background-opacity-slider', 0.6, 0, 100),
      range('border-radius', 'borderRadius', '#border-radius-slider', 0.25, 0, 100),
      colour('border-colour', 'borderColor', '#subtitle-border-color', '#65f4ff'),
      range('border-width', 'borderWidth', '#border-width-slider', 0.4, 0, 20),
      ...BORDER_STYLES.map(style => dropdown(
        `border-${style}`, 'borderStyle', '#subtitle-border-style', style, BORDER_STYLES,
      )),
    ]),
  }),
  Object.freeze({
    id: 'shadow-glow',
    step: '03-shadow-and-glow-material',
    description: 'Shadow and glow colours, geometry, intensity and both switches produce stable native pixels.',
    actions: freezeActions([
      colour('shadow-colour', 'textShadowColor', '#subtitle-text-shadow-color', '#ff3b81'),
      range('shadow-blur', 'textShadowBlur', '#shadow-blur-slider', 0.32, 0, 50),
      range('shadow-offset', 'textShadowOffsetY', '#shadow-offset-slider', 0.7, -25, 25),
      toggle('shadow-off', 'textShadowEnabled', '#text-shadow-enabled', false),
      toggle('shadow-on', 'textShadowEnabled', '#text-shadow-enabled', true),
      colour('glow-colour', 'glowColor', '#subtitle-glow-color', '#2ce8ff'),
      range('glow-intensity', 'glowIntensity', '#glow-intensity-slider', 0.35, 0, 100),
      toggle('glow-off', 'glowEnabled', '#glow-enabled', false),
      toggle('glow-on', 'glowEnabled', '#glow-enabled', true),
    ]),
  }),
  Object.freeze({
    id: 'gradient-stroke',
    step: '04-gradient-directions-and-stroke',
    description: 'The gradient, every shipped direction and the text stroke are visibly rendered by the native compositor.',
    actions: freezeActions([
      toggle('gradient-on', 'gradientEnabled', '#gradient-enabled', true),
      colour('gradient-start', 'gradientColorStart', '#subtitle-gradient-start-color', '#ff2ca8'),
      colour('gradient-end', 'gradientColorEnd', '#subtitle-gradient-end-color', '#2ce8ff'),
      ...GRADIENT_DIRECTIONS.map(direction => dropdown(
        `gradient-${direction}`, 'gradientDirection', '#subtitle-gradient-direction', direction,
        GRADIENT_DIRECTIONS,
      )),
      colour('stroke-colour', 'strokeColor', '#subtitle-stroke-color', '#ffffff'),
      range('stroke-width', 'strokeWidth', '#stroke-width-slider', 0.35, 0, 10),
      toggle('stroke-off', 'strokeEnabled', '#stroke-enabled', false),
      toggle('stroke-on', 'strokeEnabled', '#stroke-enabled', true),
    ]),
  }),
  Object.freeze({
    id: 'anchored-positions',
    step: '05-anchors-and-margins',
    description: 'Top, centre and bottom anchors plus all four margins move and constrain the real subtitle box.',
    actions: freezeActions([
      dropdown('position-top', 'position', '#subtitle-position', 'top', POSITIONS),
      range('margin-top', 'marginTop', '#margin-top-slider', 0.06, 0, 2_000),
      range('margin-left', 'marginLeft', '#margin-left-slider', 0.03, 0, 2_000),
      range('margin-right', 'marginRight', '#margin-right-slider', 0.05, 0, 2_000),
      dropdown('position-center', 'position', '#subtitle-position', 'center', POSITIONS),
      dropdown('position-bottom', 'position', '#subtitle-position', 'bottom', POSITIONS),
      range('margin-bottom', 'marginBottom', '#margin-bottom-slider', 0.06, 0, 2_000),
    ]),
  }),
  Object.freeze({
    id: 'custom-position',
    step: '06-custom-position-and-wrap',
    description: 'Custom X/Y placement and maximum width stay inside the drawable composition and persist exactly.',
    actions: freezeActions([
      dropdown('position-custom', 'position', '#subtitle-position', 'custom', POSITIONS),
      // Keep the deliberately wide 69% subtitle box visibly inside the composition. A 25%
      // centre puts its left edge at -9.5%, so the old screenshot contradicted this group's own
      // containment claim while every persistence/pixel-change assertion stayed green.
      range('position-x', 'customPositionX', '#position-x-slider', 0.4, 0, 100),
      range('position-y', 'customPositionY', '#position-y-slider', 0.5, 0, 100),
      range('maximum-width', 'maxWidth', '#max-width-slider', 0.42, 10, 150),
    ]),
  }),
  Object.freeze({
    id: 'animation-timing',
    step: '07-entry-and-exit-timing',
    description: 'Fade-in and fade-out durations change pixels at their own cue boundaries and persist exactly.',
    actions: freezeActions([
      rangeAt('fade-in-duration', 'fadeInDuration', '#fade-in-duration-slider', 0.6, 0, 2, 1.8),
      rangeAt('fade-out-duration', 'fadeOutDuration', '#fade-out-duration-slider', 0.6, 0, 2, 14.2),
    ]),
  }),
]);

export const ANIMATION_CUE = Object.freeze({
  start: 2,
  end: 14,
  fadeIn: 1.2,
  fadeOut: 1.2,
  witnessStart: 0.9,
  witnessEnd: 14.9,
});

const anchorCases = ANIMATION_EASING_VALUES.map((easing, index) => Object.freeze({
  index,
  id: `${String(index + 1).padStart(2, '0')}-slide-up-easing-${index + 1}`,
  type: 'slide-up',
  easing,
  sweep: 'easing-anchor',
  editType: index === 0,
  editEasing: true,
  captureEvidence: index === ANIMATION_EASING_VALUES.length - 1,
}));
const remainingCases = ANIMATION_TYPE_VALUES.filter(type => type !== 'slide-up').map((type, offset) => (
  Object.freeze({
    index: anchorCases.length + offset,
    id: `${String(anchorCases.length + offset + 1).padStart(2, '0')}-${type}`,
    type,
    easing: 'linear',
    sweep: 'animation-type',
    editType: true,
    editEasing: offset === 0,
    captureEvidence: ['bounce', 'typewriter'].includes(type),
  })
));
export const ANIMATION_CASES = Object.freeze([...anchorCases, ...remainingCases]);

export const ANIMATION_PHASES = Object.freeze([
  Object.freeze({
    name: 'entry', seconds: 1.28, minimum: 1.15, maximum: 1.5,
    expectedPhase: 'fadingIn', expectedProgress: 0.4,
  }),
  Object.freeze({
    name: 'steady', seconds: 8, minimum: 4, maximum: 12,
    expectedPhase: 'holding', expectedProgress: 1,
  }),
  Object.freeze({
    name: 'exit', seconds: 14.48, minimum: 14.35, maximum: 14.6,
    expectedPhase: 'fadingOut', expectedProgress: 0.6,
  }),
]);

/**
 * Independent timing authority for this one-cue fixture.
 *
 * The compositor uses `activeCueAtFrom`; an E2E oracle cannot use only the same implementation to
 * decide whether its samples are really inside the authored fades. Keep the deliberately small
 * fixture maths here so a shared boundary/progress regression makes the journey red.
 */
export const expectedAnimationCueAt = (seconds) => {
  if (!Number.isFinite(seconds)) return null;
  const entryStart = ANIMATION_CUE.start - ANIMATION_CUE.fadeIn;
  const exitEnd = ANIMATION_CUE.end + ANIMATION_CUE.fadeOut;
  if (seconds >= entryStart && seconds < ANIMATION_CUE.start) {
    return Object.freeze({
      phase: 'fadingIn',
      progress: (seconds - entryStart) / ANIMATION_CUE.fadeIn,
    });
  }
  if (seconds >= ANIMATION_CUE.start && seconds <= ANIMATION_CUE.end) {
    return Object.freeze({ phase: 'holding', progress: 1 });
  }
  if (seconds > ANIMATION_CUE.end && seconds <= exitEnd) {
    return Object.freeze({
      phase: 'fadingOut',
      progress: (exitEnd - seconds) / ANIMATION_CUE.fadeOut,
    });
  }
  return null;
};

export const activeAnimationCueAt = seconds => activeCueAtFrom(
  [{ start: ANIMATION_CUE.start, end: ANIMATION_CUE.end }],
  seconds,
  ANIMATION_CUE.fadeIn,
  ANIMATION_CUE.fadeOut,
  0,
);

export const materialControlTokens = () => MATERIAL_GROUPS.flatMap(group => (
  group.actions.map(action => action.token)
));
