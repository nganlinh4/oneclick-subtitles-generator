/* global browser, describe, it, document */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  GEMINI_SHAPE_SUBTITLE_FIXTURE,
  importSubtitleDocument,
  importSubtitles,
  openProjectWithMedia,
  waitForNativeFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-output-preview';
const PLAYHEADS = [0.8, 3.8, 6.8, 9.8, 12.8, 15.8];

const timestamp = (milliseconds) => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    + `:${String(seconds).padStart(2, '0')},${String(fraction).padStart(3, '0')}`;
};

/**
 * Replay the exact cue strings from an explicitly supplied live database without using its project,
 * media, timings, or application profile. Timings are packed into the public test video so every
 * string meets the same baker/stager path in one isolated run. Nothing is written back and no cue
 * text is printed or placed in screenshot evidence.
 */
const databaseReplay = () => {
  const path = process.env.OSG_E2E_REPRO_DATABASE;
  if (!path) return null;
  const database = new DatabaseSync(path, { readOnly: true });
  let rows;
  try {
    rows = database.prepare('SELECT ordinal, text FROM cues ORDER BY track_id, ordinal').all();
  } finally {
    database.close();
  }
  assert.ok(rows.length > 0 && rows.length <= 200, 'the diagnostic database has no bounded cue set');
  const cues = rows.map(({ text }, index) => {
    assert.equal(typeof text, 'string', `cue ${index + 1} has no text`);
    const start = 500 + index * 275;
    const end = start + 225;
    return {
      playhead: (start + end) / 2 / 1_000,
      block: `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}\n`,
    };
  });
  return {
    document: cues.map(({ block }) => block).join('\n'),
    expectedCue: rows[0].text,
    playheads: cues.map(({ playhead }) => playhead),
  };
};

const previewState = () => browser.execute(() => ({
  state: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
  frame: document.querySelector('.native-composited-frame')?.getAttribute('src') ?? null,
  refusals: [...document.querySelectorAll('.error, [role="alert"], .native-preview-unavailable')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 8),
}));

describe('a Gemini-shaped mixed-script subtitle set', () => {
  it('stages and draws every representative Korean and Latin cue', async () => {
    const replay = databaseReplay();
    await openProjectWithMedia();
    await browser.waitUntil(async () => (await previewState()).state === 'empty', {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'a cue-less project never exposed its empty preview state',
    });
    assert.equal(
      await browser.execute(() => document.querySelector('.native-preview-empty') !== null),
      false,
      'the redundant empty-project sentence was drawn inside the video surface',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-empty-video',
      description: 'A video with no cues stays unobstructed while the surface publishes an empty state.',
      details: { previewState: 'empty', redundantMessage: false },
      focusSelector: '.video-preview .video-container',
    });

    if (replay === null) await importSubtitles(GEMINI_SHAPE_SUBTITLE_FIXTURE);
    else await importSubtitleDocument(replay.document, 'private-replay.srt', replay.expectedCue);
    await waitForNativeFrame();

    const playheads = replay?.playheads ?? PLAYHEADS;
    for (const [index, seconds] of playheads.entries()) {
      if (replay !== null) console.log(`checking private replay cue ${index + 1} of ${playheads.length}`);
      const before = await previewState();
      await browser.execute((target) => {
        const video = document.querySelector('.video-preview video.video-player');
        if (video === null) throw new Error('the editor video is missing');
        video.pause();
        video.currentTime = target;
      }, seconds);
      let seen = null;
      await browser.waitUntil(async () => {
        seen = await previewState();
        return seen.state === 'ready' && seen.frame !== null && seen.frame !== before.frame;
      }, {
        timeout: replay === null ? 120_000 : 15_000,
        interval: 500,
        timeoutMsg: `cue ${index + 1} at ${seconds}s did not stage and draw`,
      });
      assert.deepEqual(seen.refusals, [], `the ${seconds}s cue exposed a preview refusal`);
    }

    if (replay === null) {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-mixed-script-preview',
        description: 'A generated-output-shaped Korean and Latin cue set stages and draws after scrubbing.',
        details: { playheads },
        focusSelector: '.video-preview .video-container',
      });
    }
  });
});
