import { strict as assert } from 'node:assert';

import {
  activeCueAtFrom,
  easeSubtitle,
} from '../../src/components/previews/canvas/canvasSubtitleMath.js';

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
const CUSTOMIZATION_FIELD_COUNT = 56;
const MAXIMUM_CONTINUITY_PLATEAU_MS = 500;
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

const assertDrawableState = (state, context, paused) => {
  assert.ok(state?.canvas?.revision > 0, `${context}: compositor published no revision`);
  assert.ok(state.canvas.overlayRebuilds > 0, `${context}: subtitle overlay was never built`);
  assert.equal(state.canvas.cue, '0', `${context}: the authored cue is absent`);
  assert.ok(state.canvas.width > 0 && state.canvas.height > 0, `${context}: canvas has no pixels`);
  assert.equal(state.preview?.status, 'ready', `${context}: preview is not ready`);
  assert.equal(state.preview?.code, null, `${context}: preview refused with ${state.preview?.code}`);
  assert.ok(state.video?.readyState >= 2 && state.video.error === null, `${context}: video is unreadable`);
  if (typeof paused === 'boolean') assert.equal(state.video.paused, paused, `${context}: wrong playback state`);
  assert.deepEqual(state.currentErrors, [], `${context}: a visible error remains`);
  assert.deepEqual(state.recordedErrors, [], `${context}: a transient error was recorded`);
  assert.deepEqual(state.recordedRefusals, [], `${context}: a transient preview refusal was recorded`);
};

const assertCompleteCustomization = (actual, expected, context) => {
  assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), (
    `${context}: durable customization is absent`
  ));
  assert.equal(Object.keys(expected).length, CUSTOMIZATION_FIELD_COUNT, (
    `${context}: expected customization does not cover all ${CUSTOMIZATION_FIELD_COUNT} fields`
  ));
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), (
    `${context}: durable customization field set changed`
  ));
  assert.deepEqual(actual, expected, `${context}: cumulative durable customization diverged`);
};

const assertSceneAuthority = (scene, expectedProjectId, context) => {
  assert.equal(typeof expectedProjectId, 'string', `${context}: expected project identity is absent`);
  assert.ok(expectedProjectId.length > 0, `${context}: expected project identity is blank`);
  assert.equal(scene?.projectId, expectedProjectId, `${context}: durable scene belongs to another project`);
  assert.equal(scene?.schemaVersion, 1, `${context}: durable scene schema is not v1`);
};

export const verifyMaterialAction = ({
  spec,
  observedValue,
  beforeRevision,
  expectedCustomization,
  expectedProjectId,
  durableScene,
  frameChange,
  state,
}) => {
  assert.ok(materialControlTokens().includes(spec?.token), 'material action is outside the frozen matrix');
  assert.ok(Number.isSafeInteger(beforeRevision) && beforeRevision >= 0, `${spec.token}: bad prior revision`);
  assert.ok(durableScene?.sceneRevision > beforeRevision, `${spec.token}: durable scene did not advance`);
  assertSceneAuthority(durableScene, expectedProjectId, spec.token);
  assertCompleteCustomization(
    durableScene.scene?.customization,
    expectedCustomization,
    spec.token,
  );
  const durableValue = durableScene.scene.customization[spec.field];
  assert.deepEqual(durableValue, observedValue, `${spec.token}: public control and SQLite disagree`);
  if (spec.kind !== 'range') assert.deepEqual(observedValue, spec.value, `${spec.token}: wrong public value`);
  else {
    assert.ok(typeof observedValue === 'number' && Number.isFinite(observedValue), `${spec.token}: range is not numeric`);
    assert.ok(observedValue >= spec.minimum && observedValue <= spec.maximum, `${spec.token}: range escaped bounds`);
  }
  assert.equal(expectedCustomization[spec.field], observedValue, `${spec.token}: intended delta is wrong`);
  assert.equal(expectedCustomization.preset, 'custom', `${spec.token}: intended scene kept a preset identity`);
  assertDrawableState(state, spec.token, true);
  assert.ok(frameChange?.pixels?.changedPixels >= 32, `${spec.token}: changed too few pixels`);
  assert.ok(frameChange.pixels.changedRatio >= 0.000_05, `${spec.token}: pixel change is not meaningful`);
  assert.ok(frameChange.ssim < 0.999_99, `${spec.token}: rendered frame did not materially change`);
  return Object.freeze({
    token: spec.token,
    field: spec.field,
    selector: spec.selector,
    value: observedValue,
    sceneRevision: durableScene.sceneRevision,
    canvasRevision: state.canvas.revision,
    overlayRebuilds: state.canvas.overlayRebuilds,
    ssim: frameChange.ssim,
    changedPixels: frameChange.pixels.changedPixels,
    changedRatio: frameChange.pixels.changedRatio,
    customizationFields: Object.keys(expectedCustomization).length,
  });
};

export const verifyMaterialCoverage = (
  observations,
  { expectedCustomization, durableCustomization } = {},
) => {
  assert.ok(Array.isArray(observations), 'material observations must be an array');
  const expected = materialControlTokens();
  assert.deepEqual(observations.map(item => item.token), expected, 'material controls were skipped or reordered');
  for (let index = 1; index < observations.length; index += 1) {
    assert.ok(observations[index].sceneRevision > observations[index - 1].sceneRevision, (
      `material scene revision did not increase at ${observations[index].token}`
    ));
  }
  assertCompleteCustomization(
    durableCustomization,
    expectedCustomization,
    'final material scene',
  );
  return Object.freeze({ actions: observations.length, groups: MATERIAL_GROUPS.length });
};

/**
 * Prove the high-contrast subtitle material remains inside the visible composition.
 *
 * The source/composed screenshots can differ by low-energy WebView colour conversion and by a
 * disconnected narrow crop fringe at a fractional CSS edge. The fixture's high-contrast double
 * border is one continuous component, so the journey supplies the dominant thresholded component;
 * this oracle refuses that actual material box when it touches any frame edge.
 */
export const verifySubtitleContainment = (geometry, { minimumInsetPixels = 1 } = {}) => {
  assert.ok(geometry !== null && typeof geometry === 'object', 'subtitle containment geometry is absent');
  assert.ok(Number.isSafeInteger(geometry.width) && geometry.width > 0, 'subtitle containment width is invalid');
  assert.ok(Number.isSafeInteger(geometry.height) && geometry.height > 0, 'subtitle containment height is invalid');
  assert.ok(Number.isSafeInteger(minimumInsetPixels) && minimumInsetPixels >= 1, (
    'subtitle containment inset must be a positive integer'
  ));
  assert.ok(Number.isSafeInteger(geometry.changedPixels) && geometry.changedPixels > 0, (
    'subtitle containment has no changed pixels'
  ));
  assert.ok(Number.isSafeInteger(geometry.componentCount) && geometry.componentCount >= 1, (
    'subtitle containment has no measured components'
  ));
  const dominant = geometry.dominant;
  assert.ok(dominant !== null && typeof dominant === 'object', (
    'subtitle containment has no dominant material component'
  ));
  assert.ok(Number.isSafeInteger(dominant.changedPixels) && dominant.changedPixels >= 64, (
    'subtitle containment dominant material component is too small'
  ));
  assert.ok(geometry.changedPixels >= dominant.changedPixels, (
    'subtitle containment dominant material exceeds the complete difference mask'
  ));
  assert.ok(Number.isSafeInteger(geometry.outsideDominantHaloChangedPixels)
    && geometry.outsideDominantHaloChangedPixels >= 0, (
    'subtitle containment did not measure differences outside the material halo'
  ));
  assert.ok(Number.isSafeInteger(geometry.outsideDominantHaloInteriorChangedPixels)
    && geometry.outsideDominantHaloInteriorChangedPixels >= 0
    && geometry.outsideDominantHaloInteriorChangedPixels
      <= geometry.outsideDominantHaloChangedPixels, (
    'subtitle containment has invalid interior contamination measurements'
  ));
  assert.equal(geometry.outsideDominantHaloInteriorChangedPixels, 0, (
    'subtitle containment source and candidate differ outside the material and frame-edge fringe'
  ));
  const bounds = dominant.bounds;
  assert.ok(bounds !== null && typeof bounds === 'object', 'subtitle containment has no dominant bounds');
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isSafeInteger(bounds[field]), `subtitle containment ${field} is invalid`);
  }
  assert.ok(bounds.width > 0 && bounds.height > 0, 'subtitle containment bounds are empty');
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  assert.ok(bounds.x >= minimumInsetPixels, 'subtitle material is clipped at the left composition edge');
  assert.ok(bounds.y >= minimumInsetPixels, 'subtitle material is clipped at the top composition edge');
  assert.ok(right <= geometry.width - minimumInsetPixels, (
    'subtitle material is clipped at the right composition edge'
  ));
  assert.ok(bottom <= geometry.height - minimumInsetPixels, (
    'subtitle material is clipped at the bottom composition edge'
  ));
  return Object.freeze({
    minimumInsetPixels,
    componentCount: geometry.componentCount,
    dominantChangedPixels: dominant.changedPixels,
    otherComponentChangedPixels: geometry.changedPixels - dominant.changedPixels,
    frameEdgeFringePixels: geometry.frameEdgeFringePixels,
    dominantHaloPixels: geometry.dominantHaloPixels,
    outsideDominantHaloChangedPixels: geometry.outsideDominantHaloChangedPixels,
    left: bounds.x,
    top: bounds.y,
    right: geometry.width - right,
    bottom: geometry.height - bottom,
  });
};

const assertFrameProof = (proof, context) => {
  assert.ok(proof !== null && typeof proof === 'object', `${context}: frame proof is absent`);
  for (const [name, signal] of [['composed', proof.composedSignal], ['source', proof.sourceSignal]]) {
    assert.ok(signal?.totalPixels > 0, `${context}: ${name} signal is absent`);
    assert.ok(signal.opaqueRatio >= 0.99, `${context}: ${name} frame is unexpectedly transparent`);
    assert.ok(signal.nearBlackRatio < 0.985, `${context}: ${name} frame is a black target`);
    assert.ok(signal.meanLuma >= 2, `${context}: ${name} frame carries no measured light`);
  }
  assert.ok(proof.subtitlePixels?.changedPixels >= 64, `${context}: composed frame is source-only`);
  assert.ok(proof.subtitlePixels.changedRatio >= 0.000_1, `${context}: subtitle pixels are negligible`);
  assert.ok(proof.subtitlePixels.maximumChannelDelta >= 32, `${context}: subtitle contrast is negligible`);
  assert.equal(proof.subtitleGeometry?.changedPixels, proof.subtitlePixels.changedPixels, (
    `${context}: spatial and scalar pixel oracles disagree`
  ));
  assert.ok(Number.isFinite(proof.subtitleGeometry?.centroidXRatio), `${context}: subtitle has no X centroid`);
  assert.ok(Number.isFinite(proof.subtitleGeometry?.centroidYRatio), `${context}: subtitle has no Y centroid`);
  assert.ok(proof.subtitleGeometry?.bounds?.areaPixels >= proof.subtitleGeometry.changedPixels, (
    `${context}: subtitle bounds cannot contain its changed pixels`
  ));
  assert.ok(
    proof.subtitleGeometry.bounds.areaPixels
      < proof.subtitleGeometry.width * proof.subtitleGeometry.height * 0.9,
    `${context}: subtitle geometry is contaminated across the full composition`,
  );
  assert.ok(proof.subtitleGeometry.meanChangedChannelDelta > 0, `${context}: subtitle carries no pixel energy`);
};

const longestPlateauMs = (samples, read) => {
  let longest = 0;
  let started = samples[0].atMs;
  let last = read(samples[0]);
  for (let index = 1; index < samples.length; index += 1) {
    const value = read(samples[index]);
    if (value > last) {
      longest = Math.max(longest, samples[index].atMs - started);
      started = samples[index].atMs;
      last = value;
    }
  }
  return Math.max(longest, samples.at(-1).atMs - started);
};

const assertRecoveredMediaEvents = (events, context) => {
  assert.ok(Array.isArray(events), `${context}: media-event ledger is absent`);
  const allowed = new Set(['abort', 'emptied', 'error', 'playing', 'stalled', 'waiting']);
  let priorAtMs = -1;
  for (const [index, event] of events.entries()) {
    assert.ok(event !== null && typeof event === 'object' && !Array.isArray(event), (
      `${context}: media event ${index} is invalid`
    ));
    assert.ok(allowed.has(event.type), `${context}: unexpected media event ${event.type}`);
    assert.ok(Number.isFinite(event.atMs) && event.atMs >= priorAtMs, (
      `${context}: media event clocks moved backwards at ${index}`
    ));
    assert.ok(Number.isFinite(event.mediaTime) && event.mediaTime >= 0, (
      `${context}: media event ${index} has no source clock`
    ));
    priorAtMs = event.atMs;
  }

  const hardFailure = events.find(({ type }) => ['abort', 'emptied', 'error'].includes(type));
  assert.equal(hardFailure, undefined, (
    `${context}: source video emitted fatal ${hardFailure?.type ?? 'media'} event`
  ));
  const stalled = events.find(({ type }) => type === 'stalled');
  assert.equal(stalled, undefined, `${context}: source video emitted a stalled event`);

  const recoveries = [];
  for (const [index, waiting] of events.entries()) {
    if (waiting.type !== 'waiting') continue;
    const playing = events.slice(index + 1).find(event => event.type === 'playing');
    assert.ok(playing !== undefined, `${context}: media waiting event never recovered to playing`);
    const recoveryMs = playing.atMs - waiting.atMs;
    assert.ok(recoveryMs >= 0 && recoveryMs < MAXIMUM_CONTINUITY_PLATEAU_MS, (
      `${context}: media waiting recovery took ${recoveryMs}ms; `
      + `continuity permits less than ${MAXIMUM_CONTINUITY_PLATEAU_MS}ms`
    ));
    recoveries.push(Object.freeze({
      waitingAtMs: waiting.atMs,
      playingAtMs: playing.atMs,
      recoveryMs,
    }));
  }
  return Object.freeze(recoveries);
};

const sampleFallsInsideRecovery = (sample, recoveries) => recoveries.some(recovery => (
  sample.atMs >= recovery.waitingAtMs && sample.atMs <= recovery.playingAtMs
));

const assertTemporalPhase = (samples, phase, context) => {
  assert.ok(Array.isArray(samples) && samples.length >= 5, `${context}: too few ${phase.name} samples`);
  for (const [index, sample] of samples.entries()) {
    assert.ok(Number.isFinite(sample.atMs) && sample.atMs >= 0, `${context}: invalid sample clock`);
    assert.ok(sample.mediaTime >= phase.minimum && sample.mediaTime <= phase.maximum, (
      `${context}: ${phase.name} sample escaped its cue window: ${sample.mediaTime}`
    ));
    const expected = expectedAnimationCueAt(sample.mediaTime);
    assert.equal(expected?.phase, phase.expectedPhase, (
      `${context}: ${phase.name} sample is ${expected?.phase ?? 'inactive'} under authored cue maths`
    ));
    const active = activeAnimationCueAt(sample.mediaTime);
    assert.equal(active?.phase, expected?.phase, `${context}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${context}: product and authored cue progress disagree`
    ));
    assert.ok(Number.isSafeInteger(sample.revision) && sample.revision > 0, `${context}: invalid revision`);
    assert.ok(Number.isSafeInteger(sample.overlayRebuilds) && sample.overlayRebuilds > 0, `${context}: invalid overlay revision`);
    assert.equal(sample.cue, '0', `${context}: subtitle blinked during ${phase.name}`);
    assert.equal(sample.preview, 'ready', `${context}: preview left ready during ${phase.name}`);
    assert.equal(sample.previewCode, null, `${context}: preview refused during ${phase.name}`);
    assert.equal(sample.paused, false, `${context}: playback paused during ${phase.name}`);
    assert.equal(sample.ended, false, `${context}: playback ended during ${phase.name}`);
    assert.ok(Number.isSafeInteger(sample.readyState)
      && sample.readyState >= 0 && sample.readyState <= 4
      && sample.error === null, `${context}: media failed during ${phase.name}`);
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during ${phase.name}`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: transient refusal during ${phase.name}`);
    if (index > 0) {
      assert.ok(sample.atMs > samples[index - 1].atMs, `${context}: rAF clock did not advance`);
      assert.ok(sample.mediaTime + 0.002 >= samples[index - 1].mediaTime, `${context}: media moved backwards`);
      assert.ok(sample.revision >= samples[index - 1].revision, `${context}: compositor revision moved backwards`);
    }
  }
  assert.ok(samples.at(-1).mediaTime - samples[0].mediaTime >= 0.2, `${context}: media stalled`);
  assert.ok(samples.at(-1).revision - samples[0].revision >= 2, `${context}: compositor froze`);
  assert.ok(longestPlateauMs(samples, sample => sample.mediaTime) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: media plateaued`
  ));
  assert.ok(longestPlateauMs(samples, sample => sample.revision) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: compositor plateaued`
  ));
};

// The fixture video decodes at 15 fps, so the compositor's SCENE clock (which owns cue selection
// and eased alpha) can lead the decoded pixel clock by up to one source frame plus timer jitter.
const SOURCE_PIXEL_CLOCK_LAG_SECONDS = (1 / 15) + 0.005;

const assertCompleteVisibleSample = (sample, context, expectsSubtitleInk = true) => {
  const visual = sample?.visual;
  const failureFrame = JSON.stringify({
    atMs: sample?.atMs,
    mediaTime: sample?.mediaTime,
    revision: sample?.revision,
    overlayRebuilds: sample?.overlayRebuilds,
    visual,
  });
  assert.equal(visual?.classified, true, `${context}: visible canvas publication is unclassified`);
  assert.ok([
    'pixels-and-operation-trace',
    'tainted-operation-trace',
  ].includes(visual.mode), `${context}: visual sentinel has no authoritative mode`);
  assert.ok(Number.isSafeInteger(visual.publication) && visual.publication > 0, (
    `${context}: visual publication sequence is invalid`
  ));
  assert.equal(visual.blank, false, `${context}: blank frame reached the visible canvas: ${failureFrame}`);
  assert.equal(visual.transparent, false, (
    `${context}: transparent frame reached the visible canvas: ${failureFrame}`
  ));
  assert.equal(visual.black, false, `${context}: black frame reached the visible canvas: ${failureFrame}`);
  assert.equal(visual.visible, true, `${context}: composed canvas became invisible: ${failureFrame}`);
  assert.equal(visual.hasVideo, true, `${context}: visible frame has no decoded video: ${failureFrame}`);
  // `null` marks a zero-crossing window where the scene clock and the pixel clock straddle the
  // eased-opacity boundary: either an inked or a source-only publication is mathematically
  // legitimate there, and only the completeness claims above apply.
  if (expectsSubtitleInk === null) return;
  if (expectsSubtitleInk) {
    assert.equal(visual.sourceOnly, false, (
      `${context}: source-only frame reached the visible canvas: ${failureFrame}`
    ));
    assert.equal(visual.hasOverlay, true, `${context}: visible frame has no subtitle paint: ${failureFrame}`);
    assert.equal(visual.hasGlyphInk, true, `${context}: visible frame has no glyph ink: ${failureFrame}`);
  } else {
    // CSS permits cubic-bezier y control points outside 0..1. Interpolated opacity is then clamped
    // at the property boundary, so the reviewed overshoot curve intentionally emits complete
    // source-only frames while its eased fade value is <= 0. This is not a compositor blink: cue
    // identity/readiness and the video publication remain continuous, and both Canvas and Rust use
    // this same easing. Accept exactly that mathematical interval, not arbitrary missing ink.
    assert.equal(visual.sourceOnly, true, (
      `${context}: non-positive eased opacity unexpectedly carried subtitle pixels: ${failureFrame}`
    ));
    assert.equal(visual.hasOverlay, false, `${context}: zero-opacity frame carried subtitle paint`);
    assert.equal(visual.hasGlyphInk, false, `${context}: zero-opacity frame carried glyph ink`);
  }
  assert.ok(Number.isFinite(visual.sourceTime), `${context}: visible frame has no source clock`);
  assert.ok(Math.abs(visual.sourceTime - sample.mediaTime) < 0.25, (
    `${context}: visible pixels lagged the playback clock: ${failureFrame}`
  ));
};

const assertVisualContinuity = (samples, context, easing = null, animationType = null) => {
  const classified = samples.filter(sample => sample.visual?.classified === true);
  assert.ok(classified.length >= samples.length * 0.95, (
    `${context}: visual publication sentinel stayed unclassified for too many frames`
  ));
  assert.ok(classified[0]?.atMs < 500, `${context}: visible canvas published nothing for 500ms`);
  const firstClassifiedIndex = samples.indexOf(classified[0]);
  assert.ok(samples.slice(firstClassifiedIndex).every(sample => sample.visual?.classified === true), (
    `${context}: visual publication sentinel lost the visible canvas after attaching`
  ));
  let intentionalZeroOpacitySamples = 0;
  for (const [index, sample] of classified.entries()) {
    const visual = sample.visual;
    // Bind subtitle expectations to the clock recorded when drawImage(video) actually published
    // these pixels — the later rAF witness clock manufactured a one-frame "blink" — but the eased
    // ALPHA the composition used follows the SCENE clock, which legitimately leads the decoded
    // pixel clock by up to one source frame. Demand ink only when the whole clock window owes it,
    // demand source-only only when the whole window is at non-positive opacity, and accept either
    // publication inside a window that straddles the zero crossing.
    const pixelTime = Number.isFinite(visual.sourceTime) ? visual.sourceTime : sample.mediaTime;
    const inkOwedAt = (instant) => {
      const active = activeAnimationCueAt(instant);
      return active === null || easeSubtitle(active.progress, easing) > 0;
    };
    const expectsSubtitleInk = easing === null
      ? true
      : (() => {
        // Typewriter reveals glyphs cumulatively through the fade-in: at low progress ZERO
        // characters are typed yet, so an inkless overlay is correct product behavior for an
        // unknowable slice of the ramp (the reveal boundary depends on cluster widths). The
        // per-phase frame proofs still pin that typewriter entry carries fewer pixels than
        // holding, so accepting either publication during its fade-in loses no coverage.
        if (animationType === 'typewriter') {
          const active = activeAnimationCueAt(pixelTime);
          if (active !== null && active.phase === 'fadingIn') return null;
        }
        const atPixels = inkOwedAt(pixelTime);
        const atScene = inkOwedAt(pixelTime + SOURCE_PIXEL_CLOCK_LAG_SECONDS);
        return atPixels === atScene ? atPixels : null;
      })();
    if (expectsSubtitleInk !== true && visual.sourceOnly === true) intentionalZeroOpacitySamples += 1;
    assertCompleteVisibleSample(sample, context, expectsSubtitleInk);
    if (index > 0) {
      assert.ok(visual.publication >= classified[index - 1].visual.publication, (
        `${context}: visible publication sequence moved backwards`
      ));
    }
  }
  assert.ok(longestPlateauMs(
    classified,
    sample => sample.visual.publication,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: visible canvas publication plateaued`
  ));
  return Object.freeze({
    samples: classified.length,
    publications: classified.at(-1).visual.publication - classified[0].visual.publication + 1,
    modes: Object.freeze([...new Set(classified.map(sample => sample.visual.mode))].sort()),
    intentionalZeroOpacitySamples,
    firstFailure: null,
  });
};

const assertPlaybackContinuity = (samples, mediaEvents, animation) => {
  const context = `${animation.type}/${animation.easing}`;
  assert.ok(Array.isArray(samples) && samples.length >= 120, `${context}: continuous witness is too sparse`);
  const recoveries = assertRecoveredMediaEvents(mediaEvents, context);
  assert.ok(samples[0].mediaTime <= ANIMATION_CUE.witnessStart + 0.2, (
    `${context}: continuous witness missed fade entry`
  ));
  assert.ok(samples.at(-1).mediaTime >= ANIMATION_CUE.witnessEnd - 0.1, (
    `${context}: continuous witness missed fade exit`
  ));
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.cue, '0', `${context}: subtitle blinked at ${sample.mediaTime}s`);
    assert.equal(sample.preview, 'ready', `${context}: preview left ready at ${sample.mediaTime}s`);
    assert.equal(sample.previewCode, null, `${context}: preview refused at ${sample.mediaTime}s`);
    assert.equal(sample.paused, false, `${context}: playback paused at ${sample.mediaTime}s`);
    assert.equal(sample.ended, false, `${context}: playback ended before the cue exit`);
    assert.ok(Number.isSafeInteger(sample.readyState)
      && sample.readyState >= 0 && sample.readyState <= 4
      && sample.error === null, `${context}: media failed during playback`);
    if (!sampleFallsInsideRecovery(sample, recoveries)) {
      assert.ok(sample.readyState >= 2, `${context}: media was unreadable outside a recovered wait`);
    }
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during playback`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: transient refusal during playback`);
    const expected = expectedAnimationCueAt(sample.mediaTime);
    assert.ok(expected !== null, (
      `${context}: witness sampled outside the authored cue window at ${sample.mediaTime}s`
    ));
    const active = activeAnimationCueAt(sample.mediaTime);
    assert.equal(active?.phase, expected.phase, `${context}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${context}: product and authored cue progress disagree`
    ));
    if (index > 0) {
      assert.ok(sample.atMs > samples[index - 1].atMs, `${context}: rAF clock did not advance`);
      assert.ok(sample.mediaTime + 0.002 >= samples[index - 1].mediaTime, `${context}: media moved backwards`);
      assert.ok(sample.revision >= samples[index - 1].revision, `${context}: compositor revision moved backwards`);
    }
  }
  assert.ok(samples.at(-1).mediaTime - samples[0].mediaTime >= 13.7, `${context}: playback skipped the cue`);
  assert.ok(samples.at(-1).revision - samples[0].revision >= 20, `${context}: compositor froze across the cue`);
  assert.ok(longestPlateauMs(samples, sample => sample.mediaTime) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: media plateaued`
  ));
  assert.ok(longestPlateauMs(samples, sample => sample.revision) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: compositor plateaued`
  ));
  return Object.freeze({
    ...assertVisualContinuity(samples, context, animation.easing, animation.type),
    waitingRecoveries: recoveries,
  });
};

const assertTemporalTransition = (transition, context) => {
  assert.ok(transition?.pixels?.changedPixels >= 64, `${context}: temporal pixels were reused`);
  assert.ok(transition.pixels.changedRatio >= 0.000_1, `${context}: temporal pixel delta is negligible`);
  assert.ok(transition.pixels.maximumChannelDelta >= 16, `${context}: temporal contrast is negligible`);
  assert.ok(transition.ssim < 0.999_99, `${context}: temporal frames are visually identical`);
};

const geometryFingerprint = proof => JSON.stringify([
  Number(proof.subtitleGeometry.centroidXRatio.toFixed(5)),
  Number(proof.subtitleGeometry.centroidYRatio.toFixed(5)),
  proof.subtitleGeometry.changedPixels,
  proof.subtitleGeometry.bounds.x,
  proof.subtitleGeometry.bounds.y,
  proof.subtitleGeometry.bounds.width,
  proof.subtitleGeometry.bounds.height,
  proof.subtitleGeometry.bounds.areaPixels,
  Number(proof.subtitleGeometry.meanChangedChannelDelta.toFixed(3)),
]);

const spatialFingerprint = proof => JSON.stringify([
  Number(proof.subtitleGeometry.centroidXRatio.toFixed(5)),
  Number(proof.subtitleGeometry.centroidYRatio.toFixed(5)),
  proof.subtitleGeometry.bounds.x,
  proof.subtitleGeometry.bounds.y,
  proof.subtitleGeometry.bounds.width,
  proof.subtitleGeometry.bounds.height,
]);

const assertPhaseFrames = ({ animation, frameProofs, phaseTransitions }) => {
  const hashes = ANIMATION_PHASES.map(phase => frameProofs[phase.name].composed.frame.sha256);
  assert.equal(new Set(hashes).size, hashes.length, `${animation.id}: entry/mid/exit reused a frame`);
  assertTemporalTransition(phaseTransitions?.entryToSteady, `${animation.id}: entry→steady`);
  assertTemporalTransition(phaseTransitions?.steadyToExit, `${animation.id}: steady→exit`);
  assertTemporalTransition(phaseTransitions?.entryToExit, `${animation.id}: entry→exit`);
  const fingerprints = ANIMATION_PHASES.map(phase => geometryFingerprint(frameProofs[phase.name]));
  assert.equal(new Set(fingerprints).size, fingerprints.length, (
    `${animation.id}: animation produced constant subtitle geometry/energy across entry, mid and exit`
  ));

  for (const phase of ANIMATION_PHASES) {
    const proof = frameProofs[phase.name];
    assert.ok(Math.abs(proof.mediaTime - phase.seconds) <= 0.06, (
      `${animation.id}: ${phase.name} capture missed reviewed time ${phase.seconds}`
    ));
    const expected = expectedAnimationCueAt(proof.mediaTime);
    assert.equal(expected?.phase, phase.expectedPhase, (
      `${animation.id}: ${phase.name} capture is ${expected?.phase ?? 'inactive'} under authored cue maths`
    ));
    assert.ok(Math.abs(expected.progress - phase.expectedProgress) <= 0.06, (
      `${animation.id}: ${phase.name} progress ${expected.progress} missed ${phase.expectedProgress}`
    ));
    const active = activeAnimationCueAt(proof.mediaTime);
    assert.equal(active?.phase, expected.phase, `${animation.id}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${animation.id}: product and authored cue progress disagree`
    ));
  }
};

/**
 * Prove a font-bearing preset rebuild never publishes an incomplete visible composition.
 *
 * `transition` is captured synchronously before the public click. Samples before the first overlay
 * rebuild are therefore the old, complete pixels retained while the new atlas is pending; samples
 * whose revision advances are the browser-visible publications made during and after the rebuild.
 */
export const verifyLiveFontPresetTransition = ({
  samples,
  publications,
  mediaEvents,
  transientTransitions,
  transition,
  beforePreset,
  afterPreset,
  beforeFontFamily,
  afterFontFamily,
}) => {
  const context = `${beforePreset}→${afterPreset} live font/preset transition`;
  assert.ok(Array.isArray(samples) && samples.length >= 6, `${context}: pixel witness is too sparse`);
  assert.ok(Array.isArray(publications), `${context}: publication ledger is absent`);
  assert.ok(Array.isArray(transientTransitions), `${context}: state-transition ledger is absent`);
  assert.equal(typeof beforePreset, 'string', `${context}: prior preset is absent`);
  assert.equal(typeof afterPreset, 'string', `${context}: selected preset is absent`);
  assert.notEqual(afterPreset, beforePreset, `${context}: preset did not change`);
  assert.equal(typeof beforeFontFamily, 'string', `${context}: prior font family is absent`);
  assert.equal(typeof afterFontFamily, 'string', `${context}: selected font family is absent`);
  assert.notEqual(afterFontFamily, beforeFontFamily, `${context}: preset did not exercise a font change`);
  assert.ok(transition !== null && typeof transition === 'object', `${context}: marker is absent`);
  assert.ok(Number.isFinite(transition.atMs) && transition.atMs >= 0, `${context}: marker clock is invalid`);
  assert.ok(Number.isSafeInteger(transition.revision) && transition.revision > 0, (
    `${context}: marker revision is invalid`
  ));
  assert.ok(Number.isSafeInteger(transition.overlayRebuilds) && transition.overlayRebuilds > 0, (
    `${context}: marker overlay revision is invalid`
  ));
  assertCompleteVisibleSample({
    atMs: transition.atMs,
    mediaTime: transition.mediaTime,
    revision: transition.revision,
    overlayRebuilds: transition.overlayRebuilds,
    visual: transition.visual,
  }, `${context}: complete pre-change pixels`);

  const recoveries = assertRecoveredMediaEvents(mediaEvents, context);
  const foreignTransitions = transientTransitions.filter(({ attribute }) => (
    attribute !== 'data-osg-preview'
  ));
  assert.deepEqual(foreignTransitions, [], `${context}: cue or refusal code changed during rebuild`);
  const statusTransitions = transientTransitions.filter(({ attribute }) => (
    attribute === 'data-osg-preview'
  ));
  assert.equal(statusTransitions.length % 2, 0, `${context}: preview pending state never recovered`);
  for (let index = 0; index < statusTransitions.length; index += 2) {
    const pending = statusTransitions[index];
    const recovered = statusTransitions[index + 1];
    assert.deepEqual(
      [pending.previous, pending.current, recovered.previous, recovered.current],
      ['ready', 'pending', 'pending', 'ready'],
      `${context}: preview state left the atomic ready/pending contract`,
    );
    assert.ok(
      recovered.atMs >= pending.atMs
        && recovered.atMs - pending.atMs <= MAXIMUM_CONTINUITY_PLATEAU_MS,
      `${context}: preview pending state exceeded the continuity bound`,
    );
  }
  const duringTransition = samples.filter(sample => sample.atMs >= transition.atMs);
  assert.ok(duringTransition.length >= 3, `${context}: rebuild was not observed over animation frames`);
  const rebuiltAt = duringTransition.findIndex(sample => (
    sample.overlayRebuilds > transition.overlayRebuilds
  ));
  assert.ok(rebuiltAt >= 0, `${context}: selected preset never published a rebuilt overlay`);
  const pending = duringTransition.slice(0, rebuiltAt);
  for (const sample of pending) {
    assert.equal(sample.overlayRebuilds, transition.overlayRebuilds, (
      `${context}: pending sample crossed the overlay boundary`
    ));
    assertCompleteVisibleSample(sample, `${context}: prior pixels during pending`);
  }

  for (const sample of duringTransition) {
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during rebuild`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: preview refusal during rebuild`);
  }
  const published = publications.filter(frame => (
    frame.atMs >= transition.atMs && frame.revision > transition.revision
  ));
  assert.ok(published.length >= 2, `${context}: too few new visible frames were published`);
  for (const [index, frame] of published.entries()) {
    assert.ok(Number.isSafeInteger(frame.revision) && frame.revision > transition.revision, (
      `${context}: publication ${index} has an invalid frame revision`
    ));
    if (index > 0) {
      assert.ok(frame.revision > published[index - 1].revision, (
        `${context}: frame publication revisions did not increase`
      ));
    }
    assert.deepEqual(frame.visibleErrors, [], `${context}: visible error reached a publication`);
    assert.deepEqual(frame.recordedRefusals, [], `${context}: preview refusal reached a publication`);
    assertCompleteVisibleSample(frame, `${context}: newly published frame`);
  }
  assert.ok(published.some(sample => sample.overlayRebuilds > transition.overlayRebuilds), (
    `${context}: new font pixels were never published`
  ));
  assert.ok(longestPlateauMs(
    duringTransition,
    sample => sample.mediaTime,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, `${context}: media plateaued`);
  assert.ok(longestPlateauMs(
    duringTransition,
    sample => sample.revision,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, `${context}: compositor plateaued`);

  return Object.freeze({
    beforePreset,
    afterPreset,
    beforeFontFamily,
    afterFontFamily,
    pendingSamples: pending.length + 1,
    publishedFrames: published.length,
    overlayRebuilds: duringTransition.at(-1).overlayRebuilds - transition.overlayRebuilds,
    waitingRecoveries: recoveries,
    pendingStatusCycles: statusTransitions.length / 2,
  });
};

export const verifyAnimationObservation = ({
  animation,
  beforeRevision,
  expectedProjectId,
  expectedTypeCustomization,
  expectedFinalCustomization,
  typeScene,
  easingScene,
  continuitySamples,
  samplesByPhase,
  frameProofs,
  phaseTransitions,
  entryChange,
  transientTransitions,
  mediaEvents,
}) => {
  assert.ok(ANIMATION_CASES.includes(animation), 'animation case is outside the frozen sweep');
  if (animation.editType) {
    assert.ok(typeScene?.sceneRevision > beforeRevision, `${animation.id}: type scene did not advance`);
  } else {
    assert.equal(typeScene?.sceneRevision, beforeRevision, `${animation.id}: unchanged type created a revision`);
  }
  assertSceneAuthority(typeScene, expectedProjectId, `${animation.id}: type scene`);
  assertCompleteCustomization(
    typeScene?.scene?.customization,
    expectedTypeCustomization,
    `${animation.id}: type scene`,
  );

  const entry = frameProofs.entry.subtitleGeometry;
  const steady = frameProofs.steady.subtitleGeometry;
  const exit = frameProofs.exit.subtitleGeometry;
  const minimumShift = 0.001;
  // The measurable slide displacement at each sampled instant is `1 - eased(progress)` of the
  // full offset. A decisive factor demands its direction; a factor the easing has already driven
  // to ≈0 at the sample instant demands nearness to the holding position instead; an overshoot
  // factor (negative) demands the opposite direction. Sample progress values mirror
  // ANIMATION_PHASES (entry 0.4, exit 0.6).
  const DECISIVE_SLIDE_FACTOR = 0.15;
  const NEAR_HOLD_RATIO = 0.02;
  const slidePhaseClaim = ({ phase, sign, sample, steadyRatio, awayLabel, towardLabel }) => {
    const phaseProgress = phase === 'entry' ? 0.4 : 0.6;
    const factor = 1 - sweepEasedProgress(animation.easing, phaseProgress);
    const shift = sample - steadyRatio;
    if (factor >= DECISIVE_SLIDE_FACTOR) {
      assert.ok(sign * shift > minimumShift, (
        `${animation.id}: ${animation.type} ${phase} did not ${awayLabel}`
      ));
      return;
    }
    if (factor <= -DECISIVE_SLIDE_FACTOR) {
      assert.ok(sign * shift < -minimumShift, (
        `${animation.id}: ${animation.type} ${phase} did not overshoot ${towardLabel}`
      ));
      return;
    }
    assert.ok(Math.abs(shift) <= NEAR_HOLD_RATIO, (
      `${animation.id}: ${animation.type} ${phase} strayed from holding at a near-zero eased offset (factor ${factor.toFixed(4)}, shift ${shift.toFixed(4)})`
    ));
  };
  const SLIDE_AXES = {
    'slide-up': { axis: 'y', entrySign: 1, exitSign: -1, entryAway: 'start below its holding position', exitAway: 'leave above its holding position' },
    'slide-down': { axis: 'y', entrySign: -1, exitSign: 1, entryAway: 'start above its holding position', exitAway: 'leave below its holding position' },
    'slide-left': { axis: 'x', entrySign: 1, exitSign: -1, entryAway: 'start to the right', exitAway: 'leave to the left' },
    'slide-right': { axis: 'x', entrySign: -1, exitSign: 1, entryAway: 'start to the left', exitAway: 'leave to the right' },
  };
  if (SLIDE_AXES[animation.type] !== undefined) {
    const spec = SLIDE_AXES[animation.type];
    const read = geometry => (spec.axis === 'y' ? geometry.centroidYRatio : geometry.centroidXRatio);
    slidePhaseClaim({
      phase: 'entry',
      sign: spec.entrySign,
      sample: read(entry),
      steadyRatio: read(steady),
      awayLabel: spec.entryAway,
      towardLabel: 'past its holding position',
    });
    slidePhaseClaim({
      phase: 'exit',
      sign: spec.exitSign,
      sample: read(exit),
      steadyRatio: read(steady),
      awayLabel: spec.exitAway,
      towardLabel: 'past its holding position',
    });
  } else if (animation.type === 'scale') {
    assert.ok(entry.bounds.areaPixels < steady.bounds.areaPixels * 0.98, (
      `${animation.id}: scale entry did not occupy a smaller area`
    ));
    assert.ok(exit.bounds.areaPixels < steady.bounds.areaPixels * 0.98, (
      `${animation.id}: scale exit did not occupy a smaller area`
    ));
  } else if (animation.type === 'bounce') {
    assert.ok(Math.abs(entry.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: bounce entry kept a constant area`
    ));
  } else if (animation.type === 'flip') {
    assert.ok(entry.bounds.width < steady.bounds.width * 0.98, (
      `${animation.id}: flip entry kept the holding width`
    ));
    assert.ok(exit.bounds.width < steady.bounds.width * 0.98, (
      `${animation.id}: flip exit kept the holding width`
    ));
  } else if (animation.type === 'rotate') {
    assert.ok(Math.abs(entry.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: rotate entry kept a constant area`
    ));
    assert.ok(Math.abs(exit.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: rotate exit kept a constant area`
    ));
  } else if (animation.type === 'typewriter') {
    assert.ok(entry.changedPixels < steady.changedPixels * 0.95, (
      `${animation.id}: typewriter entry revealed the complete cue`
    ));
  } else if (animation.type === 'fade') {
    assert.ok(entry.meanChangedChannelDelta < exit.meanChangedChannelDelta, (
      `${animation.id}: fade entry did not carry less energy than exit`
    ));
    assert.ok(exit.meanChangedChannelDelta < steady.meanChangedChannelDelta, (
      `${animation.id}: fade exit did not carry less energy than holding`
    ));
  }
  if (animation.editEasing) {
    assert.ok(easingScene?.sceneRevision > typeScene.sceneRevision, `${animation.id}: easing scene did not advance`);
  } else {
    assert.equal(easingScene?.sceneRevision, typeScene.sceneRevision, `${animation.id}: unchanged easing created a revision`);
  }
  assertSceneAuthority(easingScene, expectedProjectId, `${animation.id}: final scene`);
  assertCompleteCustomization(
    easingScene?.scene?.customization,
    expectedFinalCustomization,
    `${animation.id}: final scene`,
  );
  const visualSummary = assertPlaybackContinuity(
    continuitySamples,
    mediaEvents,
    animation,
  );
  assert.deepEqual(transientTransitions, [], (
    `${animation.type}/${animation.easing}: preview/cue blinked between animation-frame samples`
  ));
  for (const phase of ANIMATION_PHASES) {
    assertTemporalPhase(samplesByPhase?.[phase.name], phase, `${animation.type}/${animation.easing}`);
    assertFrameProof(frameProofs?.[phase.name], `${animation.type}/${phase.name}`);
  }
  assertPhaseFrames({ animation, frameProofs, phaseTransitions });
  if (animation.index > 0) {
    assert.ok(entryChange?.pixels?.changedPixels >= 64, `${animation.type}: entry pixels equal the previous animation`);
    assert.ok(entryChange.pixels.changedRatio >= 0.000_1, `${animation.type}: entry delta is negligible`);
  }
  return Object.freeze({
    id: animation.id,
    type: animation.type,
    easing: animation.easing,
    sweep: animation.sweep,
    typeSceneRevision: typeScene.sceneRevision,
    easingSceneRevision: easingScene.sceneRevision,
    finalSceneRevision: easingScene.sceneRevision,
    phaseSamples: Object.freeze(Object.fromEntries(
      ANIMATION_PHASES.map(phase => [phase.name, samplesByPhase[phase.name].length]),
    )),
    sourceDeltas: Object.freeze(Object.fromEntries(
      ANIMATION_PHASES.map(phase => [phase.name, frameProofs[phase.name].subtitlePixels.changedPixels]),
    )),
    visualSummary,
    entryChangedPixels: entryChange?.pixels?.changedPixels ?? null,
    easingFingerprint: ANIMATION_PHASES
      .filter(phase => phase.name !== 'steady')
      .map(phase => geometryFingerprint(frameProofs[phase.name])).join('|'),
    easingSpatialFingerprint: ANIMATION_PHASES
      .filter(phase => phase.name !== 'steady')
      .map(phase => spatialFingerprint(frameProofs[phase.name])).join('|'),
  });
};

export const verifyAnimationCoverage = observations => {
  assert.ok(Array.isArray(observations), 'animation observations must be an array');
  assert.deepEqual(observations.map(item => item.id), ANIMATION_CASES.map(item => item.id), (
    'the bounded animation/easing sweep is incomplete'
  ));
  assert.deepEqual(
    [...new Set(observations.map(item => item.easing))].sort(),
    [...new Set(ANIMATION_CASES.map(item => item.easing))].sort(),
    'the seven easing functions are not covered',
  );
  for (let index = 1; index < observations.length; index += 1) {
    assert.ok(observations[index].finalSceneRevision > observations[index - 1].finalSceneRevision, (
      `animation scene revision did not increase at ${observations[index].type}`
    ));
  }
  const anchors = observations.filter(item => item.sweep === 'easing-anchor');
  assert.equal(anchors.length, ANIMATION_EASING_VALUES.length, 'the fixed-type easing sweep is incomplete');
  assert.equal(new Set(anchors.map(item => item.type)).size, 1, 'easing sweep changed animation type');
  assert.equal(new Set(anchors.map(item => item.easingFingerprint)).size, anchors.length, (
    'one or more easings produced constant/indistinguishable anchor geometry'
  ));
  assert.equal(new Set(anchors.map(item => item.easingSpatialFingerprint)).size, anchors.length, (
    'one or more easings ignored the anchor transform position'
  ));
  return Object.freeze({
    cases: observations.length,
    types: new Set(observations.map(item => item.type)).size,
    easings: new Set(observations.map(item => item.easing)).size,
  });
};
