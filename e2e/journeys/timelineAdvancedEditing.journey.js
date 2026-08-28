// A customer restructures cue TIMING through the advanced timeline controls that
// editorCueCrudAndHistory and timelineBoundary deliberately leave alone.
//
// editorCueCrudAndHistory already owns text CRUD, insert/merge/split and the saved-checkpoint
// system. timelineBoundary already owns waveform pixels and the Ctrl+A-then-Delete-everything
// path. This journey owns the remaining advanced-editing surface: the sticky (cascade) timing
// toggle, the per-cue start/end drag handles, the multi-cue range move handle, and the timeline
// zoom control -- and the one invariant that connects them: NO cue may end beyond real, playable
// media duration, whether it was pushed there by a single-row drag or by dragging several cues at
// once. Every settled claim is checked against the application's SQLite database as well as the
// visible rows, and undo/redo is walked across a MIXED sequence of these operations (not the same
// operation repeated) so each durable step is independently provable.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { importSubtitleDocument, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'timeline-advanced-editing';

// Mirrors LYRICS_EDITOR_REVISION_PREFIX / LYRICS_EDITOR_ACTIONS in src/platform/durableLyricsHistory.js.
// Duplicated as literal strings rather than imported: that module pulls in desktop-runtime and
// browser-only storage bindings that have no business loading inside this Node-side WDIO process.
const REASON_TIMING_DRAG = 'OSG lyrics editor v1: timing drag';
const REASON_MOVE_RANGE = 'OSG lyrics editor v1: move range';

const CUE_DRAG = 'Interior cue for direct start and end drag tests';
const CUE_RANGE_A = 'First cue of the move-together range';
const CUE_RANGE_B = 'Second cue of the move-together range';
const CUE_STICKY_BASE = 'Sticky cascade base cue';
const CUE_STICKY_FOLLOWER = 'Sticky cascade follower cue';

// Absolute seconds, independent of the real media's measured duration (checked only to be > 8.5s
// below). Only the two boundary-overshoot drags and the zoom control need the live `duration`.
const IMPORTED_CUES = Object.freeze([
  Object.freeze({ start: 1.0, end: 2.0, text: CUE_DRAG }),
  Object.freeze({ start: 3.0, end: 4.0, text: CUE_RANGE_A }),
  Object.freeze({ start: 4.5, end: 5.5, text: CUE_RANGE_B }),
  Object.freeze({ start: 7.0, end: 7.5, text: CUE_STICKY_BASE }),
  Object.freeze({ start: 8.0, end: 8.5, text: CUE_STICKY_FOLLOWER }),
]);

const EPSILON_MS = 25;
const START_CLAMP_OVERSHOOT_SECONDS = 3; // 1.0s start dragged to -2.0s must clamp to 0.
const END_CLAMP_OVERSHOOT_SECONDS = 25; // 2.0s end dragged to 27s must clamp to real duration.
const STICKY_SHIFT_SECONDS = 1.0;
const RANGE_MOVE_OVERSHOOT_SECONDS = 25; // exceeds any plausible remaining headroom to duration.
const ZOOM_DRAG_PX = 80;

/* global $, browser, console, describe, document, it, window */

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

const buildSrt = (cues) => cues.map((cue, index) => [
  String(index + 1),
  `${srtTime(cue.start)} --> ${srtTime(cue.end)}`,
  cue.text,
  '',
].join('\n')).join('\n');

const installBoundedErrorWitness = () => browser.execute(() => {
  window.__OSG_TIMELINE_ADVANCED_ERRORS__ = [];
  const push = (kind, detail) => {
    const target = window.__OSG_TIMELINE_ADVANCED_ERRORS__;
    if (target.length < 50) target.push({ kind, detail: String(detail ?? '').slice(0, 500) });
  };
  const originalError = console.error.bind(console);
  console.error = (...values) => { push('console.error', values.join(' ')); originalError(...values); };
  window.addEventListener('error', (event) => push('error', event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => push('rejection', event.reason));
});

const boundedErrors = () => browser.execute(() => window.__OSG_TIMELINE_ADVANCED_ERRORS__ ?? []);

const visibleCueTexts = () => browser.execute(() => (
  [...document.querySelectorAll('.lyric-item[data-lyric-index]')]
    .sort((left, right) => (
      Number(left.getAttribute('data-lyric-index')) - Number(right.getAttribute('data-lyric-index'))
    ))
    .map((row) => (row.querySelector('.lyric-text')?.innerText ?? '').trim())
));

const closeTo = (actual, expected, tolerance = EPSILON_MS) => Math.abs(actual - expected) <= tolerance;

const durableCueRecords = (root) => durableState(root).cues
  .map((cue) => ({ start: cue.start_ms, end: cue.end_ms, text: cue.text }));

const waitForDurableCueRecords = async (root, predicate, message) => {
  let records = null;
  try {
    await browser.waitUntil(async () => {
      records = durableCueRecords(root);
      return predicate(records);
    }, { timeout: 20_000, interval: 200, timeoutMsg: message });
  } catch (error) {
    throw new Error(
      `${message}. durable rows: ${JSON.stringify(records)}; errors: ${JSON.stringify(await boundedErrors())}`,
      { cause: error },
    );
  }
  return records;
};

const latestRevisionReason = (root) => durableState(root).latestRevision?.reason ?? null;

const assertUnchanged = (records, indices, baseline, label) => {
  for (const index of indices) {
    assert.ok(closeTo(records[index].start, baseline[index].start), `${label}: cue ${index + 1} start moved`);
    assert.ok(closeTo(records[index].end, baseline[index].end), `${label}: cue ${index + 1} end moved`);
    assert.equal(records[index].text, baseline[index].text, `${label}: cue ${index + 1} text changed`);
  }
};

const waitForHistoryControl = async (selector, enabled) => {
  const control = await $(selector);
  await control.waitForExist({ timeout: 30_000 });
  await browser.waitUntil(async () => (await control.isEnabled()) === enabled, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `${selector} did not become ${enabled ? 'enabled' : 'disabled'}`,
  });
};

const scrollRowIntoView = async (index) => browser.execute((selector) => {
  document.querySelector(selector)?.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
}, `.lyric-item[data-lyric-index="${index}"]`);

/** Drag one cue's start or end handle by deltaSeconds, matching useLyricsEditorDrag's 0.01 s/px scale. */
const dragTimeControl = async (index, field, deltaSeconds) => {
  await scrollRowIntoView(index);
  const selector = `.lyric-item[data-lyric-index="${index}"] .time-control.${field === 'start' ? 'start-time' : 'end-time'}`;
  const control = await $(selector);
  await control.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${selector} never appeared` });
  const px = Math.round(deltaSeconds / 0.01);
  await browser.action('pointer')
    .move({ origin: control })
    .down({ button: 0 })
    .pause(100)
    .move({ origin: control, x: px, y: 0, duration: 400 })
    .pause(150)
    .up({ button: 0 })
    .perform();
};

/** Select a real pointer range on the timeline canvas, at the untouched zoom=1/pan=0 view. */
const selectTimelineRange = async (startSeconds, endSeconds, duration) => {
  const timeline = await $('.subtitle-timeline');
  await timeline.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the subtitle timeline never appeared' });
  const { width } = await timeline.getSize();
  assert.ok(width >= 100, `the subtitle timeline is too narrow to select: ${width}px`);
  // Matches createTimelineDomain's 5% end gutter (END_GUTTER_RATIO) at zoom 1 / pan 0.
  const viewEnd = duration * 1.05;
  const toOffsetPx = (seconds) => Math.round((seconds / viewEnd) * width) - Math.floor(width / 2);
  await browser.action('pointer')
    .move({ origin: timeline, x: toOffsetPx(startSeconds) + 3, y: 0 })
    .down({ button: 0 })
    .pause(100)
    .move({ origin: timeline, x: toOffsetPx(endSeconds) - 3, y: 0, duration: 450 })
    .up({ button: 0 })
    .perform();
  const actionBar = await $('.range-action-bar');
  await actionBar.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'pointer range selection did not expose the range action bar',
  });
  return { width, viewEnd };
};

/**
 * Drag the range action bar's move handle far enough right to overshoot media duration.
 *
 * The handle carries no class of its own: the bar always renders exactly three sibling buttons in
 * this fixed order (regenerate, clear, move-drag), so position is the only public way to reach it.
 */
const dragRangeMoveHandleOvershoot = async (overshootSeconds, viewEnd, width) => {
  const handle = await $('.range-action-bar button:nth-child(3)');
  await handle.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the range move handle never appeared' });
  const overshootPx = Math.ceil((overshootSeconds / viewEnd) * width);
  await browser.action('pointer')
    .move({ origin: handle })
    .down({ button: 0 })
    .pause(100)
    .move({ origin: handle, x: overshootPx, y: 0, duration: 500 })
    .pause(150)
    .up({ button: 0 })
    .perform();
};

const zoomControlText = () => browser.execute(() => (
  document.querySelector('.timeline-container > .liquid-glass')?.textContent?.trim() ?? null
));

const zoomPercent = async () => {
  const match = /^(\d+)%$/.exec((await zoomControlText()) ?? '');
  return match ? Number(match[1]) : null;
};

describe('customer advanced timeline editing', () => {
  it('drags, cascades, moves and zooms cue timing without ever exceeding real media duration', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');

    await openProjectWithMedia();
    await installBoundedErrorWitness();
    const duration = await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      return video !== null && Number.isFinite(video.duration) ? video.duration : null;
    });
    assert.ok(duration > 8.5, `the real video has no usable duration for this journey: ${duration}`);
    const durationMs = duration * 1_000;

    await importSubtitleDocument(buildSrt(IMPORTED_CUES), 'timeline-advanced-editing.srt', CUE_STICKY_FOLLOWER);
    await browser.waitUntil(async () => (
      JSON.stringify(await visibleCueTexts()) === JSON.stringify(IMPORTED_CUES.map((cue) => cue.text))
    ), { timeout: 60_000, interval: 250, timeoutMsg: 'the five-cue advanced-editing baseline never settled' });
    const baselineRecords = await waitForDurableCueRecords(
      root,
      (records) => records.length === 5,
      'the imported baseline was not durable',
    );
    const baselineState = durableState(root);
    assert.equal(baselineState.counts.projects, 1, 'editing must belong to exactly one project');
    assert.equal(baselineState.counts.media, 1, 'editing must retain exactly one media asset');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-imported-baseline',
      description: 'Five cues import for the advanced-editing story: a drag-test cue, a move-together pair and a sticky-cascade pair.',
      details: { cueCount: baselineRecords.length, duration },
      focusSelector: '.lyrics-container-wrapper',
    });

    // The editor defaults to sticky (cascade) timing. Disable it first so the two single-cue clamp
    // drags below are provably isolated, then re-enable it later for the dedicated cascade proof.
    const stickyToggle = await $('.sticky-toggle');
    await stickyToggle.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the sticky-timing toggle never appeared' });
    assert.ok((await stickyToggle.getAttribute('class')).includes('active'), 'sticky timing is not on by default');
    await clickControl('.sticky-toggle');
    await browser.waitUntil(async () => !(await stickyToggle.getAttribute('class')).includes('active'), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the sticky-timing toggle did not turn off',
    });

    // Drag cue 1's start handle hard left. The dragged field must clamp to zero, and -- with sticky
    // off -- no other cue may move: this is a single-row edit, not a cascade.
    await dragTimeControl(0, 'start', -START_CLAMP_OVERSHOOT_SECONDS);
    let records = await waitForDurableCueRecords(
      root,
      (rows) => closeTo(rows[0].start, 0),
      'dragging cue 1 start below zero did not clamp durably',
    );
    assert.ok(closeTo(records[0].start, 0, EPSILON_MS), `cue 1 start did not clamp to zero: ${records[0].start}`);
    assert.ok(closeTo(records[0].end, baselineRecords[0].end, EPSILON_MS), 'cue 1 end moved during a non-sticky start drag');
    assertUnchanged(records, [1, 2, 3, 4], baselineRecords, 'start-clamp drag');
    assert.equal(latestRevisionReason(root), REASON_TIMING_DRAG, 'the start-clamp drag left the wrong revision reason');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-start-time-clamps-to-zero',
      description: 'Dragging a cue start handle past zero clamps to zero and touches no other cue.',
      details: { cueStartMs: records[0].start, revisionReason: REASON_TIMING_DRAG },
      focusSelector: '.lyrics-container-wrapper',
    });
    const afterStartClamp = records;

    // Drag the same cue's end handle hard right. It must clamp to real media duration, never beyond.
    await dragTimeControl(0, 'end', END_CLAMP_OVERSHOOT_SECONDS);
    records = await waitForDurableCueRecords(
      root,
      (rows) => closeTo(rows[0].end, durationMs, 2_000),
      'dragging cue 1 end past media duration did not clamp durably',
    );
    assert.ok(records[0].end <= durationMs + EPSILON_MS, `cue 1 end exceeded media duration: ${records[0].end}`);
    assert.ok(closeTo(records[0].end, durationMs, EPSILON_MS), `cue 1 end did not clamp exactly to duration: ${records[0].end} vs ${durationMs}`);
    assert.ok(closeTo(records[0].start, 0, EPSILON_MS), 'cue 1 start moved during a non-sticky end drag');
    assertUnchanged(records, [1, 2, 3, 4], baselineRecords, 'end-clamp drag');
    assert.equal(latestRevisionReason(root), REASON_TIMING_DRAG, 'the end-clamp drag left the wrong revision reason');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-end-time-clamps-to-media-duration',
      description: 'Dragging a cue end handle past real media duration clamps exactly at duration, never beyond.',
      details: { cueEndMs: records[0].end, durationMs },
      focusSelector: '.lyrics-container-wrapper',
    });
    const afterEndClamp = records;

    // Re-enable sticky timing and drag cue 4's start forward. Its own duration must be preserved,
    // the later cue (5) must shift by the SAME delta, and every earlier cue must stay untouched --
    // cascade applies only to cues after the one being dragged.
    await clickControl('.sticky-toggle');
    await browser.waitUntil(async () => (await stickyToggle.getAttribute('class')).includes('active'), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the sticky-timing toggle did not turn back on',
    });
    await dragTimeControl(3, 'start', STICKY_SHIFT_SECONDS);
    records = await waitForDurableCueRecords(
      root,
      (rows) => closeTo(rows[3].start, 8_000) && closeTo(rows[4].start, 9_000),
      'sticky drag did not cascade the follower cue durably',
    );
    assert.ok(closeTo(records[3].start, 8_000, EPSILON_MS), `sticky-dragged cue start is wrong: ${records[3].start}`);
    assert.ok(closeTo(records[3].end, 8_500, EPSILON_MS), 'sticky drag did not preserve the dragged cue\'s own duration');
    assert.ok(closeTo(records[4].start, 9_000, EPSILON_MS), `cascaded follower start is wrong: ${records[4].start}`);
    assert.ok(closeTo(records[4].end, 9_500, EPSILON_MS), `cascaded follower end is wrong: ${records[4].end}`);
    assertUnchanged(records, [0, 1, 2], afterEndClamp, 'sticky cascade drag');
    assert.equal(latestRevisionReason(root), REASON_TIMING_DRAG, 'the sticky cascade left the wrong revision reason');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-sticky-cascade-shifts-only-later-cues',
      description: 'With sticky timing on, dragging one cue shifts the next cue by the same delta and leaves earlier cues alone.',
      details: { draggedCueStartMs: records[3].start, cascadedFollowerStartMs: records[4].start },
      focusSelector: '.lyrics-container-wrapper',
    });
    const afterSticky = records;

    // Select the two move-together cues as one pointer range and drag the range action bar's move
    // handle far past media end. Both cues must shift by the SAME delta, clamped so neither cue ends
    // beyond real media duration -- the multi-cue counterpart of the single-row clamp above.
    const { width, viewEnd } = await selectTimelineRange(2.7, 6.3, duration);
    await dragRangeMoveHandleOvershoot(RANGE_MOVE_OVERSHOOT_SECONDS, viewEnd, width);
    records = await waitForDurableCueRecords(
      root,
      (rows) => rows[2].end > afterSticky[2].end + 5_000,
      'the multi-cue range move never applied durably',
    );
    const deltaA = records[1].start - afterSticky[1].start;
    const deltaB = records[2].start - afterSticky[2].start;
    assert.ok(closeTo(deltaA, deltaB, EPSILON_MS), (
      `the range move applied different deltas to its two cues: ${deltaA}ms vs ${deltaB}ms`
    ));
    assert.ok(records[1].end <= durationMs + EPSILON_MS, `moved cue A exceeded media duration: ${records[1].end}`);
    assert.ok(records[2].end <= durationMs + EPSILON_MS, `moved cue B exceeded media duration: ${records[2].end}`);
    assert.ok(records[2].end >= durationMs - 1_500, (
      `the range move stopped well short of the boundary instead of clamping against it: ${records[2].end} vs ${durationMs}`
    ));
    assertUnchanged(records, [0, 3, 4], afterSticky, 'multi-cue range move');
    assert.equal(latestRevisionReason(root), REASON_MOVE_RANGE, 'the range move left the wrong revision reason');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-multi-cue-range-move-clamped-at-duration',
      description: 'Dragging the range move handle far past media end shifts both selected cues by one identical delta, clamped at real duration.',
      details: { deltaMs: deltaA, movedCueBEndMs: records[2].end, durationMs },
      focusSelector: '.lyrics-container-wrapper',
    });
    const afterRangeMove = records;

    // Undo the four durable operations above in one mixed walk -- drag, drag, sticky drag, range
    // move -- verifying SQLite reconciles at every intermediate checkpoint, not only the endpoints.
    const undoTo = async (expected, message) => {
      await waitForHistoryControl('.undo-btn', true);
      await clickControl('.undo-btn');
      await waitForDurableCueRecords(root, (rows) => (
        rows.every((row, index) => closeTo(row.start, expected[index].start)
          && closeTo(row.end, expected[index].end) && row.text === expected[index].text)
      ), message);
    };
    const redoTo = async (expected, message) => {
      await waitForHistoryControl('.redo-btn', true);
      await clickControl('.redo-btn');
      await waitForDurableCueRecords(root, (rows) => (
        rows.every((row, index) => closeTo(row.start, expected[index].start)
          && closeTo(row.end, expected[index].end) && row.text === expected[index].text)
      ), message);
    };

    await undoTo(afterSticky, 'undo did not reverse the multi-cue range move');
    await undoTo(afterEndClamp, 'undo did not reverse the sticky cascade drag');
    await undoTo(afterStartClamp, 'undo did not reverse the end-clamp drag');
    await undoTo(baselineRecords, 'undo did not reverse the start-clamp drag back to the imported baseline');
    assert.deepEqual(await visibleCueTexts(), IMPORTED_CUES.map((cue) => cue.text), (
      'the visible cue list did not match the imported baseline after the full undo walk'
    ));
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-undo-walk-reaches-imported-baseline',
      description: 'Four undos across a mixed drag/cascade/range-move sequence restore the exact imported baseline.',
      details: { undoSteps: 4 },
      focusSelector: '.lyrics-container-wrapper',
    });

    await redoTo(afterStartClamp, 'redo did not replay the start-clamp drag');
    await redoTo(afterEndClamp, 'redo did not replay the end-clamp drag');
    await redoTo(afterSticky, 'redo did not replay the sticky cascade drag');
    await redoTo(afterRangeMove, 'redo did not replay the multi-cue range move');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-redo-walk-restores-final-mixed-state',
      description: 'Four redos replay the same mixed sequence and land back on the exact final durable state.',
      details: { redoSteps: 4, finalCueCount: afterRangeMove.length },
      focusSelector: '.lyrics-container-wrapper',
    });

    // Zoom is a pure view transform layered on top of everything above: it must change the visible
    // zoom level without touching cue data, durable state or playback, and without raising an error
    // -- the RAF-driven drag loop behind it is exactly the kind of code that can silently corrupt
    // unrelated state.
    const beforeZoomPercent = await zoomPercent();
    assert.equal(beforeZoomPercent, 100, `the timeline did not start at 100% zoom: ${beforeZoomPercent}`);
    const beforeZoomVideoState = await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      return video === null ? null : { currentTime: video.currentTime, paused: video.paused };
    });
    const zoomControl = await $('.timeline-container > .liquid-glass');
    await zoomControl.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the zoom control never appeared' });
    // Reset the witness so the post-drag check names the zoom interaction specifically, rather than
    // any error already reported (and already asserted on) by an earlier step.
    await browser.execute(() => { window.__OSG_TIMELINE_ADVANCED_ERRORS__ = []; });
    await browser.action('pointer')
      .move({ origin: zoomControl })
      .down({ button: 0 })
      .pause(100)
      .move({ origin: zoomControl, x: ZOOM_DRAG_PX, y: 0, duration: 400 })
      .pause(150)
      .up({ button: 0 })
      .perform();
    await browser.waitUntil(async () => (await zoomPercent()) > 100, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'dragging the zoom control never increased the zoom percentage',
    });
    const afterZoomPercent = await zoomPercent();
    const afterZoomVideoState = await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      return video === null ? null : { currentTime: video.currentTime, paused: video.paused };
    });
    assert.deepEqual(afterZoomVideoState, beforeZoomVideoState, 'zooming the timeline moved or (un)paused playback');
    assert.deepEqual(await visibleCueTexts(), IMPORTED_CUES.map((cue) => cue.text), (
      'zooming the timeline changed the visible cue list'
    ));
    const afterZoomRecords = durableCueRecords(root);
    assert.equal(afterZoomRecords.length, afterRangeMove.length, 'zooming the timeline changed the durable cue count');
    assertUnchanged(afterZoomRecords, [0, 1, 2, 3, 4], afterRangeMove, 'zoom interaction');
    assert.deepEqual(await boundedErrors(), [], 'zooming the timeline raised a witnessed error');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-zoom-preserves-cue-and-playback-state',
      description: 'Dragging the zoom control changes zoom level alone: cues, durable state and playback stay exactly as they were.',
      details: { beforeZoomPercent, afterZoomPercent },
      focusSelector: '.timeline-container',
    });
  });
});
