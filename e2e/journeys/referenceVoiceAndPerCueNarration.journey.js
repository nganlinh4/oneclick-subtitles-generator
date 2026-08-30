// Two connected customer surfaces: reference-voice cloning, and per-cue narration controls.
//
// Reference-voice cloning (F5-TTS/Chatterbox) needs a multi-gigabyte native engine package this
// lane cannot install. Its honest boundary is proven instead: NarrationMethodSelection.js disables
// the method's own radio input until the engine is ready, so ReferenceAudioSection.js/AudioControls.js
// -- the upload/record/use-example controls -- never mount at all while it is absent. That is a
// stronger, more precise claim than "the upload button is disabled": the control is provably
// unreachable, not merely inert.
//
// Per-cue narration controls (regenerate one cue, play one cue) are proven with the same reviewed
// gTTS provider smoke narrationGeneration.journey.js uses, and drive a precise ownership claim a
// customer needs from "regenerate this one line": regenerating exactly one cue rebinds only that
// cue's revision-owned checkpoint entry and durable artifact, while every sibling cue's artifact
// stays byte-identical on disk -- proven by an independent SHA-256 read before and after, not by
// trusting the UI's own "succeeded" state.

/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { sha256File } from '../support/downloadJourneyOracle.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { measureAudioSignal, probeMedia } from '../support/nativeMediaOracle.js';
import {
  REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE,
  verifyPerCueRegenerationRebinding,
  verifySiblingArtifactsUntouched,
} from '../support/narrationControlOracle.js';
import {
  durableProjectNarrations,
  resolveManagedArtifact,
  verifyNarrationGenerationOwnership,
  verifySingleProjectArtifact,
} from '../support/narrationJourneyOracle.js';
import { importSubtitleDocument, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'gtts';
const WORKFLOW = 'reference-voice-and-per-cue-narration';
const REFERENCE_VOICE_METHODS = Object.freeze(['f5tts', 'chatterbox']);
const CUE_TEXTS = Object.freeze(['Cue one alpha', 'Cue two bravo', 'Cue three charlie']);
const REGENERATED_ORDINAL = 2; // 1-based: the middle cue, so both neighbours are provable siblings.

const looksLikeMp3 = (bytes) => (
  bytes.length >= 3
  && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
);

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

// Three short, non-overlapping cues inside the real staged clip's playable range, distinct enough
// that a DOM text search can never confuse one row for another.
const CUE_PLAN = Object.freeze([
  { start: 0.5, end: 2.0 },
  { start: 3.0, end: 4.5 },
  { start: 6.0, end: 7.5 },
]);

// BUG FOUND AND FIXED HERE (real run, candidate 20): the per-cue array was returned from the map
// callback WITHOUT its own `.join('\n')`, so the outer `.join('\n')` only ever separated BLOCKS
// with one newline while each block's four elements fell back to Array's default toString, which
// always joins with a comma regardless of the outer separator. The produced "SRT" was therefore
// one comma-joined line per cue (e.g. "1,00:00:00,500 --> 00:00:02,000,Cue one alpha,") -- not
// valid SRT at all. src/utils/srtParser.js's parseSrtContent correctly rejects that shape and
// returns `[]`; src/components/app/handlers/subtitleHandlers.js's handleSrtUpload then takes its
// `parsedSubtitles.length === 0` branch, sets an ERROR status (not a toast) and returns without
// ever calling setSubtitlesData -- so zero cues ever appear, deterministically, on every attempt.
// This is why a retry never helped: it is not the documented media-binding race at all, just a
// malformed fixture. Each inner array must be joined with '\n' BEFORE the outer join runs.
const threeCueFixture = () => CUE_TEXTS.map((text, index) => {
  const { start, end } = CUE_PLAN[index];
  return [String(index + 1), `${srtTime(start)} --> ${srtTime(end)}`, text, ''].join('\n');
}).join('\n');

/** Whichever reference-voice methods a fresh profile could not have installed are proven inert. */
const referenceVoiceBoundaryState = () => browser.execute((methods) => Object.fromEntries(
  methods.map((method) => {
    const input = document.querySelector(`#method-${method}`);
    const label = document.querySelector(`label[for="method-${method}"]`);
    return [method, {
      present: input !== null && label !== null,
      disabled: input === null ? null : input.disabled,
      unavailableClass: label === null ? null : label.classList.contains('unavailable'),
    }];
  }),
), REFERENCE_VOICE_METHODS);

/**
 * src/components/common/HelpIcon.jsx never sets a native `title` HTML attribute -- it wraps its
 * icon in src/components/common/Tooltip.jsx, a fully custom click/hover tooltip whose content only
 * ever renders inside a `document.body` portal (`.oc-tooltip-content`) while `Tooltip.jsx`'s own
 * `isVisible` state is true. Reading `.getAttribute('title')` on the icon (as this journey
 * originally did) always returns null; the only way to read the real customer-visible copy is to
 * trigger the same click Tooltip.jsx's `onClick={handleTriggerClick}` listens for, read the portal,
 * then click again to close it (Tooltip.jsx toggles `isVisible` on each click) so it does not linger
 * into later, unrelated captureWorkflowStep screenshots.
 */
const readMethodTooltip = async (method) => {
  const iconSelector = `label[for="method-${method}"] .method-help-icon`;
  await clickControl(iconSelector);
  let tooltip = null;
  await waitUntilWithFreshDiagnostic(async () => {
    tooltip = await browser.execute(() => {
      const node = document.querySelector('.oc-tooltip.oc-tooltip-visible .oc-tooltip-content');
      return node === null ? null : (node.textContent || '').trim();
    });
    return typeof tooltip === 'string' && tooltip.length > 0;
  }, {
    timeout: 5_000,
    interval: 100,
    diagnostic: () => `${method}'s tooltip never became visible after a click`,
  });
  await clickControl(iconSelector);
  await waitUntilWithFreshDiagnostic(async () => browser.execute(() => (
    document.querySelector('.oc-tooltip-visible') === null
  )), {
    timeout: 5_000,
    interval: 100,
    diagnostic: () => `${method}'s tooltip never closed after a second click`,
  });
  return tooltip;
};

/** Reference-voice controls only ever mount inside the active method's own section. */
const referenceVoiceControlsMounted = () => browser.execute(() => (
  document.querySelector('.reference-audio-row') !== null
  || document.querySelector('.audio-controls-row') !== null
  || document.querySelector('.example-audio-dropdown-container') !== null
));

const dismissToasts = () => browser.execute(() => {
  for (const close of document.querySelectorAll('.toast-item.live .close-icon')) close.click();
});

const waitForDurableCues = async (root, expected) => {
  let durable = null;
  await browser.waitUntil(() => {
    durable = durableState(root);
    return durable.projects.length === 1 && durable.cues.length === expected;
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `the imported ${expected}-cue plan never became durable`,
  });
  return durable;
};

/**
 * Drop the subtitle document, retrying once if the rows never appear.
 *
 * Real-run observation (candidate 19, 2026-08-28): the very first drop right after
 * openProjectWithMedia() can land in a narrow window where openProjectWithMedia's only readiness
 * signal (the native <video> reporting a finite duration) has fired, but the async native
 * subtitle-project binding it depends on (src/platform/subtitleProjectBinding.js, which
 * src/components/inputs/FileUploadInput.js awaits before ever publishing `uploadedFile`) has only
 * just started its own fire-and-forget hydration read (src/hooks/useNativeSubtitleHydration.js).
 * If the drop's persistImportedSubtitlesForActiveProject call (src/utils/importedSubtitlePersistence.js)
 * loses that race, handleSrtUpload refuses without ever calling setSubtitlesData -- see
 * subtitleHandlers.test.js's "does not publish rows or a success status when persistence refuses" --
 * so zero cues appear and the button never shows "uploaded". The drop is idempotent (it fully
 * replaces the cue set both in React state and in the durable track), so re-dispatching it once
 * closes the window without weakening what this journey proves.
 */
const importSubtitleDocumentSettled = async (subtitles, name, expectedCue) => {
  try {
    await importSubtitleDocument(subtitles, name, expectedCue);
  } catch (firstError) {
    try {
      await importSubtitleDocument(subtitles, name, expectedCue);
    } catch (secondError) {
      throw new Error(
        `the subtitle import never settled after a retry: ${secondError.message}`,
        { cause: firstError },
      );
    }
  }
};

/** Tag exactly one result row's control button so clickControl can press it without a stable id. */
const tagResultControlButton = (cueText, iconName) => browser.execute((text, icon) => {
  const marker = 'data-e2e-narration-control';
  for (const stale of document.querySelectorAll(`[${marker}]`)) stale.removeAttribute(marker);
  const rows = [...document.querySelectorAll('.result-item[data-narration-result-state="succeeded"]')];
  const row = rows.find((node) => (node.querySelector('.result-text')?.textContent || '').includes(text));
  if (row === undefined) return { found: false, reason: 'noMatchingRow', rowCount: rows.length };
  const buttons = [...row.querySelectorAll('.result-controls button')];
  const button = buttons.find((node) => (
    (node.querySelector('.material-symbols-rounded')?.textContent || '').trim() === icon
  ));
  if (button === undefined) {
    return {
      found: false,
      reason: 'noMatchingButton',
      buttonIcons: buttons.map((node) => (node.querySelector('.material-symbols-rounded')?.textContent || '').trim()),
    };
  }
  button.setAttribute(marker, '1');
  return { found: true };
}, cueText, iconName);

const clickResultControlButton = async (cueText, iconName, label) => {
  const tagged = await tagResultControlButton(cueText, iconName);
  assert.equal(tagged.found, true, `${label}: ${JSON.stringify(tagged)}`);
  await clickControl('[data-e2e-narration-control="1"]');
  await browser.execute(() => {
    document.querySelector('[data-e2e-narration-control]')?.removeAttribute('data-e2e-narration-control');
  });
};

const resultRowSurface = (cueText) => browser.execute((text) => {
  const rows = [...document.querySelectorAll('.result-item[data-narration-result-state="succeeded"]')];
  const row = rows.find((node) => (node.querySelector('.result-text')?.textContent || '').includes(text));
  const audio = document.querySelector('.gtts-content audio');
  return {
    rowFound: row !== undefined,
    playing: row?.classList.contains('playing') ?? null,
    retrying: row?.classList.contains('retrying') ?? null,
    audioSrc: audio?.currentSrc || audio?.getAttribute('src') || null,
    audioPaused: audio ? audio.paused : null,
  };
}, cueText);

const anyRetryingRow = () => browser.execute(() => (
  document.querySelector('.result-item.retrying') !== null
));

describe('a customer regenerates and plays one narration cue, and reference-voice cloning refuses honestly', () => {
  it('proves the honest reference-voice boundary, then a precise single-cue regenerate ownership claim', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');

    await openProjectWithMedia();
    await importSubtitleDocumentSettled(threeCueFixture(), 'reference-voice-and-per-cue-narration.srt', CUE_TEXTS[0]);
    await waitForDurableCues(root, CUE_TEXTS.length);
    // A clean profile intentionally mounts only the service-unavailable summary until at least one
    // narration provider is ready. Install the small provider through the public Tools flow before
    // inspecting the full method surface or trying per-cue generation.
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed gTTS package is visibly installed, running, and ready.',
        details: { ...state, proofClass: 'network-dependent gTTS provider smoke' },
      }),
    });

    // --- Part 1: reference-voice cloning is present but honestly unreachable. -------------------
    // Only a fresh profile without the F5-TTS/Chatterbox managed packages can prove this boundary;
    // an environment that installed either engine for a different journey would make this assertion
    // false rather than untestable, so it fails loudly instead of silently skipping.
    const boundary = await referenceVoiceBoundaryState();
    for (const method of REFERENCE_VOICE_METHODS) {
      const state = boundary[method];
      assert.equal(state.present, true, `the ${method} method radio/label is missing from the DOM`);
      assert.equal(
        state.disabled,
        true,
        `${method} became installed/ready in this environment; the honest-boundary proof needs a `
        + 'multi-GB-engine-focused journey instead of this one',
      );
      assert.equal(state.unavailableClass, true, `${method}'s label lost its unavailable styling`);
      const tooltip = await readMethodTooltip(method);
      assert.equal(
        tooltip,
        REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE,
        `${method}'s unavailable tooltip text changed`,
      );
    }
    assert.equal(
      await referenceVoiceControlsMounted(),
      false,
      'reference-voice upload/record controls are mounted despite no reference-voice engine being ready',
    );
    // A disabled native <input> ignores a script-dispatched click and fires no change event; this
    // proves the boundary is functionally inert, not only styled as unavailable.
    await browser.execute((methods) => {
      for (const method of methods) document.querySelector(`#method-${method}`)?.click();
    }, REFERENCE_VOICE_METHODS);
    assert.equal(
      await referenceVoiceControlsMounted(),
      false,
      'clicking a disabled reference-voice method radio revealed its upload/record controls',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-reference-voice-boundary',
      description: 'F5-TTS and Chatterbox reference-voice controls are present but truthfully unreachable '
        + 'without their multi-gigabyte engine packages.',
      details: { boundary },
      focusSelector: '.narration-method-row',
    });

    // --- Part 2: durable per-cue narration with the reviewed gTTS provider smoke. ----------------
    await clickControl('label[for="method-gtts"]');
    const generateSelector = '[data-osg-action="generate-narration"][data-narration-method="gtts"]';
    const generate = await $(generateSelector);
    let generateState = null;
    await waitUntilWithFreshDiagnostic(async () => {
      generateState = await browser.execute((selector) => {
        const button = document.querySelector(selector);
        return button === null ? null : { disabled: button.disabled };
      }, generateSelector);
      return generateState !== null && generateState.disabled === false;
    }, {
      timeout: 120_000,
      interval: 500,
      diagnostic: () => `gTTS never became ready to generate: ${JSON.stringify(generateState)}`,
    });

    await dismissToasts();
    const beforeGeneration = durableState(root);
    assert.equal(durableProjectNarrations(root).length, 0, (
      'the fresh project inherited a narration checkpoint before generation'
    ));
    await generate.click();

    let surface = null;
    let afterGeneration = null;
    let records = [];
    await browser.waitUntil(() => {
      afterGeneration = durableState(root);
      records = durableProjectNarrations(root);
      return afterGeneration.counts.cues === CUE_TEXTS.length && records.length === 1
        && records[0].value.results.length === CUE_TEXTS.length;
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: `narration generation for ${CUE_TEXTS.length} cues never settled durably`,
    });
    surface = await browser.execute(() => ({
      succeeded: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
      pending: document.querySelectorAll('[data-narration-result-state="pending"]').length,
      failed: document.querySelectorAll('[data-narration-result-state="failed"]').length,
    }));

    const generation = verifyNarrationGenerationOwnership({
      before: beforeGeneration,
      after: afterGeneration,
      records,
      surface,
    });
    const beforeResults = records[0].value.results;

    // Resolve and hash every cue's artifact right after generation, before any regenerate.
    const cuePaths = new Map();
    for (const binding of generation.bindings) {
      const path = resolveManagedArtifact(root, binding.artifact.relative_path);
      const bytes = readFileSync(path);
      assert.equal(looksLikeMp3(bytes.subarray(0, 3)), true, `cue ${binding.cue.ordinal} artifact is not MP3 audio`);
      cuePaths.set(Number(binding.cue.ordinal), path);
    }
    const preRegenerateHashes = new Map(
      [...cuePaths.entries()].map(([ordinal, path]) => [ordinal, {
        size: statSync(path).size,
        sha256: sha256File(path),
      }]),
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-initial-generation-complete',
      description: 'Every cue published one independently decodable, non-silent MP3 artifact.',
      details: {
        proofClass: 'network-dependent gTTS provider smoke',
        cueCount: afterGeneration.cues.length,
      },
      focusSelector: '.narration-section',
    });

    // --- Regenerate exactly the middle cue. -------------------------------------------------------
    const beforeRegenerate = durableState(root);
    const beforeRegenerateJobIds = new Set(beforeRegenerate.jobs.map(({ id }) => id));
    await clickResultControlButton(CUE_TEXTS[REGENERATED_ORDINAL - 1], 'refresh', 'regenerate control');

    let afterRegenerate = null;
    let regeneratedRecords = [];
    let failedRegenerateJob = null;
    await waitUntilWithFreshDiagnostic(async () => {
      afterRegenerate = durableState(root);
      regeneratedRecords = durableProjectNarrations(root);
      const newJobs = afterRegenerate.jobs.filter((job) => (
        job.kind === 'synthesizeNarration' && !beforeRegenerateJobIds.has(job.id)
      ));
      failedRegenerateJob = newJobs.find((job) => (
        job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted'
      )) ?? null;
      if (failedRegenerateJob !== null) return true;
      return afterRegenerate.jobs.length > beforeRegenerate.jobs.length
        && afterRegenerate.artifacts.length > beforeRegenerate.artifacts.length
        && !(await anyRetryingRow())
        && regeneratedRecords.length === 1;
    }, {
      timeout: 180_000,
      interval: 1_000,
      diagnostic: () => `regenerating the middle cue never published one new durable job and artifact: ${JSON.stringify({ failedRegenerateJob })}`,
    });
    if (failedRegenerateJob !== null) {
      throw new Error(`native narration regenerate job terminated: ${JSON.stringify(failedRegenerateJob)}`);
    }

    const regeneration = verifySingleProjectArtifact({
      before: beforeRegenerate,
      after: afterRegenerate,
      expectedProjectId: generation.projectId,
      jobKind: 'synthesizeNarration',
      artifactKind: 'narrationOutput',
    });
    const afterResults = regeneratedRecords[0].value.results;
    const rebinding = verifyPerCueRegenerationRebinding({
      beforeResults,
      afterResults,
      regeneratedOrdinal: REGENERATED_ORDINAL,
      newArtifactId: regeneration.artifact.id,
    });

    const regeneratedPath = resolveManagedArtifact(root, regeneration.artifact.relative_path);
    const regeneratedBytes = readFileSync(regeneratedPath);
    assert.equal(looksLikeMp3(regeneratedBytes.subarray(0, 3)), true, 'the regenerated artifact is not MP3 audio');
    const regeneratedProbe = probeMedia(regeneratedPath);
    assert.equal(
      regeneratedProbe.streams.filter(({ codec_type: type }) => type === 'audio').length,
      1,
      'the regenerated cue has no single decoded audio stream',
    );
    const regeneratedSignal = measureAudioSignal(regeneratedPath);
    assert.ok(
      Number.isFinite(regeneratedSignal.peakVolumeDb) && regeneratedSignal.peakVolumeDb > -50,
      `the regenerated cue independently decodes as silence: ${JSON.stringify(regeneratedSignal)}`,
    );
    assert.notEqual(
      sha256File(regeneratedPath),
      preRegenerateHashes.get(REGENERATED_ORDINAL).sha256,
      'the regenerated cue reused the exact same bytes as its stale artifact',
    );

    // --- Every sibling cue's artifact stayed byte-identical on disk. -------------------------------
    const siblings = rebinding.siblingOrdinals.map((ordinal) => {
      const path = cuePaths.get(ordinal);
      const before = preRegenerateHashes.get(ordinal);
      return {
        ordinal,
        beforeSize: before.size,
        afterSize: statSync(path).size,
        beforeSha256: before.sha256,
        afterSha256: sha256File(path),
      };
    });
    verifySiblingArtifactsUntouched(siblings);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-single-cue-regenerate-complete',
      description: 'Regenerating cue 2 rebound only cue 2 durably; cues 1 and 3 stayed byte-identical on disk.',
      details: { rebinding, siblings: siblings.map(({ ordinal, beforeSha256 }) => ({ ordinal, sha256: beforeSha256 })) },
      focusSelector: '.narration-section',
    });

    // --- Play one untouched cue and prove real playback state, not only a class toggle. ------------
    await clickResultControlButton(CUE_TEXTS[0], 'play_arrow', 'play control');
    let playState = null;
    await waitUntilWithFreshDiagnostic(async () => {
      playState = await resultRowSurface(CUE_TEXTS[0]);
      return playState.rowFound && playState.playing === true
        && playState.audioPaused === false && Boolean(playState.audioSrc);
    }, {
      timeout: 30_000,
      interval: 200,
      diagnostic: () => `clicking play never reached a playing audio state: ${JSON.stringify(playState)}`,
    });
    await clickResultControlButton(CUE_TEXTS[0], 'pause', 'pause control');
    await waitUntilWithFreshDiagnostic(async () => {
      playState = await resultRowSurface(CUE_TEXTS[0]);
      return playState.audioPaused === true;
    }, {
      timeout: 30_000,
      interval: 200,
      diagnostic: () => `clicking pause never stopped playback: ${JSON.stringify(playState)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-cue-playback-complete',
      description: 'Playing and pausing the untouched first cue drove the real hidden <audio> element.',
      details: { playState },
      focusSelector: '.narration-section',
    });

    const visibleErrors = await browser.execute(() => [...document.querySelectorAll(
      '.narration-section .error, .narration-section [role="alert"], .toast-item.live .toast-error',
    )].map((node) => (node.innerText || node.textContent || '').trim()).filter(Boolean));
    assert.deepEqual(visibleErrors, [], 'a visible narration error remained after the journey');
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden narration journey activated fullscreen',
    );
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
