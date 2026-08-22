// Subtitles containing Vietnamese, Korean and an emoji must draw.
//
// This owns a defect the persistence journey found by accident, so that one can prove durability
// without also being blocked by glyph coverage. Both matter; conflating them means neither is
// reported clearly.
//
// WHAT WAS OBSERVED. With the cue "Xin chào và 감사합니다 🎬" in the project, the compositor refuses
// with `previewAtlasCannotLayOut` and the recorded detail `crossesClusters=true` — shaping moved
// ink across a cluster boundary, so the per-cell advances no longer sum to the run. The emoji has
// no glyph in the managed family, so the browser shapes it from a fallback face while the atlas was
// baked from the managed one.
//
// The scenario runner invokes this journey in two independent desktop processes. That rebuilds the
// atlas from durable cues instead of merely replacing the WebDriver session on one live process.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { openEditor } from '../support/editor.js';
import {
  UNICODE_SUBTITLE_FIXTURE,
  importSubtitles,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const UNICODE_CUE = 'Xin chào và 감사합니다 🎬';
const WORKFLOW = 'unicode-cues';

const seekAndCapture = async (seconds, step, description) => {
  const previous = await browser.execute(
    () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
      ?.getAttribute('data-osg-frame-revision') ?? null,
  );
  await browser.execute((target) => {
    const video = document.querySelector('.video-preview video.video-player');
    if (video === null) throw new Error('the editor video is missing');
    video.pause();
    video.currentTime = target;
  }, seconds);
  await browser.waitUntil(async () => {
    const current = await browser.execute(
      () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
        ?.getAttribute('data-osg-frame-revision') ?? null,
    );
    return current !== null && current !== previous;
  }, {
    timeout: 120_000,
    interval: 1_000,
    timeoutMsg: `the preview did not publish the ${seconds}s stress frame`,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step,
    description,
    details: { playheadSeconds: seconds },
    focusSelector: '.video-preview .video-container',
  });
};

const visibleRefusals = () => browser.execute(() => [
  ...document.querySelectorAll('.error, [role="alert"], .native-preview-unavailable'),
].map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6));

describe('subtitles with Vietnamese, Korean and emoji', () => {
  it('draw canvas-atlas pixels, and still draw them after the project is reopened', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/unicodeCues.mjs',
    );

    if (PHASE === 'verify') {
      assert.ok(
        durableState(root).cues.some((cue) => cue.text === UNICODE_CUE),
        'the Unicode cue is absent from durable state before startup',
      );
      await openEditor();
      await browser.waitUntil(
        async () => (await browser.execute(
          (text) => (document.body?.innerText || '').includes(text), UNICODE_CUE,
        )),
        { timeout: 180_000, interval: 2_000, timeoutMsg: 'the Unicode project never restored' },
      );
      assert.deepEqual(
        await visibleRefusals(), [],
        'a new process must draw the project atlas containing Unicode cues',
      );
      await seekAndCapture(
        4,
        '06-restored-unicode',
        'A second process restores and draws the Vietnamese, Korean, and emoji cue.',
      );
      return;
    }

    await openProjectWithMedia();
    await importSubtitles(UNICODE_SUBTITLE_FIXTURE);

    await seekAndCapture(1, '01-latin-start', 'The opening Latin cue draws at a non-zero playhead.');
    await seekAndCapture(
      4,
      '02-vietnamese-korean-emoji',
      'Vietnamese diacritics, Korean syllables, and an emoji draw in one canvas frame.',
    );
    await seekAndCapture(8, '03-arabic-bidi', 'Arabic text inside brackets draws in native bidi order.');
    await seekAndCapture(11, '04-hebrew-mixed', 'Hebrew and Latin digits draw together without refusal.');
    await seekAndCapture(15, '05-end-scrub', 'The final cue draws after scrubbing near the end of the video.');

    assert.deepEqual(
      await visibleRefusals(), [],
      'no refusal may be visible for text the product claims to support',
    );
    await browser.waitUntil(
      async () => durableState(root).cues.some((cue) => cue.text === UNICODE_CUE),
      { timeout: 60_000, interval: 1_000, timeoutMsg: 'the Unicode cues never became durable' },
    );
  });
});
