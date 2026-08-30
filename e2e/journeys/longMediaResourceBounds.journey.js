// Long-media resource-bound coverage (handoff step 7).
//
// Every other media journey proves correctness on a nineteen-second clip. None of them can catch a
// waveform, timeline-range, memory, handle, thread, temp-file or database bound that only shows up
// once media runs for hours: a duration-proportional loop that looks fine at 19s can still grow
// without bound at two hours, and a leak that is a rounding error at 19s can be the whole story at
// two hours. This journey opens a wholly synthetic, offline-generated two-hour source (see
// support/longSyntheticMediaFixture.js -- tiny on disk, long in time, no network) and proves, all on
// the SAME source:
//   1. the waveform never paints ink past real, playable media duration, at the default view AND at
//      a real product zoom-in interaction (src/components/lyrics/waveformRendering.js's
//      waveformEnd/drawEnd clamp is the enforcement point; this is timelineBoundary's own proof,
//      generalized to a duration that could actually expose an overflow);
//   2. the desktop process's own working set, private bytes, handle count and thread count, the
//      isolated run root's own file count/bytes, and the SQLite footprint all stay within generous,
//      documented caps across a seek storm, zoom churn and brief playback;
//   3. the managed artifact ledger matches disk exactly at the end of the session -- no orphan
//      artifact or temp file survives.
//
// Relaunch recovery for a long-running native job belongs to a two-process scenario, not here: see
// scenarios/longMediaOperationRecovery.mjs and journeys/longMediaOperationRecovery.journey.js.
//
// HEAVY-SHARD JOURNEY. Building the fixture is a one-time, cached, tens-of-seconds FFmpeg encode;
// running it decodes real PCM proportional to two hours of audio and drives a real zoom/seek/playback
// session. This is deliberately excluded
// from the default suite in run-isolated.mjs's NON_DEFAULT_JOURNEYS, with its own npm script
// (test:long-media-resource-bounds), the same precedent nativeToolsInstall/transcriptionRulesAndAnalysis
// already set for a heavy single-process journey run explicitly by name.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { LONG_SYNTHETIC_MEDIA } from '../support/longSyntheticMediaFixture.js';
import {
  databaseFootprintBytes, runRootFileCensus, sampleApplicationProcess,
} from '../support/longMediaResourceOracle.js';
import { assertManagedArtifactLedgerMatchesDisk } from '../support/renderQueue.js';
import { openProjectWithMedia, seekPreviewTo } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'long-media-resource-bounds';

/* global $, browser, describe, document, it */

// --- Waveform point/byte caps, cited at the point each is used below ---
// src/components/lyrics/audioProcessing.js: nativeWaveformDensity() -- the frontend's own bounded
// request. For media over 300s it always requests 4 points/second, and caps the request at
// TARGET_LONG_WAVEFORM_POINTS (250,000) or MAX_WAVEFORM_POINTS (1,000,000), whichever binds first.
const FRONTEND_MAX_WAVEFORM_POINTS = 1_000_000;
const FRONTEND_TARGET_LONG_WAVEFORM_POINTS = 250_000;
// apps/desktop/src-tauri/src/media_pipeline.rs:35 -- the native validation ceiling every waveform
// request is checked against regardless of what the frontend asked for.
const NATIVE_MAX_WAVEFORM_POINTS = 1_000_000;
// apps/desktop/src-tauri/src/waveform_cache.rs:20 -- the byte cap on ONE cached waveform artifact.
const WAVEFORM_CACHE_MAX_BYTES = 16 * 1024 * 1024;

// --- Resource-growth caps and their justification ---
// Thread-count growth: this suite already caught a real unbounded-scan regression at 562 threads
// (asrGeneration's finding, recorded in e2e/inventory.json). This ceiling sits more than 8x below
// that regression while tolerating legitimate churn bounded by MAX_CONCURRENT_OPERATIONS=2
// (apps/desktop/src-tauri/src/media_pipeline.rs:36) and MAX_CONCURRENT_RENDERS=1
// (apps/desktop/src-tauri/src/render/host.rs:22) -- neither of which this journey's seek/zoom/
// playback interaction should even invoke a second time, since a seek is an ordinary HTTP range
// request against the private native media server the initial PreparePlayback job already opened.
const THREAD_COUNT_GROWTH_CAP = 64;
// Handle-count growth: a generous ceiling on Windows kernel object growth (files, events, sync
// primitives) across the whole heavy-interaction session, sized to catch a per-request handle leak
// rather than to pin a steady-state count.
const HANDLE_COUNT_GROWTH_CAP = 2_000;
// Working-set / private-bytes growth: the same regression above also grew private memory toward
// ~11 GiB. 512 MiB is more than 20x tighter while still tolerating ordinary allocator churn, the
// bounded per-waveform cache artifact (WAVEFORM_CACHE_MAX_BYTES above) and the WebView's own bounded
// in-memory waveform cache (MAX_CACHED_WAVEFORMS=4, src/components/lyrics/VolumeVisualizer.js:21).
const WORKING_SET_GROWTH_CAP_BYTES = 512 * 1024 * 1024;
const PRIVATE_BYTES_GROWTH_CAP_BYTES = 512 * 1024 * 1024;
// Run-root file/byte growth: seeking, zooming and brief playback read an already-prepared media
// stream and an already-cached waveform; none of that should create new scratch or durable files. A
// small allowance covers incidental log/WAL churn without rubber-stamping a real leak.
const RUN_ROOT_FILE_COUNT_GROWTH_CAP = 4;
const RUN_ROOT_BYTES_GROWTH_CAP = 4 * 1024 * 1024;
// SQLite footprint growth: heavy interaction creates no new native jobs, so this bounds incidental
// job/progress-row churn, not real growth. RESIDENT_TERMINAL_JOB_LIMIT (256,
// crates/osg-application/src/jobs.rs:11) only bounds what a FUTURE boot restores into memory; it is
// not a row-deletion policy, so this cap is deliberately about THIS session's bounded interaction
// count, not an absolute product guarantee about unbounded job history.
const DATABASE_BYTES_GROWTH_CAP = 2 * 1024 * 1024;

const ZOOM_REPETITIONS = 12;
const ZOOM_DRAG_PX_PER_REP = 100;
// How close to the real end we seek before zooming in, so the zoomed, centred view straddles the
// real/gutter boundary instead of landing entirely on one side of it.
const NEAR_END_EPSILON_SECONDS = 0.02;
const SEEK_STORM_POINTS = 24;

const waveformJobs = (root) => durableState(root).jobs.filter(({ kind }) => kind === 'generateWaveform');

const waveformState = () => browser.execute(() => (
  document.querySelector('[data-osg-waveform-state]')?.getAttribute('data-osg-waveform-state') ?? null
));

const activeVideoDuration = () => browser.execute(() => {
  const video = document.querySelector('.video-preview video.video-player');
  return video === null || !Number.isFinite(video.duration) ? null : video.duration;
});

const zoomControlText = () => browser.execute(() => (
  document.querySelector('.timeline-container > .liquid-glass')?.textContent?.trim() ?? null
));

const zoomPercent = async () => {
  const match = /^(\d+)%$/.exec((await zoomControlText()) ?? '');
  return match ? Number(match[1]) : null;
};

/** One real zoom-drag gesture on the product's own zoom control, matching timelineAdvancedEditing's
 * proven technique. Repeated calls accumulate zoom because the control reads its CURRENT (already
 * increased) value as the base of each new drag. */
const performZoomDrag = async (deltaPx) => {
  const control = await $('.timeline-container > .liquid-glass');
  await control.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the zoom control never appeared' });
  await browser.action('pointer')
    .move({ origin: control })
    .down({ button: 0 })
    .pause(60)
    .move({ origin: control, x: deltaPx, y: 0, duration: 220 })
    .pause(60)
    .up({ button: 0 })
    .perform();
};

/**
 * Read waveform canvas ink columns and decide, from the product's OWN visible-range formula
 * (TimelineCalculations.js's getVisibleTimeRange / TimelineZoomControls.js's pan-centering), where
 * ink should stop. Mirrored, not guessed: this is the same arithmetic the product runs, so a defect
 * in the product's own clamp is what would make this measurement disagree with it.
 */
const waveformInkBoundary = (mediaEnd, zoomValue, nearEndEpsilonSeconds) => browser.execute((
  end, zoom, epsilon,
) => {
  const host = document.querySelector('[data-osg-waveform-state="ready"]');
  const canvas = host?.querySelector('canvas') ?? null;
  if (canvas === null || canvas.width <= 0 || canvas.height <= 0) return null;
  const context = canvas.getContext('2d');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const viewEnd = end * 1.05; // createTimelineDomain's END_GUTTER_RATIO=0.05, no cues in this journey
  const visibleDuration = viewEnd / zoom;
  const candidatePan = (end - epsilon) - (visibleDuration / 2);
  const panOffset = Math.max(0, Math.min(candidatePan, viewEnd - visibleDuration));
  const boundaryFraction = (end - panOffset) / visibleDuration;
  const expectedBoundary = boundaryFraction * canvas.width;
  const columnHasInk = (x) => {
    for (let y = 0; y < canvas.height; y += 1) {
      if (pixels[((y * canvas.width) + x) * 4 + 3] > 0) return true;
    }
    return false;
  };
  const margin = Math.max(3, Math.round(canvas.width * 0.02));
  const beforeEnd = Math.max(0, Math.floor(expectedBoundary) - margin);
  const beforeStart = Math.max(0, beforeEnd - 10);
  const afterStart = Math.min(canvas.width, Math.ceil(expectedBoundary) + margin);
  let inkBefore = false;
  let inkAfter = false;
  for (let x = beforeStart; x < beforeEnd; x += 1) inkBefore ||= columnHasInk(x);
  for (let x = afterStart; x < canvas.width; x += 1) inkAfter ||= columnHasInk(x);
  return {
    width: canvas.width, zoom, visibleDuration, panOffset, expectedBoundary, inkBefore, inkAfter,
  };
}, mediaEnd, zoomValue, nearEndEpsilonSeconds);

/**
 * `waitUntil`'s own `timeoutMsg` must be a static string -- WebdriverIO (and this suite's own
 * automationSafety.contract.test.mjs) requires it, because the options object is evaluated eagerly
 * at call time, before the predicate ever runs. A diagnostic that needs LIVE state read at the
 * moment of failure goes through this wrapper instead, exactly like timelineBoundary.journey.js's
 * own helper of the same name.
 */
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

describe('long media resource bounds', () => {
  it('keeps waveform/timeline ranges, process resources and cleanup bounded on a two-hour source', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');

    // --- 1. Open the long synthetic source and let its real waveform complete. ---
    await openProjectWithMedia();
    const duration = await activeVideoDuration();
    assert.ok(
      Math.abs(duration - LONG_SYNTHETIC_MEDIA.durationSeconds) <= LONG_SYNTHETIC_MEDIA.durationToleranceSeconds,
      `the long synthetic source has no usable two-hour duration: ${duration}`,
    );
    await waitUntilWithFreshDiagnostic(async () => (await waveformState()) === 'ready', {
      timeout: 300_000,
      interval: 250,
      diagnostic: () => `the long-media waveform never completed: ${JSON.stringify(waveformJobs(root))}`,
    });
    const succeededJob = waveformJobs(root).find(({ state }) => state === 'succeeded');
    assert.ok(succeededJob, `no waveform job succeeded: ${JSON.stringify(waveformJobs(root))}`);
    assertManagedArtifactLedgerMatchesDisk(root);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-long-media-waveform-ready',
      description: 'The real two-hour source is playable and its bounded native waveform completed without an inline error.',
      details: { duration, succeededJobId: succeededJob.id },
      focusSelector: '.timeline-container',
    });

    // The completed waveform's own cached artifact bytes stay inside waveform_cache.rs's
    // MAX_CACHE_BYTES (apps/desktop/src-tauri/src/waveform_cache.rs:20) -- a real, load-bearing check
    // against the artifact this two-hour source actually produced, not just a citation.
    const readyWaveformArtifacts = durableState(root).artifacts
      .filter(({ kind, state }) => kind === 'waveformCache' && state === 'ready');
    assert.ok(readyWaveformArtifacts.length >= 1, 'no ready waveform cache artifact exists after the long-media waveform succeeded');
    for (const artifact of readyWaveformArtifacts) {
      assert.ok(
        artifact.size_bytes <= WAVEFORM_CACHE_MAX_BYTES,
        `waveform cache artifact ${artifact.id} is ${artifact.size_bytes} bytes, exceeding the ${WAVEFORM_CACHE_MAX_BYTES}-byte cap`,
      );
    }

    // --- 3. Waveform ink stops at real media duration, at the default (zoom=1/pan=0) view. ---
    // Enforcement point: src/components/lyrics/waveformRendering.js's waveformEnd/drawEnd clamp
    // (`drawEnd = Math.min(visibleEnd, Math.min(waveform.durationSeconds, seekableEnd))`). This is
    // timelineBoundary.journey.js's own proof, generalized to a duration that could actually expose
    // an accumulation/overflow bug a 19-second clip cannot.
    let defaultMeasurement = null;
    await waitUntilWithFreshDiagnostic(async () => {
      defaultMeasurement = await waveformInkBoundary(duration, 1, 0);
      return defaultMeasurement?.inkBefore === true && defaultMeasurement.inkAfter === false;
    }, {
      timeout: 60_000,
      interval: 250,
      diagnostic: () => `waveform pixels did not stop at playable media at the default view: ${JSON.stringify(defaultMeasurement)}`,
    });

    // --- 4. Baseline resource sample, taken only once the long media's session has fully settled. ---
    const processId = browser.capabilities['osg:e2eProcessId'];
    assert.ok(Number.isSafeInteger(processId) && processId > 0, 'the guarded WebDriver session did not echo a process id');
    const processBefore = sampleApplicationProcess(processId);
    const filesBefore = runRootFileCensus(root);
    const databaseBytesBefore = databaseFootprintBytes(root);

    // --- 5. Heavy interaction: a seek storm, brief playback, and a real zoom-in interaction. ---
    for (let index = 0; index < SEEK_STORM_POINTS; index += 1) {
      const target = (duration * ((index * 37) % 97)) / 97;
      await seekPreviewTo(target);
      await browser.pause(40);
    }
    await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      if (video === null) throw new Error('the editor video is missing');
      video.muted = true;
      video.currentTime = 0;
      return video.play();
    });
    await browser.pause(2_000);
    await browser.execute(() => document.querySelector('.video-preview video.video-player')?.pause());

    await browser.execute((target) => {
      const video = document.querySelector('.video-preview video.video-player');
      if (video === null) throw new Error('the editor video is missing');
      video.pause();
      video.currentTime = target;
    }, duration - NEAR_END_EPSILON_SECONDS);
    await browser.pause(200);

    const beforeZoomPercent = await zoomPercent();
    assert.equal(beforeZoomPercent, 100, `the timeline did not start at 100% zoom: ${beforeZoomPercent}`);
    for (let repetition = 0; repetition < ZOOM_REPETITIONS; repetition += 1) {
      await performZoomDrag(ZOOM_DRAG_PX_PER_REP);
    }
    const afterZoomPercent = await zoomPercent();
    assert.ok(
      afterZoomPercent > beforeZoomPercent + 4,
      `repeated zoom-drag gestures did not materially increase zoom: ${beforeZoomPercent}% -> ${afterZoomPercent}%`,
    );

    // --- 6. At that real zoom level, ink still stops exactly at real media duration. ---
    let zoomedMeasurement = null;
    await waitUntilWithFreshDiagnostic(async () => {
      zoomedMeasurement = await waveformInkBoundary(duration, afterZoomPercent / 100, NEAR_END_EPSILON_SECONDS);
      return zoomedMeasurement?.inkBefore === true && zoomedMeasurement.inkAfter === false;
    }, {
      timeout: 30_000,
      interval: 200,
      diagnostic: () => `waveform pixels overshot real media duration at ${afterZoomPercent}% zoom: ${JSON.stringify(zoomedMeasurement)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-zoomed-waveform-boundary-holds',
      description: 'After a seek storm, playback and a real zoom-in interaction, the waveform still stops exactly at real media duration.',
      details: { beforeZoomPercent, afterZoomPercent, defaultMeasurement, zoomedMeasurement },
      focusSelector: '.timeline-container',
    });

    // --- 7. Selectable range never exceeds real duration either, at this same long duration. ---
    // Enforcement point: src/components/lyrics/utils/timelineDomain.js's createTimelineDomain
    // (`selectableEnd = seekableEnd`) and getSelectAllRange (`end: domain.selectableEnd`), which
    // every selection, drag and Ctrl+A path in the timeline is built on --
    // useTimelineKeyboardShortcuts.js's Ctrl+A handler calls it directly and works with zero cues,
    // so no subtitle import is needed for this source to expose a bounded selection. Unlike the
    // waveform's point-aggregation path above, this clamp is a plain Math.min-style comparison that
    // does not accumulate error as duration grows, so the deep interactive (pixel-boundary) proof
    // lives on the waveform; here Ctrl+A only needs to prove the real keyboard path still reaches a
    // real, non-empty, bounded selection on a source two orders of magnitude longer than every other
    // journey's media -- exactly the scale a latent overflow would need to appear at.
    const timeline = await $('.subtitle-timeline');
    await timeline.click();
    await browser.keys(['', 'a', '']);
    const actionBar = await $('.range-action-bar');
    await actionBar.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'Ctrl+A never exposed the range action bar on the long synthetic source',
    });

    // --- 8. Resource sample AFTER heavy interaction; assert every delta stays within its cap. ---
    const processAfter = sampleApplicationProcess(processId);
    const filesAfter = runRootFileCensus(root);
    const databaseBytesAfter = databaseFootprintBytes(root);

    const threadGrowth = processAfter.threadCount - processBefore.threadCount;
    const handleGrowth = processAfter.handleCount - processBefore.handleCount;
    const workingSetGrowth = processAfter.workingSetBytes - processBefore.workingSetBytes;
    const privateBytesGrowth = processAfter.privateBytes - processBefore.privateBytes;
    const fileCountGrowth = filesAfter.fileCount - filesBefore.fileCount;
    const fileBytesGrowth = filesAfter.totalBytes - filesBefore.totalBytes;
    const databaseGrowth = databaseBytesAfter - databaseBytesBefore;

    assert.ok(threadGrowth <= THREAD_COUNT_GROWTH_CAP, `thread count grew by ${threadGrowth}, exceeding the cap of ${THREAD_COUNT_GROWTH_CAP}`);
    assert.ok(handleGrowth <= HANDLE_COUNT_GROWTH_CAP, `handle count grew by ${handleGrowth}, exceeding the cap of ${HANDLE_COUNT_GROWTH_CAP}`);
    assert.ok(workingSetGrowth <= WORKING_SET_GROWTH_CAP_BYTES, `working set grew by ${workingSetGrowth} bytes, exceeding the cap of ${WORKING_SET_GROWTH_CAP_BYTES}`);
    assert.ok(privateBytesGrowth <= PRIVATE_BYTES_GROWTH_CAP_BYTES, `private bytes grew by ${privateBytesGrowth}, exceeding the cap of ${PRIVATE_BYTES_GROWTH_CAP_BYTES}`);
    assert.ok(fileCountGrowth <= RUN_ROOT_FILE_COUNT_GROWTH_CAP, `the run root gained ${fileCountGrowth} files during heavy interaction, exceeding the cap of ${RUN_ROOT_FILE_COUNT_GROWTH_CAP}: ${JSON.stringify(filesAfter.paths)}`);
    assert.ok(fileBytesGrowth <= RUN_ROOT_BYTES_GROWTH_CAP, `the run root grew by ${fileBytesGrowth} bytes during heavy interaction, exceeding the cap of ${RUN_ROOT_BYTES_GROWTH_CAP}`);
    assert.ok(databaseGrowth <= DATABASE_BYTES_GROWTH_CAP, `SQLite grew by ${databaseGrowth} bytes during heavy interaction, exceeding the cap of ${DATABASE_BYTES_GROWTH_CAP}`);

    // --- 9. No orphan artifact or temp file survives the whole session. ---
    assertManagedArtifactLedgerMatchesDisk(root);

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-bounded-resource-growth',
      description: 'Process working set/handles/threads, run-root files and SQLite all stayed within their documented caps across a heavy interaction session, with no orphan artifact left behind.',
      details: {
        processBefore,
        processAfter,
        filesBefore: { fileCount: filesBefore.fileCount, totalBytes: filesBefore.totalBytes },
        filesAfter: { fileCount: filesAfter.fileCount, totalBytes: filesAfter.totalBytes },
        databaseBytesBefore,
        databaseBytesAfter,
        caps: {
          THREAD_COUNT_GROWTH_CAP,
          HANDLE_COUNT_GROWTH_CAP,
          WORKING_SET_GROWTH_CAP_BYTES,
          PRIVATE_BYTES_GROWTH_CAP_BYTES,
          RUN_ROOT_FILE_COUNT_GROWTH_CAP,
          RUN_ROOT_BYTES_GROWTH_CAP,
          DATABASE_BYTES_GROWTH_CAP,
          FRONTEND_MAX_WAVEFORM_POINTS,
          FRONTEND_TARGET_LONG_WAVEFORM_POINTS,
          NATIVE_MAX_WAVEFORM_POINTS,
          WAVEFORM_CACHE_MAX_BYTES,
        },
      },
      focusSelector: '.timeline-container',
    });
  });
});
