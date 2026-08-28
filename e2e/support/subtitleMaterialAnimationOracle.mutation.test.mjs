import { strict as assert } from 'node:assert';
import test from 'node:test';

import { easeSubtitle } from '../../src/components/previews/canvas/canvasSubtitleMath.js';
import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_PHASES,
  activeAnimationCueAt,
  sweepEasedProgress,
  verifyAnimationObservation,
} from './subtitleMaterialAnimationOracle.js';

/**
 * Adversarial mutation suite for subtitleMaterialAnimationOracle.js (the material/animation twin of
 * exportAnimationParityOracle.mutation.test.mjs -- see that file's header for the shared method: real
 * mutations of realistic fixtures, asserted against the CALIBRATED thresholds, with any accepted
 * mutation recorded as a `test.todo` hole plus a HOLES entry naming the exact check/threshold/margin.
 *
 * This oracle has a single render surface (the preview canvas), unlike exportAnimationParityOracle's
 * three (Main/Render/Export), so defect class 7 ("missing one surface's ink while the other two
 * agree") has no direct three-way analogue here; the closest equivalent -- composed-vs-source
 * disagreement -- is exercised as part of defect class 2 below, and noted in the final report.
 */

const HOLES = [];
const recordHole = (id, detail) => { HOLES.push({ id, ...detail }); };

const PROJECT_ID = 'project-a';
const clone = value => JSON.parse(JSON.stringify(value));

const completeCustomization = (overrides = {}) => ({
  preset: 'custom',
  fontSize: 53,
  animationType: 'slide-up',
  animationEasing: 'linear',
  ...Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`field${index}`, index])),
  ...overrides,
});

// POSITION follows ANIMATION_PHASES' own array order (entry, steady, exit) -- a slide-up entry must
// sit BELOW (larger Y) its holding position and a slide-up exit must sit ABOVE (smaller Y), so a
// monotonically-decreasing formula across [entry, steady, exit] naturally satisfies both directions
// at once, exactly like the sibling test file's fixture does.
const POSITION_ORDINAL = { entry: 0, steady: 1, exit: 2 };
// ENERGY needs its OWN independent ordering: fade-type cases require entry < exit < steady (holding
// carries the most ink), which is a different relative order than POSITION's.
const PHASE_ENERGY = { entry: 50, exit: 70, steady: 90 };
const PHASE_PIXEL_ORDINAL = { entry: 0, exit: 1, steady: 2 };

const geometry = (phaseName, overrides = {}) => {
  const ordinal = POSITION_ORDINAL[phaseName];
  return {
    width: 640,
    height: 480,
    changedPixels: 2_048 + (PHASE_PIXEL_ORDINAL[phaseName] * 97),
    centroidXRatio: 0.45 + (ordinal * 0.01),
    centroidYRatio: 0.4 - (ordinal * 0.01),
    bounds: {
      x: 100 + (ordinal * 7), y: 80 - (ordinal * 9), width: 180 + ordinal, height: 70 + ordinal,
      areaPixels: 4_096 + (ordinal * 211),
    },
    meanChangedChannelDelta: PHASE_ENERGY[phaseName],
    ...overrides,
  };
};

const frameProof = (phase, overrides = {}) => ({
  mediaTime: phase.seconds,
  composed: { frame: { sha256: `composed-${phase.name}` } },
  composedSignal: { totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.2, meanLuma: 90 },
  sourceSignal: { totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.25, meanLuma: 82 },
  subtitlePixels: {
    changedPixels: 2_048 + (PHASE_PIXEL_ORDINAL[phase.name] * 97),
    changedRatio: (2_048 + (PHASE_PIXEL_ORDINAL[phase.name] * 97)) / 307_200,
    maximumChannelDelta: 220,
  },
  subtitleGeometry: geometry(phase.name),
  ...overrides,
});

const changedFrame = () => ({
  ssim: 0.98, pixels: { changedPixels: 512, changedRatio: 0.01, maximumChannelDelta: 200 },
});

const phaseSamples = phase => Array.from({ length: 10 }, (_, index) => ({
  atMs: index * 50,
  mediaTime: (phase.minimum + 0.02) + (index * ((phase.maximum - phase.minimum - 0.04) / 9)),
  revision: 100 + index, overlayRebuilds: 8, cue: '0', preview: 'ready', previewCode: null,
  paused: false, ended: false, readyState: 4, error: null, visibleErrors: [], recordedRefusals: [],
}));

// Ink-owed state must follow the REAL easing math (the same evaluator `assertVisualContinuity`
// itself uses), or a genuinely correct fixture for a non-trivial easing (e.g. the overshoot bezier,
// which has a real negative/zero-opacity window) is rejected by construction, not by a mutation.
const inkOwedAt = (mediaTime, easing) => {
  const active = activeAnimationCueAt(mediaTime);
  return active === null || easeSubtitle(active.progress, easing) > 0;
};

const continuitySamples = (easing = 'linear') => Array.from({ length: 360 }, (_, index) => {
  const mediaTime = ANIMATION_CUE.witnessStart
    + (index * ((ANIMATION_CUE.witnessEnd - ANIMATION_CUE.witnessStart) / 359));
  const inked = inkOwedAt(mediaTime, easing);
  return {
    atMs: index * 50, mediaTime, revision: 200 + index, overlayRebuilds: 8, cue: '0',
    preview: 'ready', previewCode: null, paused: false, ended: false, readyState: 4, error: null,
    visibleErrors: [], recordedRefusals: [],
    visual: {
      mode: 'tainted-operation-trace', classified: true, publication: index + 1, method: 'drawImage',
      hasVideo: true, hasOverlay: inked, hasGlyphInk: inked, visible: true, blank: false,
      transparent: false, black: false, sourceOnly: !inked, sourceTime: mediaTime, pixelHash: null,
    },
  };
});

const baseline = (animation = ANIMATION_CASES[0]) => {
  const expectedTypeCustomization = completeCustomization({
    animationType: animation.type,
    animationEasing: animation.editEasing ? 'prior-easing' : animation.easing,
  });
  const expectedFinalCustomization = completeCustomization({
    animationType: animation.type, animationEasing: animation.easing,
  });
  return {
    animation,
    beforeRevision: 10,
    expectedProjectId: PROJECT_ID,
    expectedTypeCustomization,
    expectedFinalCustomization,
    typeScene: {
      projectId: PROJECT_ID, sceneRevision: animation.editType ? 11 : 10, schemaVersion: 1,
      scene: { customization: clone(expectedTypeCustomization) },
    },
    easingScene: {
      projectId: PROJECT_ID,
      sceneRevision: animation.editEasing ? (animation.editType ? 12 : 11) : 11,
      schemaVersion: 1,
      scene: { customization: clone(expectedFinalCustomization) },
    },
    continuitySamples: continuitySamples(animation.easing),
    samplesByPhase: Object.fromEntries(ANIMATION_PHASES.map(phase => [phase.name, phaseSamples(phase)])),
    frameProofs: Object.fromEntries(ANIMATION_PHASES.map(phase => [
      phase.name, frameProof(phase),
    ])),
    phaseTransitions: {
      entryToSteady: changedFrame(), steadyToExit: changedFrame(), entryToExit: changedFrame(),
    },
    entryChange: changedFrame(),
    transientTransitions: [],
    mediaEvents: [],
  };
};

const slideUp = ANIMATION_CASES.find(item => item.type === 'slide-up' && item.easing === 'linear');
const overshoot = ANIMATION_CASES.find(item => item.easing === 'cubic-bezier(0.68, -0.55, 0.265, 1.55)');
const fade = ANIMATION_CASES.find(item => item.type === 'fade');
// 'ease-out' entry (progress 0.4) evaluates to sweepEasedProgress ~0.571 -- above
// MIN_INK_ENERGY_EASED_GATE (0.5), unlike linear's 0.4, so assertInkEnergyMagnitude actually runs on
// this ENTRY sample. slide-up/linear's own entry sits just under the gate by construction (see the
// defect-5 test below for the measured before/after).
const slideUpEaseOut = ANIMATION_CASES.find(item => item.type === 'slide-up' && item.easing === 'ease-out');

test('sanity: the untouched baseline passes for slide-up, fade and the overshoot anchor', () => {
  verifyAnimationObservation(baseline(slideUp));
  verifyAnimationObservation(baseline(fade));
  verifyAnimationObservation(baseline(overshoot));
});

// =================================================================================================
// 1. Blank output (no ink at all).
// =================================================================================================

test('defect 1: a blank continuity sample at a decisive instant is rejected', () => {
  const input = baseline(slideUp);
  input.continuitySamples[160].visual = {
    ...input.continuitySamples[160].visual,
    hasVideo: false, hasOverlay: false, hasGlyphInk: false, visible: false, blank: true, black: true,
  };
  assert.throws(() => verifyAnimationObservation(input), /blank frame reached the visible canvas/u);
});

// =================================================================================================
// 2. Source-only output (video pixels, zero subtitle ink).
// =================================================================================================

test('defect 2a: a source-only continuity sample at a decisive (non-boundary) instant is rejected', () => {
  const input = baseline(slideUp);
  // Sample 200 sits well inside the holding window (mediaTime ~ ANIMATION_CUE middle) -- ink is
  // unconditionally owed there for every easing, so this is not near any zero-crossing tolerance.
  const sample = input.continuitySamples[200];
  assert.ok(sample.mediaTime > ANIMATION_CUE.start + 1 && sample.mediaTime < ANIMATION_CUE.end - 1);
  sample.visual = { ...sample.visual, hasOverlay: false, hasGlyphInk: false, sourceOnly: true };
  assert.throws(() => verifyAnimationObservation(input), /source-only frame reached the visible canvas/u);
});

test('defect 2b: a phase capture whose composed frame never differs from source is rejected', () => {
  const input = baseline(slideUp);
  input.frameProofs.steady.subtitlePixels = { changedPixels: 0, changedRatio: 0, maximumChannelDelta: 0 };
  assert.throws(() => verifyAnimationObservation(input), /composed frame is source-only/u);
});

// =================================================================================================
// 3. Wrong placement: slide-phase centroid displaced the wrong way, at both the decisive (>=0.15)
//    and near-hold (<=0.02) calibrated bands.
// =================================================================================================

test('defect 3a: a linear-easing slide-up entry that stays at the holding position (no upward '
  + 'displacement at all) is rejected -- decisive band, factor well above 0.15', () => {
  const input = baseline(slideUp);
  // Force entry centroid to equal steady's: for slide-up, a correct entry must sit measurably BELOW
  // (higher Y ratio) the holding position; identical Y means "did not start below its holding position".
  input.frameProofs.entry.subtitleGeometry = {
    ...input.frameProofs.entry.subtitleGeometry,
    centroidYRatio: input.frameProofs.steady.subtitleGeometry.centroidYRatio,
  };
  assert.throws(() => verifyAnimationObservation(input), /slide-up entry did not start below its holding position/u);
});

test('defect 3b: a linear-easing slide-up entry displaced the WRONG direction is rejected', () => {
  const input = baseline(slideUp);
  const steadyY = input.frameProofs.steady.subtitleGeometry.centroidYRatio;
  // Correct entry must have a LARGER Y ratio (lower on screen = "below") than steady; place it
  // ABOVE steady instead (smaller ratio) -- the wrong side of the same axis.
  input.frameProofs.entry.subtitleGeometry = {
    ...input.frameProofs.entry.subtitleGeometry, centroidYRatio: steadyY - 0.05,
  };
  assert.throws(() => verifyAnimationObservation(input), /slide-up entry did not start below its holding position/u);
});

// sweepEasedProgress('cubic-bezier(0.68, -0.55, 0.265, 1.55)', 0.4) [entry] = 0.143 -> factor 0.857
// (DECISIVE branch, exercised by 3a/3b via the linear-easing anchor already). Its EXIT sample at
// progress 0.6 evaluates to 0.948 -> factor 0.052, which IS inside the |factor|<0.15 near-hold band
// -- so the near-hold assertions below target the EXIT phase, verified against the real evaluator
// rather than assumed.

test('defect 3c: near-hold band (overshoot bezier EXIT sample, |factor|=0.052 < 0.15) -- a '
  + 'displacement just OVER the 0.02 ratio tolerance is rejected, confirming the calibrated boundary '
  + 'is not vacuous', () => {
  const input = baseline(overshoot);
  const steadyY = input.frameProofs.steady.subtitleGeometry.centroidYRatio;
  input.frameProofs.exit.subtitleGeometry = {
    ...input.frameProofs.exit.subtitleGeometry, centroidYRatio: steadyY + 0.03,
  };
  assert.throws(() => verifyAnimationObservation(input), /strayed from holding at a near-zero eased offset/u);
});

test('defect 3d [sound-with-margin]: the SAME near-hold band accepts a sub-tolerance (0.018) stray '
  + '-- documents how much positional slack ±0.02 actually grants, not a rejected mutation', () => {
  const input = baseline(overshoot);
  const steadyY = input.frameProofs.steady.subtitleGeometry.centroidYRatio;
  input.frameProofs.exit.subtitleGeometry = {
    ...input.frameProofs.exit.subtitleGeometry, centroidYRatio: steadyY + 0.018,
  };
  verifyAnimationObservation(input); // must NOT throw -- this is by-design slack, not a hole
  recordHole('material-near-hold-tolerance-characterization', {
    defectClass: 'wrong placement (sub-threshold, informational -- not scored as a hole)',
    oracleFile: 'subtitleMaterialAnimationOracle.js',
    finding: 'The ±0.02 NEAR_HOLD_RATIO band (used whenever |1-eased(progress)| < DECISIVE_SLIDE_FACTOR '
      + '0.15, e.g. the overshoot-bezier anchor at its reviewed entry/exit sample progress) tolerates a '
      + 'centroid displacement of up to 2% of the frame dimension in EITHER direction from holding '
      + 'before rejecting. On a 480px-tall composition that is ~9.6px of slack. This is a deliberate, '
      + 'documented calibration (see the source comment on slidePhaseClaim), not a hole -- recorded '
      + 'here only so the exact magnitude is visible next to the export oracle\'s pixel-based floors.',
    severity: 'INFO',
  });
});

// =================================================================================================
// 4. Wrong frame: a captured phase is really a different instant (reused bytes / constant geometry).
// =================================================================================================

test('defect 4a: entry and exit phase captures sharing one sha256 (wrong/reused frame) are rejected', () => {
  const input = baseline(slideUp);
  input.frameProofs.exit.composed.frame.sha256 = input.frameProofs.entry.composed.frame.sha256;
  assert.throws(() => verifyAnimationObservation(input), /reused a frame/u);
});

test('defect 4b: entry/steady/exit sharing constant subtitle geometry (all three the same instant) '
  + 'is rejected', () => {
  const input = baseline(slideUp);
  for (const phase of ['steady', 'exit']) {
    input.frameProofs[phase].subtitleGeometry = clone(input.frameProofs.entry.subtitleGeometry);
    input.frameProofs[phase].subtitlePixels.changedPixels = input.frameProofs.entry.subtitlePixels.changedPixels;
  }
  assert.throws(
    () => verifyAnimationObservation(input),
    /constant subtitle geometry|slide-up entry did not start below/u,
  );
});

test('defect 4c: a phase capture whose mediaTime misses its reviewed instant is rejected', () => {
  const input = baseline(slideUp);
  input.frameProofs.entry.mediaTime = ANIMATION_PHASES[0].seconds + 5; // five seconds off -- a different scene entirely
  assert.throws(() => verifyAnimationObservation(input), /missed reviewed time/u);
});

// =================================================================================================
// 5. Wrong alpha: ink at roughly half or double the expected eased opacity.
// =================================================================================================
//
// `assertCompleteVisibleSample` only ever checked BOOLEAN ink presence (hasOverlay/hasGlyphInk/
// sourceOnly) on the continuity witness, never a continuous opacity value, and the only MAGNITUDE
// comparison was the fade-type phase-ordering check (entry<exit<steady), gated on
// animation.type === 'fade'. This was a real hole for every other animation type (slide/scale/
// bounce/flip/rotate/typewriter -- the entire 7-easing anchor sweep plus 8 of the 10 animation-type
// cases): a render at roughly half or double the eased opacity a case actually calls for, with
// position and boolean ink flags left correct, passed every assertion in the file.
//
// `assertInkEnergyMagnitude` closes this: it compares each entry/exit sample's measured
// meanChangedChannelDelta against `steadyEnergy * sweepEasedProgress(easing, expectedProgress)`,
// gated to samples where that eased fraction is >= 0.5 (below that, the boolean ink-owed check
// already owns the claim, and a ratio against a near-zero expectation would be noise).

test('defect 5 [FIXED]: halving frameProofs ink ENERGY on a non-fade (slide-up) sample, with '
  + 'position and boolean ink-presence left correct, is now rejected once the sample is decisively '
  + 'inked (eased >= 0.5)', () => {
  assert.ok(slideUpEaseOut, "an 'ease-out' slide-up anchor must exist in the sweep");
  const entryEased = sweepEasedProgress(slideUpEaseOut.easing, ANIMATION_PHASES[0].expectedProgress);
  assert.ok(entryEased >= 0.5, (
    `documents why 'ease-out' (not 'linear') is used here: its entry eased fraction `
    + `${entryEased.toFixed(3)} clears the 0.5 magnitude-check gate`
  ));

  const input = baseline(slideUpEaseOut);
  const correctEntry = input.frameProofs.entry;
  const halvedEntry = {
    ...correctEntry,
    subtitlePixels: {
      changedPixels: Math.round(correctEntry.subtitlePixels.changedPixels / 2),
      changedRatio: correctEntry.subtitlePixels.changedRatio / 2,
      maximumChannelDelta: correctEntry.subtitlePixels.maximumChannelDelta, // peak delta unaffected by average alpha
    },
    subtitleGeometry: {
      ...correctEntry.subtitleGeometry,
      changedPixels: Math.round(correctEntry.subtitleGeometry.changedPixels / 2),
      meanChangedChannelDelta: correctEntry.subtitleGeometry.meanChangedChannelDelta / 2, // this IS the alpha proxy
      bounds: {
        ...correctEntry.subtitleGeometry.bounds,
        areaPixels: correctEntry.subtitleGeometry.changedPixels, // still self-consistent with real changedPixels above
      },
    },
  };
  // Both variants clear every absolute floor in assertFrameProof (>=64 px, >=0.0001 ratio, >=32
  // maxChannelDelta) -- halving a healthy signal does not approach those floors, so this is really
  // exercising the NEW relative-magnitude check, not an old absolute one.
  assert.ok(halvedEntry.subtitlePixels.changedPixels >= 64);
  assert.ok(halvedEntry.subtitlePixels.changedRatio >= 0.000_1);
  assert.ok(halvedEntry.subtitlePixels.maximumChannelDelta >= 32);

  input.frameProofs.entry = halvedEntry;
  assert.throws(
    () => verifyAnimationObservation(input),
    /ink energy .* is .*x the eased expectation/u,
    'the new ink-energy-magnitude check must reject the halved entry sample',
  );
});

test('defect 5 [scope, informational]: the SAME halving on slide-up/LINEAR entry (progress 0.4, '
  + 'eased 0.4 -- just under the 0.5 gate) is still accepted -- this is the deliberate scope '
  + 'boundary the fix above documents, not a residual hole: the boolean ink-owed check in '
  + 'assertVisualContinuity already covers samples this faint', () => {
  const entryEased = sweepEasedProgress(slideUp.easing, ANIMATION_PHASES[0].expectedProgress);
  assert.ok(entryEased < 0.5, `documents the gate boundary: linear entry eased ${entryEased} < 0.5`);

  const input = baseline(slideUp);
  const correctEntry = input.frameProofs.entry;
  input.frameProofs.entry = {
    ...correctEntry,
    subtitlePixels: {
      changedPixels: Math.round(correctEntry.subtitlePixels.changedPixels / 2),
      changedRatio: correctEntry.subtitlePixels.changedRatio / 2,
      maximumChannelDelta: correctEntry.subtitlePixels.maximumChannelDelta,
    },
    subtitleGeometry: {
      ...correctEntry.subtitleGeometry,
      changedPixels: Math.round(correctEntry.subtitleGeometry.changedPixels / 2),
      meanChangedChannelDelta: correctEntry.subtitleGeometry.meanChangedChannelDelta / 2,
      bounds: {
        ...correctEntry.subtitleGeometry.bounds,
        areaPixels: correctEntry.subtitleGeometry.changedPixels,
      },
    },
  };
  verifyAnimationObservation(input); // must NOT throw -- documents the gate, not a hole
});

test('defect 5b: the SAME halved-energy mutation on the fade case IS caught, because fade alone has '
  + 'a phase-to-phase energy-ordering check', () => {
  const input = baseline(fade);
  // Make exit's energy collapse to roughly half of entry's -- violates "exit must carry MORE energy
  // than entry" for a genuine fade-in-then-hold-then-fade-out case.
  input.frameProofs.exit.subtitleGeometry = {
    ...input.frameProofs.exit.subtitleGeometry,
    meanChangedChannelDelta: input.frameProofs.entry.subtitleGeometry.meanChangedChannelDelta / 2,
  };
  assert.throws(() => verifyAnimationObservation(input), /fade entry did not carry less energy than exit/u);
});

// =================================================================================================
// 6. Stale frame: previous cue's ink persisting (compositor/publication plateau).
// =================================================================================================

test('defect 6a: a 600ms plateau in the visible-publication counter (frozen frame under continuous '
  + 'playback) is rejected', () => {
  const input = baseline(slideUp);
  const frozenPublication = input.continuitySamples[119].visual.publication;
  for (let index = 120; index <= 131; index += 1) {
    input.continuitySamples[index].visual.publication = frozenPublication;
  }
  assert.throws(() => verifyAnimationObservation(input), /visible canvas publication plateaued/u);
});

test('defect 6b: a 600ms plateau in the compositor revision counter is rejected', () => {
  const input = baseline(slideUp);
  const frozenRevision = input.continuitySamples[119].revision;
  for (let index = 120; index <= 131; index += 1) {
    input.continuitySamples[index].revision = frozenRevision;
  }
  assert.throws(() => verifyAnimationObservation(input), /compositor plateaued/u);
});

// =================================================================================================
// 7. Missing "surface" ink -- this oracle has one render surface, so the closest analogue to the
//    three-way export check is composed-vs-source disagreement (already exercised as defect 2b);
//    this test adds the complementary case: the SOURCE signal itself degenerates (e.g. a black
//    target) while the composed frame still looks fine, which the file guards independently.
// =================================================================================================

test('defect 7: a degenerate (near-black) source signal underneath otherwise-normal composed pixels '
  + 'is rejected', () => {
  const input = baseline(slideUp);
  input.frameProofs.entry.sourceSignal = {
    ...input.frameProofs.entry.sourceSignal, nearBlackRatio: 0.999,
  };
  assert.throws(() => verifyAnimationObservation(input), /frame is a black target/u);
});

// =================================================================================================
// HOLES summary (diagnostic only -- never fails the run).
// =================================================================================================

test('HOLES summary (diagnostic)', (t) => {
  for (const hole of HOLES) t.diagnostic(JSON.stringify(hole));
  assert.ok(Array.isArray(HOLES));
});
