// Per-phase frame proofs against same-instant source controls, phase transitions, animation
// control specs and the bounded witness ledger staged when an animation proof fails.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';

import {
  compareFramePixelGeometry,
  compareFramePixels,
  compareFrames,
  measureFrameSignal,
} from '../../../support/nativeMediaOracle.js';
import {
  verifyCustomizationTransition,
} from '../../../support/subtitleCustomizationFrameOracle.js';
import {
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  ANIMATION_TYPE_VALUES,
} from '../../../support/subtitleMaterialAnimationOracle.js';
import { recordWorkflowDiagnostic } from '../../../support/workflowEvidence.js';

import { WORKFLOW, publicSeek } from './previewControls.js';
import { assertComparableCapture, captureNativeFrame } from './materialCapture.js';

const MAX_WITNESS_LEDGER_SAMPLES = 200;
const MAX_WITNESS_LEDGER_MEDIA_EVENTS = 200;
const MAX_WITNESS_LEDGER_BYTES = 512 * 1024;

/**
 * A continuity/completeness assertion failure inside `verifyAnimationObservation` otherwise takes
 * the witness's full sample series and media-event ledger down with the failing process. The
 * journey is the only place that still holds them at that instant, so it stages a bounded snapshot
 * through the evidence publisher before the original error propagates. Each retained sample already
 * carries its own `rafIntervalMs` (the jitter self-probe from `startAnimationWitness`'s tick loop),
 * so this ledger separates 'the whole JS thread stalled' (rafIntervalMs balloons everywhere) from
 * 'only decoded-video delivery stalled' (rafIntervalMs stays ~one frame while mediaTime/revision
 * plateau) without any extra timer.
 */
export const stageAnimationWitnessLedger = ({ animation, temporal }) => {
  const samples = Array.isArray(temporal?.continuitySamples) ? temporal.continuitySamples : [];
  const mediaEvents = Array.isArray(temporal?.mediaEvents) ? temporal.mediaEvents : [];
  let keptSamples = samples.slice(-MAX_WITNESS_LEDGER_SAMPLES);
  const keptMediaEvents = mediaEvents.slice(-MAX_WITNESS_LEDGER_MEDIA_EVENTS);
  const buildDocument = () => ({
    schemaVersion: 1,
    animation: { id: animation.id, type: animation.type, easing: animation.easing },
    totalSamples: samples.length,
    totalMediaEvents: mediaEvents.length,
    retainedSamples: keptSamples.length,
    rafIntervalMsSeries: keptSamples.map(sample => sample.rafIntervalMs ?? null),
    samples: keptSamples,
    mediaEvents: keptMediaEvents,
  });
  let document = buildDocument();
  // The per-field caps above bound the ordinary case; this is the same defensive byte ceiling the
  // rest of this evidence lane applies (see MAX_APP_LOG_TAIL_BYTES in workflowEvidence.js), so one
  // pathological sample (an unbounded visibleErrors/recordedRefusals array) still cannot make the
  // written evidence unbounded.
  while (
    Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_WITNESS_LEDGER_BYTES
    && keptSamples.length > 10
  ) {
    keptSamples = keptSamples.slice(Math.ceil(keptSamples.length / 2));
    document = buildDocument();
  }
  try {
    recordWorkflowDiagnostic({
      workflow: WORKFLOW,
      name: 'animation-witness-ledger',
      file: 'diagnostics/animation-witness-ledger.json',
      description: 'The last witness samples (with per-sample rAF interval) and media-event '
        + 'ledger for the failing animation case, captured before the continuity/completeness '
        + 'assertion that failed unwound the process.',
      document,
    });
  } catch {
    // Diagnostic staging stays best-effort: it must never replace or mask the real assertion
    // failure the caller is about to rethrow.
  }
};

const captureSourceControl = async (root, animation, phase, mediaTime, sourceBaseline) => {
  const composed = await captureNativeFrame(root, `animation-${animation.id}-${phase.name}-composed`);
  assert.ok(sourceBaseline?.path && sourceBaseline?.frame, `${phase.name}: source Canvas baseline is absent`);
  const sourcePath = sourceBaseline.path;
  const captureCompatibility = assertComparableCapture(
    sourceBaseline.geometry.capture,
    composed.geometry.capture,
    `${animation.id}/${phase.name}`,
  );
  const subtitlePixels = compareFramePixels(sourcePath, composed.path, { channelDeltaThreshold: 16 });
  const subtitleGeometry = compareFramePixelGeometry(
    sourcePath,
    composed.path,
    { channelDeltaThreshold: 16 },
  );
  return Object.freeze({
    phase: phase.name,
    mediaTime,
    composed,
    sourcePath,
    sourceCapture: sourceBaseline.geometry.capture ?? null,
    captureCompatibility,
    subtitlePixels,
    subtitleGeometry,
    composedSignal: measureFrameSignal(composed.path),
    sourceSignal: measureFrameSignal(sourcePath),
  });
};

export const captureAnimationPhaseProofs = async (root, animation, sourceBaselines) => {
  const proofs = {};
  for (const phase of ANIMATION_PHASES) {
    const state = await publicSeek(phase.seconds, true);
    proofs[phase.name] = await captureSourceControl(
      root,
      animation,
      phase,
      state.video.currentTime,
      sourceBaselines[phase.name],
    );
  }
  return Object.freeze(proofs);
};

export const temporalPhaseTransitions = frameProofs => Object.freeze({
  entryToSteady: verifyCustomizationTransition({
    beforePath: frameProofs.entry.composed.path,
    afterPath: frameProofs.steady.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
  steadyToExit: verifyCustomizationTransition({
    beforePath: frameProofs.steady.composed.path,
    afterPath: frameProofs.exit.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
  entryToExit: verifyCustomizationTransition({
    beforePath: frameProofs.entry.composed.path,
    afterPath: frameProofs.exit.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
});

export const animationTypeSpec = animation => ({
  token: `animation-${animation.type}`,
  field: 'animationType',
  selector: '#subtitle-animation-type',
  kind: 'dropdown',
  value: animation.type,
  values: ANIMATION_TYPE_VALUES,
});

export const animationEasingSpec = animation => ({
  token: `easing-${animation.index}`,
  field: 'animationEasing',
  selector: '#subtitle-animation-easing',
  kind: 'dropdown',
  value: animation.easing,
  values: ANIMATION_EASING_VALUES,
});
