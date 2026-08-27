// A customer starts from a subtitle document alone, then opens their video afterwards, and the
// track they already authored survives the attachment. The document round-trip journey owns
// media-free import and the three exports; this one owns the compound claim the ledger records as
// unproven: SRT-only work followed by media never loses or reorders the existing cues, and the
// attached media draws those exact cues natively.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { openEditor } from '../support/editor.js';
import {
  FIRST_CUE,
  importSubtitles,
  seekPreviewTo,
  selectStagedMediaFile,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'srt-only-media-attach';
const EXPECTED_CUES = Object.freeze([
  'First cue for the preview',
  'Second cue, plain text only',
  'Last cue before the end',
]);

/* global browser, describe, document, it */

const editorSurface = () => browser.execute(() => ({
  generationMode: document.querySelector('[data-osg-action="generate-subtitles"]')
    ?.getAttribute('data-generation-mode') ?? null,
  cueTexts: [...document.querySelectorAll('.lyric-item[data-lyric-index] .lyric-text')]
    .map(node => (node.innerText || '').trim()),
  videos: document.querySelectorAll('.video-preview video.video-player').length,
  playableVideo: (() => {
    const video = document.querySelector('.video-preview video.video-player');
    return video !== null && Number.isFinite(video.duration) && video.error === null;
  })(),
  errorSurfaces: [...document.querySelectorAll('[role="alert"], .error, .error-message')]
    .map(node => (node.innerText || '').trim()).filter(Boolean).slice(0, 6),
}));

describe('subtitle-only authoring followed by media', () => {
  it('preserves the authored track when the video arrives afterwards', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');

    await openEditor();
    await importSubtitles();
    let surface = await editorSurface();
    assert.equal(surface.generationMode, 'srt-only',
      'a media-free document import must enter the explicit SRT-only mode');
    assert.equal(surface.videos, 0, 'no video may exist before the customer opens one');
    assert.deepEqual(surface.cueTexts, EXPECTED_CUES,
      'the imported document is not the visible track');
    assert.deepEqual(surface.errorSurfaces, [], 'media-free import surfaced an error');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-srt-only-track',
      description: 'A subtitle document is a complete editable track before any media exists.',
      details: { cueTexts: surface.cueTexts },
    });

    await selectStagedMediaFile();
    let attached = null;
    await browser.waitUntil(async () => {
      attached = await editorSurface();
      return attached.playableVideo
        && EXPECTED_CUES.every(text => attached.cueTexts.includes(text));
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: 'attaching media did not keep the authored track alongside a playable video',
    });
    assert.deepEqual(
      attached.cueTexts.filter(text => EXPECTED_CUES.includes(text)),
      EXPECTED_CUES,
      'attaching media reordered or replaced the authored cues',
    );
    assert.deepEqual(attached.errorSurfaces, [], 'attaching media surfaced an error');

    // Durable identity: the same three cues in order, one project, one media asset.
    let durable = null;
    await browser.waitUntil(async () => {
      durable = durableState(root);
      return durable.counts.media === 1
        && durable.cues.length === EXPECTED_CUES.length;
    }, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: 'the attached project never became durable with the authored track',
    });
    assert.deepEqual(durable.cues.map(({ text }) => text), EXPECTED_CUES,
      'the durable track differs from the authored document');
    assert.equal(durable.media[0].kind, 'video');
    assert.ok(durable.jobs.every(({ state }) => state !== 'failed'),
      'attaching media left a failed job');

    // The attached media must draw the authored cue natively — the WYSIWYG proof that the track
    // and the video belong to one project rather than two coexisting states.
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();
    assert.ok((await browser.execute(
      cue => (document.body?.innerText || '').includes(cue), FIRST_CUE,
    )), 'the first authored cue is no longer readable after media attachment');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-attached-media-draws-track',
      description: 'The later-attached video draws the pre-authored cue in the native preview.',
      details: { cueTexts: attached.cueTexts },
      focusSelector: '.video-preview .video-container',
    });
  });
});
