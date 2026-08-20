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
// Notably it does NOT refuse immediately after import; it refuses once the atlas is rebuilt, which
// is why a relaunch surfaced it. That timing is part of the finding and is why this journey draws a
// frame first and then reopens the project.

import { strict as assert } from 'node:assert';

import { openEditor, reloadApplicationSession } from '../support/editor.js';
import {
  UNICODE_SUBTITLE_FIXTURE,
  importSubtitles,
  openProjectWithMedia,
  waitForNativeFrame,
} from '../support/workflow.js';

const visibleRefusals = () => browser.execute(() => [
  ...document.querySelectorAll('.error, [role="alert"], .native-preview-unavailable'),
].map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6));

describe('subtitles with Vietnamese, Korean and emoji', () => {
  it('draw a native frame, and still draw one after the project is reopened', async () => {
    await openProjectWithMedia();
    await importSubtitles(UNICODE_SUBTITLE_FIXTURE);
    await waitForNativeFrame();

    assert.deepEqual(
      await visibleRefusals(), [],
      'no refusal may be visible for text the product claims to support',
    );

    // Reopening is what rebuilds the atlas from stored cues, which is where the refusal appears.
    await reloadApplicationSession();
    await openEditor();

    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('video') !== null)),
      { timeout: 180_000, interval: 2_000, timeoutMsg: 'the project never restored' },
    );

    await waitForNativeFrame(120_000);
    assert.deepEqual(
      await visibleRefusals(), [],
      'a reopened project with Unicode cues must still draw its subtitles',
    );
  });
});
